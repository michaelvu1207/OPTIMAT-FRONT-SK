# Chat Reliability and Trip-Search Correctness Implementation Plan

> **Status:** Planning only. No production behavior or data has been changed.

**Goal:** Make chat trip planning deterministic and interruptible: dates resolve from the real service timezone, one-way trips work without fake data, only eligible providers are recommended, location mistakes are caught before search, zero-result explanations identify the first failed constraint, Richmond-size searches complete reliably, and contact details render as actionable links.

**Active architecture:** The checked-in frontend is configured for Supabase (`VITE_API_BACKEND=supabase`). The active path is `src/components/Chat.svelte` -> `src/lib/api.ts` -> `supabase/functions/chat/`. A parallel AWS/Aurora implementation exists under `infra/lambda/chat/`; it must receive the same domain changes or be explicitly retired to prevent behavior drift.

**Product timezone assumption:** Interpret trip dates in `America/Los_Angeles` unless deployment configuration says otherwise. Do not use a model's implicit clock or UTC date for user-facing relative dates.

---

## Evidence from the July 9 chat records

The reports map to four conversations in the `optimat` schema:

| Conversation | Relevant evidence | Finding |
|---|---|---|
| `a8b13038-f96c-497c-a3f5-05ec24b5cc1a` | At 21:20 UTC, “tomorrow” was answered as July 20 even though the turn occurred July 9. | The model reused an earlier requested date because the system prompt contains no current date/time and no deterministic relative-date resolver. |
| `6f4c2981-4812-4e8c-be8d-389e7c638583` | The one-way DVC -> San Francisco trip required an invented 11 PM return. Two searches returned zero providers. Richmond searches then logged successful tool results repeatedly but did not persist assistant messages. | `return_time` is required by both prompt and tool schema. The zero-result formatter does not distinguish geography from time. Richmond tool results were about 478,771 characters because provider `service_area_geojson` was included in the model payload; this is the leading explanation for the post-tool failure and must be confirmed with stage/error instrumentation. |
| `8d6a7a83-b0ec-4653-b676-a25416fcfe12` | A general resident received One-Seat Regional Ride and Mobility Matters, an invented December 20 date, and a request for personal booking details. The provider tool had already geocoded “DVC, Antioch” to DVC in Pleasant Hill. | Eligibility is not hard-filtered, travel date is optional, the assistant can ignore canonical geocoding, and the chat incorrectly implies it can complete a booking. |
| `0bca3f58-84a1-4fb6-935a-28069b41e836` | Richmond was clarified as California; July 21 was interpreted as 2025; after the user supplied 2026, the provider tool completed but no assistant response was persisted. | Bay Area context is not enforced. The date issue and the large Richmond result payload are separate defects that combined in this turn. |

Additional database observations:

- The Richmond provider search completed in roughly 6–8 seconds each time and found four providers; the failure happened after tool execution. The roughly 479 KB Bedrock handoff strongly implicates payload/token processing, but current logs cannot distinguish a Bedrock limit, edge-runtime limit, or client-abandoned request.
- The Richmond result contained approximately 319 KB of East Bay Paratransit GeoJSON, 82 KB of Mobility Matters GeoJSON, and 67 KB of AC Transit GeoJSON. None of that geometry is needed by the model.
- The San Francisco searches had `total_found = 0` and `filtered_out_count = 0`. This means no provider matched both service areas; service hours were not the reason. The current response nevertheless mentions both geography and service-hour filtering.
- The Bay Point/DVC tool correctly canonicalized the destination to `321 Golf Club Rd, Pleasant Hill`, but the assistant still described it as DVC in Antioch until a later public-transit turn.
- The Bay Point/DVC search returned One-Seat Regional Ride (`Disabled (18+)`) and Mobility Matters (`Senior (60+) or veteran` plus Contra Costa residency) even though the user said they were a general resident.
- Provider phone numbers are stored under `booking.details`, while the results UI only links `provider.phone`. Emails are stored in `contacts`. This is why structured contact data often appears only as plain text.
- The frontend fires `sendChatMessage`, ignores its returned error/data, and then polls the conversation for up to 90 seconds. The actual POST has a 20-second abort timer. This split lifecycle hides the real failure and allows repeated, overlapping requests.
- The generic `tool_calls` table is in checked-in DDL but absent from the deployed schema cache. The specialized provider-call log omits date, times, trip type, eligibility input, duration, and terminal status, limiting post-incident diagnosis.
- Public-transit routing calls do not receive the requested date or time. Recorded route times therefore reflect the Directions API default time, even when the assistant states that they match noon or an arrive-by request.

---

## Root-cause matrix

| Reported issue | Primary cause | Required fix |
|---|---|---|
| Composer loses focus after every reply | The textarea is disabled during loading and never explicitly refocused. | Bind the textarea element and restore focus after a completed/error/cancelled turn when the user has not intentionally focused another control. |
| “Tomorrow” is ten days wrong; wrong year examples | No server-supplied clock; dates are free-form model output; `travel_date` is optional. | Add a deterministic date normalizer and make a normalized ISO date mandatory before a provider/time-sensitive transit search. |
| One-way trip requires a fake return | `return_time` is required in the system prompt, TypeScript interface, and JSON schema. | Add `trip_type`; make `return_time` nullable and validate it only for round trips. |
| Zero results give generic, fixable-sounding possibilities | The tool returns only final counts, and `buildNoProviderResponse` conflates service area and hours. | Return per-stage counts/exclusions and report the first definitive failure. |
| No date is requested | Date is listed only in the broad booking prompt and optional in the tool. | Treat date as a required trip-search field; server rejects incomplete calls and returns a structured clarification request. |
| Ineligible providers are shown/recommended | Search intentionally leaves eligibility to model reasoning. | Pass structured rider eligibility and enforce deterministic eligibility status before recommendation/UI display. |
| Assistant asks for booking details instead of handing off | Prompt says “When booking a trip, gather…” although the app has no booking integration. | Replace pseudo-booking with a provider handoff flow and avoid collecting unnecessary PII. |
| DVC in Antioch is not corrected immediately | Places result is canonical, but no mismatch gate prevents the model from retaining the user's label. | Use one canonical resolver and require confirmation/correction when requested and resolved cities conflict. |
| Richmond requests hang and site becomes stuck | Large GeoJSON is returned to Bedrock and is the leading post-tool failure trigger; the client POST/polling split then hides the terminal error and cannot be cancelled cleanly. | Add stage instrumentation to confirm the failing limit, strip geometry before model handoff, use one request lifecycle, add cancel/idempotency, and unlock the UI immediately on cancel/error. |
| Richmond, CA requires state clarification | Search/web tools have no configured service geography or Bay Area bias. | Configure supported geography and bias ambiguous places to the Bay Area unless the user explicitly specifies another region. |
| Contact details are plain text | Chat prose does not consistently emit Markdown links; structured cards look for the wrong phone field. | Normalize structured contacts and render `tel:`, `mailto:`, and HTTPS anchors. |

---

## Target design

### 1. A typed trip request, not prose-only state

Introduce a shared `TripRequest` contract used by the model tool schema, server validation, search code, UI attachments, and tests:

```ts
type TripRequest = {
  id: string;
  conversationId: string;
  tripType: 'one_way' | 'round_trip';
  origin: ResolvedPlace | null;
  destination: ResolvedPlace | null;
  travelDateRaw: string | null; // user's verbatim phrase, e.g. "tomorrow"
  travelDate: string | null; // server-resolved YYYY-MM-DD in service timezone
  outboundTime: string | null; // HH:mm
  outboundTimeIntent: 'depart_at' | 'arrive_by';
  returnTime: string | null; // required only for round_trip
  eligibility: {
    age: number | null;
    disabled: boolean | null;
    adaCertified: boolean | null;
    veteran: boolean | null;
    residenceCity: string | null;
    declined: boolean;
  };
};
```

Persist the active trip request separately from replay-only `conversation_states`. A dedicated `trip_requests` table is preferred because the July 9 history contains several unrelated trips in one conversation. A new origin/destination intent should close or supersede the prior active trip instead of contaminating the next request.

The model may extract fields, but server code owns normalization and validation. The tool must submit the user's verbatim date phrase, not a model-computed ISO date; the server resolves it against the service-timezone clock. Invalid, past, or incomplete tool calls return a machine-readable `clarification_required` result; they must never silently invent a date, year, eligibility fact, or return time.

### 2. Staged search with explicit diagnostics

Search in this order:

1. Resolve/canonicalize both places and surface any city mismatch.
2. Preflight provider geography using origin and destination only.
3. If geography has no match, stop provider filtering and explain the coverage failure immediately; offer public transit if available.
4. Validate required date and applicable times.
5. Filter operating day/hours.
6. Evaluate eligibility.
7. Rank only eligible matches; keep uncertain/ineligible providers in an explanation-only exclusion list.

Return diagnostics such as:

```ts
type SearchDiagnostics = {
  providerCount: number;
  geographyMatchCount: number;
  scheduleMatchCount: number;
  eligibleMatchCount: number;
  exclusions: Array<{
    providerId: number;
    providerName: string;
    stage: 'geography' | 'service_day' | 'service_hours' | 'eligibility';
    reason: string;
  }>;
};
```

The response formatter should use these diagnostics instead of asking the model to infer why results are empty.

### 3. One controllable chat request lifecycle

Replace fire-and-forget POST plus database polling with one SSE stream keyed by `request_id`. The active Supabase chat function should send an accepted/status event immediately, tool-stage events, heartbeats while external calls are pending, and exactly one completed/failed/cancelled terminal event. Remove the 20-second whole-response abort; use a 30-second inactivity timeout plus a 45-second absolute request budget, both surfaced as typed failures. Persisted history remains a record, not the primary response channel.

Before implementation, verify the deployed edge runtime can safely hold that stream for the 45-second budget. If it cannot, stop and replace the transport with a background `chat_requests` job plus the same event/status contract; do not fall back to an unbounded JSON request or the current message-count polling.

Track statuses (`pending`, `tool_running`, `generating`, `completed`, `failed`, `cancel_requested`, `cancelled`) in a small `chat_requests` table or equivalent durable record. The Stop control aborts the browser request, posts cancellation for that `request_id`, unlocks the composer immediately, and causes the backend to suppress late persistence after its next cancellation checkpoint. Unique `(conversation_id, request_id)` prevents duplicate turns.

### 4. Structured provider handoff

The app does not currently book rides. After a provider is chosen, return a handoff card containing provider name, qualification/application caveat, phone, email if appropriate, website/application URL, advance notice, and concise “how to book” instructions. Do not ask for name, home address, or phone merely to produce a summary.

---

## Implementation tasks

### Task 1: Add regression fixtures and request-level diagnostic logging

**Files:**

- Create `tests/chat/fixtures/july-9-regressions.json`
- Create `tests/chat/trip-request.test.mjs` or a TypeScript equivalent under the selected test runner
- Create a Supabase migration for `chat_requests` and complete request/tool lifecycle logging
- Modify `scripts/ddl/tables.sql`
- Modify `supabase/functions/chat/tools.ts` logging
- Mirror the migration/DDL in the Aurora path if that deployment remains supported

Steps:

- [ ] Convert the four July 9 histories above into redacted, deterministic regression cases. Keep exact wording needed to reproduce date, one-way, eligibility, DVC, Richmond, and contact-link behavior; omit unrelated personal data.
- [ ] Add request-level fields: `request_id`, start/end timestamps, status, stage, error code, cancel time, model iteration count, response size, and external-service error metadata.
- [ ] Log the currently available tool inputs plus stage durations and diagnostic counts. Apply a documented retention policy to raw addresses/messages. Add normalized trip fields when the `TripRequest` contract lands in Tasks 4 and 6 rather than guessing their schema in this first migration.
- [ ] Reconcile the missing deployed `tool_calls` table: either migrate it and use it consistently or remove the dead DDL constant in favor of the specialized tables. Do not leave two incomplete logging paths.
- [ ] Add a payload-size guard/metric before every model call so geometry or other large fields cannot silently re-enter prompts.
- [ ] Reproduce one Richmond failure with the new instrumentation and record whether Bedrock, the edge runtime, or the client abort is the actual terminal condition. Keep the oversized payload as the leading hypothesis until this evidence is captured.

Acceptance:

- Every request has one terminal status and a correlated tool history.
- A failed post-tool model call is distinguishable from geocoding, provider-query, and client-abort failures.
- The Richmond failure's terminal stage/error is captured before the incident is declared resolved.
- Regression fixtures can run without production credentials by stubbing model, maps, and database boundaries.

### Task 2: Fix the Richmond payload and backend timeout path (P0)

**Files:**

- Modify `supabase/functions/chat/tools.ts`
- Modify `supabase/functions/chat/index.ts`
- Modify `infra/lambda/chat/tools.ts`
- Modify `infra/lambda/chat/index.ts`

Steps:

- [ ] Replace `.select("*")` with an explicit provider projection. Fetch only fields needed for spatial filtering and user-facing results.
- [ ] Strip `service_zone`, `service_area_geojson`, raw/import metadata, and any other geometry before serializing a tool result to Bedrock, logs, attachments, or the frontend. Keep map geometry behind the existing on-demand provider-zone endpoint.
- [ ] Enforce a conservative serialized tool-result target (25 KB) and log the actual size. If a legitimate result exceeds the target, first remove optional metadata, cap lower-ranked results, and truncate display-only free text while preserving eligibility/booking facts; use a hard ceiling with a typed error only as the final safeguard.
- [ ] Bound external calls with stage-specific timeouts and return typed failures. Do not allow ten model/tool iterations for a normal trip search; cap expected flows and fail closed on loops.
- [ ] Ensure a tool success followed by a model failure persists an error state and returns a recoverable response instead of leaving the UI polling indefinitely.
- [ ] If Aurora remains supported, make `supabase/functions/_shared/chatCore.ts` the canonical runtime-independent domain module, add `scripts/sync-chat-core.mjs` to generate the Lambda copy, and fail CI when checksums or fixture results diverge. If Aurora is retired, delete its chat path instead of maintaining a manual copy.

Acceptance:

- The Richmond City Hall -> Grocery Outlet tool result contains no GeoJSON and stays below the agreed payload ceiling.
- The Richmond July 21 request emits its first status event within 1 second, completes at p95 <= 20 seconds in the regression load test, and persists exactly one assistant response. No request may remain active beyond the 45-second absolute budget.
- A model failure after tool completion returns a visible retryable error; no turn remains permanently “thinking.”

### Task 3: Unify request control, cancellation, and composer focus (P0)

**Files:**

- Modify `src/lib/api.ts`
- Modify `src/components/Chat.svelte`
- Add browser tests for Chromium/Edge behavior

Steps:

- [ ] Route chat turns through one SSE client method that accepts an `AbortSignal`, enforces the inactivity/absolute budgets, and surfaces HTTP, timeout, stream, and abort outcomes instead of resolving errors that the caller ignores.
- [ ] Remove `waitForPersistedAssistantMessage` as the primary completion mechanism. Consume the request-correlated SSE status/tool/terminal events; do not combine streaming with conversation-message-count polling.
- [ ] Bind the textarea with `bind:this`, wait for Svelte's DOM update, and focus it with `preventScroll` after success, retryable error, or cancel.
- [ ] Preserve intentional navigation: only auto-focus when focus is still on the composer/send/stop control or has fallen back to `body`; do not steal focus from a link, provider card, or map control the user clicked while waiting.
- [ ] Replace the loading Send button with a visible Stop action while a request is active. Stop should abort locally and unlock the composer in under 500 ms. Allow the user to draft text while generation is active, but prevent a second send for the same conversation until the current request is terminal or cancelled.
- [ ] On component teardown, cancel the active request and ignore any late event for an obsolete `request_id`.
- [ ] Use accessible status text (`aria-live`) and keyboard behavior; verify Enter/Shift+Enter after focus restoration in Edge/Chromium.

Acceptance:

- After a normal reply, the textarea is focused and the user can immediately type.
- If the user clicks a provider link/map control during generation, completion does not steal that focus.
- Stop clears the spinner and re-enables the composer promptly; a late backend result cannot appear as the answer to a newer turn.
- Network failure, timeout, and cancel are visually distinct and offer retry where safe.
- Heartbeats prevent a healthy long tool call from tripping the inactivity timer, while the 45-second absolute budget still guarantees a terminal state.

### Task 4: Implement deterministic date, trip type, and time intent

**Files:**

- Create a shared pure module such as `supabase/functions/_shared/tripRequest.ts` plus a compatible Lambda import/parity copy
- Create a Supabase migration for durable `trip_requests` after the contract below is finalized
- Modify both chat system prompts and tool definitions
- Modify both `executeFindProviders` implementations
- Modify public-transit direction builders

Steps:

- [ ] Inject the server's current date, weekday, and time formatted explicitly in the configured service IANA timezone into each model request. Never use the edge runtime's implicit UTC calendar date.
- [ ] Implement/test deterministic normalization for ISO dates, month/day with inferred upcoming year, `today`, `tomorrow`, and weekday names. Confirm resolved dates in user-facing text.
- [ ] Require `travel_date_raw` for provider and scheduled public-transit searches and compute `travel_date` only on the server. Reject missing, invalid, conflicting, or past dates with `clarification_required`; never accept a model-invented December 20 or example year.
- [ ] Add `trip_type: one_way | round_trip`; require `return_time` only for round trips. For one-way service-hour filtering, evaluate only the outbound time.
- [ ] Add `outbound_time_intent: depart_at | arrive_by`. Preserve the user's phrase (“arrive at 4:10 PM”) instead of silently treating it as a pickup time.
- [ ] Pass normalized date/time and the correct Directions API `departure_time` or `arrival_time` value into public-transit routing. Do not claim a returned itinerary matches a time unless the provider response confirms it.
- [ ] Replace the blanket “add a 30-minute buffer” instruction with explicit semantics: recommend an optional readiness/arrival buffer without changing the user's requested booking times or inventing a return window.

Acceptance fixtures:

- With clock `2026-07-09 America/Los_Angeles`, “tomorrow” resolves to `2026-07-10`.
- On that clock, “July 21” resolves to `2026-07-21`; it never suggests 2025.
- A trip with origin, destination, eligibility, and times but no date asks for the date and does not call provider search.
- “I don't need a return trip” produces a one-way request with `returnTime = null` and no placeholder question.
- “Arrive by 4:10 PM” yields a transit itinerary whose recorded arrival is at or before 4:10 PM on the requested date.

### Task 5: Canonicalize places within the supported service geography

**Files:**

- Modify address/geocode functions in both chat tool implementations
- Add a shared service-geography configuration
- Modify prompt/tool result contract for address resolution

Steps:

- [ ] Define the supported geography in configuration (initially Bay Area/California per product intent) and apply Google Places `regionCode`, Bay Area location bias/restriction where appropriate, and canonical place IDs/addresses.
- [ ] Prefer internal provider data for known provider questions before general web search. Qualify web queries with the supported geography.
- [ ] Return requested text and canonical city/state side by side. If the user requests a named place in a conflicting city—`DVC in Antioch` resolving to Diablo Valley College in Pleasant Hill—pause before provider search and clearly correct/confirm the location.
- [ ] Reuse the same resolver for paratransit and public-transit modes so the correction is not delayed until the user switches modes.
- [ ] Treat Richmond as Richmond, California by default inside the configured service area, while still allowing an explicitly stated out-of-area Richmond.

Acceptance:

- “Richmond” does not trigger a Richmond, Virginia result or a state clarification in the normal OPTIMAT flow.
- “DVC in Antioch” is not presented as a valid destination. The user sees the Pleasant Hill resolution before any provider recommendation.
- Vague places with multiple plausible Bay Area matches still produce a concise choice rather than silently selecting an unsafe result.

### Task 6: Make matching and zero-result explanations deterministic

**Files:**

- Create a provider eligibility evaluator and normalized rule representation
- Add a provider-data migration/validation script for the finalized eligibility rules
- Modify both `executeFindProviders` implementations
- Modify `buildNoProviderResponse` or replace it with a deterministic formatter
- Modify `src/routes/ChatView.svelte` and/or provider result components

Steps:

- [ ] Normalize provider eligibility into structured rules capable of AND/OR conditions, age thresholds, ADA certification, disability, veteran status, and residency. Preserve the original text for display and audit.
- [ ] Validate all current providers against those rules. Keep a manual-review queue for requirements that cannot be represented confidently; do not treat unknown as eligible.
- [ ] Pass the rider's structured eligibility into search. Return `eligible`, `ineligible`, or `verification_required` with an explicit reason for every geography/schedule match.
- [ ] Define declined/unknown behavior explicitly: if the rider declines eligibility questions, geography/schedule matches appear as `verification_required` with the provider's requirements and are never labeled eligible. Providers awaiting manual rule review use the same explicit status rather than silently disappearing.
- [ ] Count/display only `eligible` providers as recommendations. Show `verification_required` separately and only when useful. Keep ineligible providers out of the recommendation count/card list.
- [ ] Add per-stage diagnostics and deterministic empty-result copy:
  - zero geography matches -> name the coverage constraint and do not suggest changing times;
  - geography matches but zero schedule matches -> name the requested day/time issue;
  - schedule matches but zero eligible matches -> name the eligibility mismatch and offer public transit/other general services.
- [ ] Run geography preflight as soon as origin/destination are resolved so an impossible DVC -> San Francisco direct provider trip is explained before collecting unnecessary return, schedule, or booking details.

Acceptance fixtures:

- A general resident searching Bay Point -> DVC receives zero specialized-provider recommendations. One-Seat and Mobility Matters may appear only in exclusions with their actual eligibility reasons; public transit is the fallback.
- An ADA-certified rider searching DVC -> San Francisco is immediately told that no direct provider in current data covers both endpoints. The response does not blame service hours or request a fake return.
- A 65-year-old Richmond resident receives only providers whose eligibility and residency rules match or are explicitly marked as requiring verification.
- Provider counts in prose, attachments, and result cards agree.

### Task 7: Replace pseudo-booking with actionable, safe contact links

**Files:**

- Modify both chat prompts/response formatters
- Modify provider normalization in `src/routes/ChatView.svelte` and relevant provider result components
- Modify Markdown rendering in `src/components/Chat.svelte`

Steps:

- [ ] Remove instructions that imply OPTIMAT can complete a booking. When the user chooses a provider, call `get_provider_info` if needed and present the actual external booking method.
- [ ] Remove the hardcoded provider-name allowlist from the prompt. Resolve provider names against current database records with server-side aliases/fuzzy matching so the prompt cannot drift from provider data.
- [ ] Normalize phone from `booking.details`/known booking fields, emails from `contacts`, and website/application URLs into a single contact view model.
- [ ] Render phone as `tel:`, email as `mailto:`, and websites as normalized HTTPS links with `target="_blank"` and `rel="noopener noreferrer"` where applicable.
- [ ] Put all actionable contacts in structured attachments/cards and keep assistant prose link-independent; do not rely on the model to emit correct Markdown despite the current prompt's “Don't format responses in markdown” rule.
- [ ] Sanitize rendered Markdown with DOMPurify (or an equivalently reviewed HTML sanitizer). `marked.setOptions` is not sanitization, despite the current code comment; raw model HTML must not become executable markup.
- [ ] Avoid collecting name, home address, phone, or driver instructions unless a future authenticated booking integration genuinely needs and protects them.

Acceptance:

- Selecting One-Seat Regional Ride shows a clickable phone number and website plus the eligibility/application caveat; it does not ask OPTIMAT for personal booking details.
- `BART.gov`/provider websites, phone numbers, and permitted email addresses are active links in Edge/Chromium and keyboard accessible.
- Malicious or malformed assistant HTML/URLs are not rendered as executable content.

### Task 8: End-to-end verification and staged rollout

**Files:**

- Add API contract tests for chat tools/formatters
- Add browser tests for the chat flow
- Add a replay script for redacted production fixtures
- Update deployment/runbook documentation

Steps:

- [ ] Add Vitest for shared/frontend pure functions, Deno tests for edge-specific adapters, and Playwright for browser flows. Unit-test date normalization, time parsing (including noon/midnight), one-way validation, eligibility logic, address mismatch handling, diagnostic reason selection, and contact normalization.
- [ ] Contract-test model-independent tool responses with Maps/Bedrock stubbed. Assert no geometry in the model/UI payload and parity across Supabase/Aurora implementations.
- [ ] Browser-test all reported scenarios in Chromium configured to match Edge behavior, including focus, stop, links, and repeated searches without reload.
- [ ] Load-test a worst-case multi-provider Richmond search and record p50/p95 latency, maximum model payload, error rate, and duplicate-message rate.
- [ ] Deploy P0 payload/request-lifecycle fixes first behind a feature flag if necessary. Then deploy the trip-state/search contract and eligibility data migration.
- [ ] Keep deterministic safety tests separate from a small live-model evaluation: unit/contract tests prove the server rejects missing or invented fields; the staging model replay measures whether the assistant asks the right clarification on the first attempt.
- [ ] Replay the July 9 fixtures in staging, review response wording with the product/domain owner, then canary production and monitor request terminal states and zero-result reason distribution.
- [ ] Remove the flag and old polling/prompt-only paths after the canary meets the acceptance thresholds.

Release gates:

- No request remains non-terminal beyond the configured timeout.
- No duplicate assistant messages for one `request_id`.
- No model tool payload contains GeoJSON or exceeds the agreed ceiling.
- All date, one-way, eligibility, DVC, Richmond, focus, cancel, and contact-link regression cases pass.
- Supabase and Aurora behavior is identical for shared fixtures, or the unused backend has been formally retired.

---

## Recommended delivery sequence

0. **Decision gate:** Confirm timezone, service geography, unknown-eligibility policy, booking scope, and whether Aurora remains a supported backend. Verify the Supabase runtime can support the specified SSE budget. The recommendation is to treat Supabase as canonical and retire Aurora unless a current deployment depends on it.
1. **P0 reliability:** Tasks 1–3. This confirms the Richmond terminal failure, removes the payload explosion, makes failures observable, restores control, and fixes composer focus.
2. **P0 correctness:** Tasks 4–6. This introduces deterministic trip state, place validation, staged filtering, and eligibility enforcement.
3. **P1 handoff/security:** Task 7. This fixes booking expectations, links, prompt/provider-list drift, and Markdown safety.
4. **Release:** Task 8 throughout implementation, with the full staging replay as the final gate.

The payload fix should be shipped quickly, but it should not be treated as closure for the reported Richmond problem until cancellation, terminal request state, and regression coverage are also in place.

## Product decisions to confirm before implementation

1. Is `America/Los_Angeles` the authoritative timezone for all deployments and trip dates?
2. Should the normal location default be all nine Bay Area counties, or a narrower Contra Costa/East Bay service region?
3. When eligibility is unknown, should the UI show `verification required` candidates, or ask until eligibility is known and show none before that?
4. Is there any real booking integration planned now? If not, the implementation should fully remove personal booking-detail collection and use external handoff only.
5. Is the Aurora/Lambda chat path still deployed or contractually supported? If not, retire it before P0 work; if yes, select a concrete shared-code mechanism and require fixture parity in the same change.
