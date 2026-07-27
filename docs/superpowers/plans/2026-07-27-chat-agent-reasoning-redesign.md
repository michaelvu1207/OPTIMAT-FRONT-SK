# Chat Agent Redesign: From Form Validator to Reasoning Assistant

> **Status:** Plan only. No behavior changed. Supersedes the agent-behavior portions of
> `2026-07-13-chat-reliability-trip-search-correctness.md`, whose reliability fixes have shipped.

**Goal:** Make the assistant reason about a rider's trip instead of validating a form. It should
explain *why* a trip can't be served, search adjacent possibilities before giving up, ask the
question that actually changes the answer, and speak in its own words grounded in server facts.

---

## The diagnosis

The assistant feels hard-coded because, structurally, it is. Four findings, in order of impact.

### 1. It runs on the cheapest model, with no reasoning budget

`supabase/functions/chat/index.ts:158` pins `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
`inferenceConfig` sets `maxTokens: 1500` and nothing else — no `effort`, no thinking configuration.

Haiku 4.5 is the entry tier. The work being asked of it is not entry-tier: read AND/OR eligibility
prose, hold a multi-constraint trip state across turns, decide which of six tools to call, and
explain a negative result to a rider who may be anxious about getting to dialysis. Low insight is
the expected outcome of this pairing, and no amount of prompt tuning fixes a capability ceiling.

### 2. The agent is amnesiac between turns

Every request rebuilds history from the `messages` table (`index.ts:257-274`), which stores only
`role` + `content` text. Tool results live in `currentMessages` **inside** the tool loop
(`index.ts:402-412`) and are discarded when the request ends. Rows with `role: "system"` are
explicitly filtered out.

So on turn N+1 the model cannot see: the resolved travel date, which providers matched, why others
were excluded, the diagnostics, the canonical geocoded addresses — anything a tool returned. Its
only memory is its own prose from the previous turn.

That single fact explains most of what feels wrong. It re-asks questions. It can't compare this
search to the last one. It can't say "the same four providers as before, but now Tuesday works." It
has no material to be insightful *with*.

### 3. Its own words get overwritten, then patched

`index.ts:419-429`:

```ts
const deterministicResponse =
  buildCoverageResponse(coverage) ||
  (providerSearch ? buildNoProviderResponse(providerSearch) : null) || ...
if (deterministicResponse) finalResponse = deterministicResponse;
finalResponse = ensurePublicTransitProviderSummary(finalResponse, providerSearch);
finalResponse = ensureVerificationSummary(finalResponse, providerSearch);
```

`buildNoProviderResponse` returns non-null on **every** zero-result search, so the model's entire
explanation is thrown away and replaced with a template. Then two more functions prepend and append
sentences to whatever survives.

Combined with finding #2, this is worse than it looks: the template becomes the model's *memory* of
the turn. It gets graded next turn on words it didn't write.

Live evidence from a real conversation on 2026-07-27 — one message, two contradictory counts:

> "I found 3 transportation provider options, including Public Transit." *(prepended by
> `ensurePublicTransitProviderSummary`)*
> "Perfect! I found **2 eligible** transportation providers…" *(the model)*

The patches also can't be right in general: they don't know what the model already said, so they
either duplicate it or contradict it.

### 4. The tool schema, not the prompt, drives the conversation

`find_providers` requires seven fields up front. Each missing one returns a canned
`clarification_required` string (`tools.ts`): `trip_type_missing`, `return_time_missing`,
`travel_date_invalid`, `departure_time_invalid`, `rider_age_missing`. The order of questions is
whatever order the validator happens to reject in, and each rejection is a fixed sentence.

That is a form validator wearing a chat interface. (The `rider_age_missing` gate shipped on
2026-07-27 and fixes a real bug — it is the same pattern, which is why the redesign below keeps the
determinism and moves the *wording* and *ordering* back to the model.)

### Two supporting problems

**The search is all-or-nothing.** `executeFindProviders` runs geography → schedule → eligibility
once and reports counts. There is no relaxation pass, no partial-coverage check, no nearby
alternative. So "no providers" can only ever be explained as "which stage hit zero" — never as
"nothing on Sunday, but three providers Monday through Friday."

**The prompt duplicates the server.** 3.3 KB, ~820 tokens, 17 imperative bullets — many restating
rules the server already enforces deterministically (server resolves dates, server rejects
incomplete calls, server filters hours). Duplicated where enforced, and unenforced where it
matters: the live conversation ended with "are you ready to book?" despite the prompt's "OPTIMAT
does not book rides."

---

## Model recommendation

| | Current | Recommended |
|---|---|---|
| Model | Haiku 4.5 | **Opus 5** (`effort: "medium"`), Sonnet 5 if latency forces it |
| maxTokens | 1500 | 8000+ (see the truncation note below) |
| Reasoning | none | adaptive thinking, `effort` tuned per route |

Cost per MTok (first-party rates; **Bedrock is partner-priced — verify**): Haiku 4.5 $1/$5,
Sonnet 5 $3/$15 ($2/$10 introductory through 2026-08-31), Opus 5 $5/$25. At Mobility Matters'
volume — a staffer taking rider calls, a few dozen turns a day — the absolute difference is cents
per conversation. Judge on whether the answers are good enough to put in front of a rider.

Three integration details that will bite:

1. **`maxTokens: 1500` will truncate.** On Opus 5 thinking is on by default and `max_tokens` caps
   thinking *plus* response text together. The live reply above was already ~700 tokens of visible
   text; add thinking and 1500 truncates mid-answer.
2. **Verify the exact Bedrock ID.** This code uses the legacy Bedrock Runtime `ConverseCommand`
   with region-prefixed inference profiles (`us.anthropic.…-v1:0`), not the newer Mantle client
   (`anthropic.claude-opus-5`). The profile ID must be confirmed against
   `aws bedrock list-inference-profiles --region us-east-2` before deploying — do not guess it.
3. **Confirm `effort` and thinking pass through Converse.** On this API they go in
   `additionalModelRequestFields`, not `inferenceConfig`. Verify with one live call before building
   on it.

Make the model ID and effort environment variables so this is switchable without a deploy.

---

## Target design

### A. Durable trip state the model can see

Persist a compact per-conversation state record and inject it into every request as a facts block:
resolved trip fields, the canonical addresses, the last search's diagnostics, the eligible /
verification / excluded provider names with reasons, and what is still unknown.

Compact digest over raw tool-result replay: it costs a few hundred tokens instead of re-sending
6 KB of provider payload each turn, and it gives the model a stable factual anchor rather than a
transcript to re-derive state from.

### B. Ground the model instead of overwriting it

Delete the replacement path. Keep every deterministic *fact*, and pass those facts to the model as
the only thing it is allowed to speak from. Then verify rather than patch: if the response
contradicts the facts — a count that doesn't match, a provider name that isn't in the result set, a
claim that booking happened — re-prompt once with the specific discrepancy named, and fall back to
a template only if the retry also fails.

This keeps the safety property (no invented providers, dates, or counts) without flattening the
voice, and it removes the duplicate/contradictory-sentence class of bug entirely.

### C. Relaxation search: explain, then offer alternatives

When a search returns zero or thin results, re-run it server-side with one constraint relaxed at a
time and report which single change unlocks what:

- date → same time on other operating days, and ±3 days
- time → ±2 hours, and the provider's actual operating window
- trip type → one-way when the round trip is what failed
- eligibility → which category would qualify, without asserting the rider has it
- geography → providers covering origin **only** or destination **only** (today these are
  invisible; they are what makes a two-leg or transfer suggestion possible)

Return it structurally:

```ts
type Alternative = {
  change: 'date' | 'time' | 'trip_type' | 'eligibility' | 'partial_coverage';
  description: string;      // "Monday through Friday" — never a fabricated promise
  providers: string[];
  count: number;
};
```

This is what turns "I couldn't find any providers" into "nothing serves this trip on a Sunday —
three providers cover it Monday through Friday, and BART plus a short walk works today."

### D. Ask the question that changes the answer

Have the server compute, from the current candidate set, which unknown field would most change the
outcome, and return it as a hint the model phrases in its own words:

```ts
type NextQuestion = {
  field: 'age' | 'residence_city' | 'disability' | 'ada_certified' | 'veteran' | 'date' | 'time';
  why: string;
  candidates_if_known: number;   // how many providers this could unlock
};
```

For a San Ramon → San Ramon trip, age is decisive and ADA certification is nearly irrelevant. The
agent currently cannot tell the difference; it asks in schema order. Highest-information-first also
means fewer questions per conversation, which is the thing staff will feel on a live call.

Paired with this: let `find_providers` run with unknowns instead of hard-failing, returning
`eligible` / `conditional_on: [field]` / `excluded` buckets. Search first, ask second — the rider
sees progress before an interrogation.

### E. A shorter, non-duplicative prompt

Target ~300 tokens, down from ~820. Keep only:

- role and service geography
- the invariants the server *cannot* enforce: no booking claims, no invented facts, no PII
  collection
- how to read the facts block and the alternatives/next-question hints
- tone and length

Move enforced mechanics into tool descriptions, where they belong and where they can't drift from
the validator. Prescriptive "call this when…" tool descriptions also measurably improve
tool-triggering on current models.

### F. An eval harness, or none of this is measurable

`tests/chat/` already has replay scripts. Turn them into a scored eval over ~10 scripted
conversations, asserting properties rather than exact strings:

- asked for age at most once, and only when a senior rule was in play
- no contradictory counts in a single message
- named the binding constraint on zero results
- offered ≥1 alternative when zero results
- never claimed a booking was made or requested
- questions asked ≤ questions needed (information-value check)

Run it against Haiku 4.5 and the candidate model. That is how the model upgrade gets justified with
data instead of vibes.

---

## Tasks

### Task 1: Model upgrade behind config (P0, small)

**Files:** `supabase/functions/chat/index.ts`

- [ ] Read model ID and effort from env (`CHAT_MODEL_ID`, `CHAT_EFFORT`) with current values as
      defaults, so rollback is a secret change and not a deploy.
- [ ] Confirm the Bedrock inference-profile ID for the target model in `us-east-2`.
- [ ] Raise `maxTokens` to at least 8000; confirm thinking + text fit.
- [ ] Verify `effort` / thinking pass through `ConverseCommand` via
      `additionalModelRequestFields`; if they don't, decide between the Mantle client and running
      without an effort hint.
- [ ] Record per-turn latency and token usage before and after on the same scripted conversation.

**Acceptance:** the same three-turn San Ramon conversation runs end to end on the new model, no
truncation, p95 turn latency recorded and acceptable to staff on a live call.

### Task 2: Durable trip state and facts block (P0)

**Files:** `supabase/functions/chat/state.ts` (new), `index.ts`, migration

- [ ] Add a `chat_trip_state` table (or reuse `conversation_states` if its shape fits) keyed by
      conversation, holding the digest in §A.
- [ ] Update it from tool results at the end of each turn.
- [ ] Inject it as a facts block in the system context on every request.
- [ ] A new origin/destination pair supersedes the prior trip rather than merging into it.

**Acceptance:** turn 2 of a conversation can name the resolved date, the provider names, and one
exclusion reason from turn 1 without re-running any tool. Asking "why not Mobility Matters?" after
a search answers from state.

### Task 3: Stop overwriting; verify instead (P0)

**Files:** `responses.ts`, `index.ts`, `responses.test.ts`

- [ ] Delete the deterministic replacement path and the prepend/append patches.
- [ ] Add a fact-consistency check: counts match, every named provider exists in the result set,
      no booking claim.
- [ ] On failure, re-prompt once naming the discrepancy; template only as the final fallback.
- [ ] Keep the templates as the fallback, not the default path.

**Acceptance:** no response contains two different provider counts. A response naming a provider
absent from the result set never reaches the user. The zero-result regression fixtures still pass.

### Task 4: Relaxation search and partial coverage (P1)

**Files:** `tools.ts`, `trip.ts`, new tests

- [ ] Add the relaxation passes in §C, bounded and run only on zero/thin results.
- [ ] Add origin-only / destination-only coverage detection.
- [ ] Return `alternatives[]`; keep the payload under the existing size ceiling.
- [ ] Extend the prompt minimally so alternatives are offered, never asserted as bookable.

**Acceptance:** a Sunday-only failure reports the operating days that work. A DVC → San Francisco
search reports which end each provider covers. Every alternative names a real provider from data.

### Task 5: Information-value questioning (P1)

**Files:** `tools.ts`, `trip.ts`, `index.ts`

- [ ] Let `find_providers` accept unknowns and return `eligible` / `conditional_on` / `excluded`.
- [ ] Compute and return `next_question`.
- [ ] Replace the fixed clarification sentences with the model phrasing the hint; keep the
      `reason_code` for the UI progress card.

**Acceptance:** a San Ramon → San Ramon trip asks age first. A trip where every candidate is
ADA-only never asks about senior status. Questions per completed search drops on the eval set.

### Task 6: Prompt simplification and eval harness (P1)

**Files:** `index.ts`, `tests/chat/`

- [ ] Rewrite the prompt per §E; move enforced rules into tool descriptions.
- [ ] Build the scored eval in §F; run it across models and record the table.
- [ ] Add the booking-claim assertion — this is currently violated in production.

**Acceptance:** prompt under ~350 tokens, eval passes on the chosen model, and the model choice is
backed by the score table.

---

## Sequencing

1. **Task 1** alone is worth shipping first: it is a few lines, reversible via env, and will show
   how much of the "low insight" is capability versus architecture. Measure before building more.
2. **Tasks 2 and 3** together — memory and voice are the same problem, and fixing #3 without #2
   just means the model remembers its own better-written prose.
3. **Tasks 4 and 5** are the actual product asks (explain why, find alternatives, ask well). They
   depend on state existing.
4. **Task 6** runs alongside everything and gates the model decision.

Do not do Task 4 before Task 3: adding richer diagnostics while a template still discards the
model's explanation means building an input nothing reads.

---

## Decisions to confirm

1. **Model and effort.** Opus 5 at `effort: "medium"`, or Sonnet 5 for latency? Staff are on live
   phone calls — what turn latency is tolerable?
2. **Alternatives wording.** May the assistant say "Monday through Friday would work" when it has
   only checked the operating-day rule, or must every alternative be a completed search?
3. **Conditional providers.** When eligibility is unknown, show `conditional_on` candidates
   immediately, or hold them until the rider answers? (Current behavior after 2026-07-27: shown as
   "needs verification".)
4. **Prompt hosting.** Once the prompt is ~300 tokens, is the portal-table idea worth revisiting,
   or does the Google Doc plus a deploy stay the workflow?
5. **State retention.** How long should `chat_trip_state` keep raw addresses, given it holds rider
   trip details?
