# Chat Redesign — Execution Plan

> **Diagnosis and rationale:** `2026-07-27-chat-agent-reasoning-redesign.md`. That document is
> the *why*. This one is the *how*: ordered milestones, the concrete steps in each, and the exit
> criterion that says it is finished.

**One-line goal:** the assistant reasons about a rider's trip instead of validating a form —
explains why something can't work, searches adjacent options before giving up, asks the question
that changes the answer, and speaks in its own words.

---

## Milestone map

| # | Milestone | Size | Unblocks | Status |
|---|---|---|---|---|
| M0 | Opus 5 at medium effort | — | everything | **done 2026-07-27** |
| M1 | Measurement baseline | ½ session | proof for M2–M6 | next |
| M2 | Memory: durable trip state | 1 session | M3, M4, M5 | |
| M3 | Voice: stop overwriting the model | ½ session | M4 | |
| M4 | Explanation: relaxation search + alternatives | 1–2 sessions | | |
| M5 | Questioning: information-value ordering | 1 session | | |
| M6 | Prompt slim + cleanup | ½ session | | |

**Hard ordering constraints.** M2 before M4 and M5 (both need state to exist). M3 before M4 —
adding richer diagnostics while a template still discards the model's explanation means building an
input that nothing reads. M1 first, or every later claim is a vibe.

Each milestone ships to production independently and is reversible on its own.

---

## M0 — Opus 5 at medium effort ✅

Shipped `3a0f28f` and `12ade87`. Model `us.anthropic.claude-opus-5` (verified ACTIVE in
`us-west-1`), `effort: medium`, `maxTokens: 8000`, all three secret-overridable.

Two findings to carry forward:

- The pinned AWS SDK (`3.693.0`) cannot deserialize Opus 5's `reasoningContent` block; it arrives
  as `{"$unknown": [...]}` and Bedrock rejects the turn when echoed back. It is stripped in
  `sanitizeAssistantContent`. **Do not "fix" this by upgrading the SDK casually** — `3.1095.0`
  fails at import in the edge runtime, and remapping the block crashes the old serializer.
- Turn latency is tool-bound, not model-bound: 17s at both medium and high effort. If turn time
  becomes the complaint, the lever is parallelising geocoding and the Directions call, not `effort`.

---

## M1 — Measurement baseline

**Why first:** the complaint ("questions too rigid, insight too low") is qualitative. Without a
score, M2–M6 can't be shown to have worked, and the model spend can't be justified.

### Steps

1. **`tests/chat/scenarios.json`** — 10 scripted conversations, each a list of user turns:
   1. senior with exact age (happy path)
   2. senior who won't give an age
   3. rider who declines all eligibility questions
   4. zero coverage: DVC → San Francisco
   5. closed-hours request (Sunday, or 5am)
   6. ambiguous place: "DVC in Antioch"
   7. Richmond multi-provider search (payload size)
   8. one-way where the rider is asked for a return time
   9. follow-up about a provider from a previous turn ("why not Mobility Matters?")
   10. off-trip question ("does BART have wheelchair access?")
2. **`tests/chat/eval.mjs`** — runs each scenario against a target deployment (URL + anon key as
   args, so it can run against a preview or production), recording per turn: latency, token usage
   where available, the response text, and the attachments.
3. **Assertions** — properties, not exact strings:
   - no two different provider counts in one message
   - age asked at most once, and only when a matching provider has a senior rule
   - on zero results, the binding constraint is named (geography vs schedule vs eligibility)
   - on zero results, at least one alternative or fallback is offered
   - no booking claim (`/I'?ll book|I have scheduled|ready to book|I'?ve arranged/i`)
   - every provider named in prose exists in the attachment data
   - no `<thinking>` or internal XML in the response
4. **`tests/chat/baseline-2026-07-27.json`** — commit the current scores. Expect failures; assertion
   #1 and the booking-claim assertion are known to fail today.

### Exit criterion

`node tests/chat/eval.mjs <url> <key>` prints a pass/fail table across 10 scenarios, and the
baseline file is committed. Failures are expected and recorded, not fixed here.

---

## M2 — Memory: durable trip state

**Problem being fixed:** tool results never survive the turn (`index.ts` rebuilds history from the
`messages` table, which stores only role + text). The model cannot see the resolved date, which
providers matched, or why any were excluded.

### Steps

1. **Migration** `supabase/migrations/<ts>_chat_trip_state.sql` — table `optimat.chat_trip_state`:
   `conversation_id uuid primary key references conversations(id) on delete cascade`,
   `trip jsonb`, `last_search jsonb`, `updated_at timestamptz default now()`.
   Mirror into `scripts/ddl/tables.sql`.
2. **`supabase/functions/chat/state.ts`** — three pure-ish functions:
   - `loadTripState(supabase, conversationId)`
   - `updateTripStateFromTools(state, attachments)` — folds this turn's tool results in
   - `buildFactsBlock(state)` — renders the compact text block injected into the system context:
     resolved trip fields, canonical addresses, last search's counts, eligible / verification /
     excluded provider names with reasons, and what is still unknown
3. **Wire into `index.ts`** — load before the tool loop, inject the facts block alongside the
   service clock, save after the loop.
4. **Supersede rule** — a new origin/destination pair clears the prior trip fields rather than
   merging, so an unrelated second trip in one conversation can't inherit stale times.
5. **Retention** — store canonical addresses only, not raw rider phrasing, and add a scheduled
   delete for rows older than 30 days.
6. **Tests** — `state.test.ts` for the fold and the supersede rule.

### Exit criterion

Scenario 9 (follow-up about a previous provider) answers correctly **without re-running**
`find_providers` — verifiable from the attachment list being empty on that turn. Eval scenario 9
passes.

---

## M3 — Voice: stop overwriting the model

**Problem being fixed:** `index.ts:419-429` discards the model's entire message on every
zero-result search and substitutes a template, then two more functions prepend and append
sentences. Today's live turn still opens with a bolted-on "I found 3 transportation provider
options" ahead of the model's own summary.

### Steps

1. **Convert the formatters into fact producers.** `buildNoProviderResponse`,
   `buildCoverageResponse`, `buildDateResolutionResponse` stop returning prose to send and start
   returning structured facts for `buildFactsBlock` (M2).
2. **Delete the patchers** — `ensurePublicTransitProviderSummary` and `ensureVerificationSummary`
   prepend/append calls come out.
3. **Add `verifyResponse(response, facts)`** in `responses.ts`, checking: provider counts match the
   facts, every named provider exists, no booking claim, verification-required providers are
   mentioned when present.
4. **On verification failure, re-prompt once** naming the specific discrepancy, then fall back to
   the existing template only if the retry also fails. Log which path was taken.
5. **Rewrite `responses.test.ts`** around `verifyResponse` rather than exact template strings.

### Exit criterion

The "I found N transportation provider options" prepend no longer appears. Eval assertions for
duplicate counts, provider-name grounding, and booking claims all pass. Zero-result scenarios (4,
5) still name the binding constraint — now in the model's words.

---

## M4 — Explanation: relaxation search + alternatives

**Problem being fixed:** one all-or-nothing filter pass. "No providers" can only be explained as
which stage hit zero, never as what would work instead.

### Steps

1. **Refactor** `executeFindProviders` in `tools.ts` so the filter pipeline is a reusable
   `searchProviders(params)` returning the staged result, with the tool wrapper on top.
2. **Add `relaxSearch(params)`** — runs bounded variants only when the primary result is zero or
   thin (≤1 eligible):
   - each other operating day at the same time
   - ±2 hours on the requested day
   - one-way when the round trip was what failed
   - each eligibility category individually (reported as "if you were X", never asserted)
   - partial coverage: providers covering origin only, or destination only
3. **Return `alternatives[]`** — `{change, description, providers[], count}`. Cap the count and keep
   the serialized result under the existing size ceiling.
4. **Feed alternatives into the facts block** so the model states them in its own words.
5. **Frontend** — render alternatives as a distinct section in `ChatView.svelte`, next to the
   existing "needs verification" section.
6. **Tests** — a Sunday-only fixture, a partial-coverage fixture (DVC → SF), and a payload-size
   assertion.

### Exit criterion

Scenario 4 (DVC → SF) reports which end each provider covers. Scenario 5 (closed hours) names the
operating days that would work. Every alternative names a provider that exists in the data. Eval
alternative assertion passes.

---

## M5 — Questioning: information-value ordering

**Problem being fixed:** seven required fields, five canned rejection sentences. Question order is
whatever order the validator rejects in.

### Steps

1. **Let `find_providers` run with unknowns** — instead of returning `clarification_required` for
   missing eligibility, return three buckets: `eligible`, `conditional_on: [field]`, `excluded`.
   Keep the hard gates only for date and outbound time, which the search genuinely cannot run
   without.
2. **Add `nextQuestion(candidates, known)`** in `trip.ts` — returns the unknown field that most
   changes the candidate set, with `why` and `candidates_if_known`.
3. **Return it as a hint** the model phrases itself; keep `reason_code` in the payload so the
   frontend progress card still works.
4. **Delete the canned clarification sentences** for eligibility fields (date/time keep theirs).
5. **Tests** — assert age is chosen first for a San Ramon → San Ramon trip, and that an ADA-only
   candidate set never asks about senior status.

### Exit criterion

Average questions-per-completed-search drops against the M1 baseline. Scenario 2 asks for age;
scenario 3 (rider declines) still returns results with verification-required candidates rather than
stalling.

---

## M6 — Prompt slim + cleanup

### Steps

1. **Rewrite `SYSTEM_PROMPT`** to ~300 tokens: role, service geography, the invariants the server
   cannot enforce (no booking claims, no invented facts, no PII collection), how to read the facts
   block and alternatives, and tone. Drop every rule the server already enforces.
2. **Move enforced mechanics into tool descriptions**, where they cannot drift from the validator.
3. **Refresh `tests/snapshots/`** — the checked-in snapshot is from March, still contains the old
   structured `eligibility_reqs` shape, and actively misleads analysis. Regenerate or delete.
4. **Delete dead code** — the template-only paths superseded by M3, and any unused formatter.
5. **Decide the Aurora/Lambda question** — `infra/lambda/chat/` has diverged and is unreferenced by
   the deployed frontend. Either sync it or delete it; do not leave two chat implementations.

### Exit criterion

Prompt under ~350 tokens (measured, not estimated). Full eval green. No stale snapshot. One chat
implementation.

---

## Decisions I have made (say so if you disagree)

1. **Effort stays `medium`.** Measured identical latency and quality against `high`. Revisit only
   if eval scores differ.
2. **Alternatives may be stated from a rule check**, phrased as possibility ("providers serve this
   Monday–Friday"), never as a booked promise. Requiring a full search per alternative would make
   M4 too slow to ship.
3. **Conditional providers are shown immediately**, labelled as needing verification — matching the
   behaviour shipped on 2026-07-27 rather than hiding them until the rider answers.
4. **Compact state digest, not full tool-result replay.** Hundreds of tokens instead of ~6 KB of
   provider payload per turn, and it gives the model a stable anchor rather than a transcript.
5. **Google Doc stays the prompt-feedback channel** until M6 gets the prompt under ~300 tokens.
   Revisit portal hosting after that, when editing it is low-risk.

## Not doing

- Streaming / SSE. The 2026-07-13 plan proposed it; the current single-request lifecycle works and
  17s turns don't justify the rework yet. Revisit if turn latency becomes the complaint.
- Real booking integration. Handoff only.
- Rewriting the eligibility evaluator. It is correct against live data as of 2026-07-27.

## Risks

| Risk | Mitigation |
|---|---|
| Opus 5 verbosity creeps back as prompt rules are removed in M6 | eval asserts response length; the rider-facing writing rules stay |
| Relaxation search inflates the model payload past the ceiling | cap alternatives, assert serialized size in tests |
| Facts block grows until it crowds the conversation | cap it; it is a digest, and M1 latency numbers will show regression |
| Removing the template safety net (M3) lets a bad response through | `verifyResponse` + one re-prompt + template fallback, in that order |
| SDK `$unknown` handling breaks on a future model change | `sanitizeAssistantContent` is defensive by shape, not by model |
