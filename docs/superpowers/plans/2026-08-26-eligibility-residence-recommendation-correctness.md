# Eligibility, Residence, and Recommendation Correctness Plan

**Date:** 2026-08-26
**Status:** Plan only; no behavior changed
**Input:** August 24 review notes for Walnut Creek, San Ramon, and Richmond cross-agency trips
**Production target:** AWS API Gateway/Lambda/Aurora in `us-west-1`

## Implementation decision amendment — 2026-08-30

The implementation keeps the existing geographic contract: both source and destination must be inside a
provider's `service_zone` GeoJSON. GeoJSON remains a source/destination restriction; residence, age,
disability, ADA paratransit eligibility, and veteran requirements are filters layered on top.

Eligibility reasoning remains LLM-driven. Reliability comes from a constrained workflow rather than
provider-specific code: structured rider facts persist across turns, `find_providers` returns candidates rather
than cards, the LLM must submit one structured verdict for every candidate through `assess_eligibility`, and
the backend rejects missing or invented assessments before cards are rendered. Confirmed data problems remain
data-team work and are not silently hard-coded into the application.

## Goal

Make provider recommendations reproducible from trip facts and reviewed provider policy. The same
origin, destination, date, time, and rider facts must always produce the same provider buckets,
regardless of model wording or conversation history.

This work must correct the August 24 failures without regressing the cases the sheet marks correct:

- Lamorinda Spirit only for residents of Lafayette, Moraga, or Orinda.
- Rossmoor Dial-A-Bus only for Rossmoor community residents.
- Mobility Matters only for riders who are 60+ or veterans, and who reside in Contra Costa County.
- Walnut Creek Lyft passes and Mini Bus only for riders meeting their age/disability and residency rules.
- Senior Express Van appears for qualifying San Ramon riders when its verified operating window covers the trip.
- LINK is not presented merely because the rider is disabled, and it is suppressed when the approved
  single-agency rule says a local provider can fulfill the trip.
- Residence is requested only when unknown and capable of changing the result; a prior explicit answer is remembered.
- Provider cards and prose are generated from one authoritative result, so prose cannot add an excluded provider.

## Current-state diagnosis

The review failures share one cause rather than being isolated prompt mistakes.

1. Production uses `infra/lambda/chat/`, while the richer eligibility/state/test architecture under
   `supabase/functions/chat/` is no longer the production path.
2. `infra/lambda/chat/index.ts` asks the model to collect eligibility before searching and retains only
   ordinary message prose between turns. There is no structured rider profile or durable trip digest.
3. `infra/lambda/chat/tools.ts` filters by geometry and service hours, then returns all candidates to the
   model. It accepts one free-form `eligibility_type` string and does not validate the model's eligibility
   decisions before the provider cards are emitted.
4. Provider requirements are stored as prose in `eligibility_reqs`. Residence, age, disability, ADA
   paratransit eligibility, veteran status, application requirements, and recommendation priority are not
   separately executable.
5. A service area answers where a provider can drive; it does not prove where the rider resides. The model
   is currently conflating those concepts, which explains Lamorinda and Rossmoor appearing for Walnut Creek
   residents.
6. The production LINK record says `Disabled (18+)` even though the review expects stricter ADA/single-agency
   behavior. This cannot be corrected reliably with response wording alone.
7. One-Seat policy is contradictory across the supplied evidence. The August 24 notes call it missing in some
   cross-agency cases, while the approved August 17 plan and current code retire it as a standalone provider.

## Product decisions required

Only the first decision blocks final acceptance criteria; implementation of the shared evaluator can begin
before it is resolved.

### D1 — One-Seat Regional Ride

Choose one policy and encode it as data plus tests:

- **Recommended:** keep One-Seat retired as a standalone provider. For cross-agency trips, return a
  `cross_agency_connection` advisory naming the origin and destination agencies and telling the rider to
  contact the origin agency for coordination.
- **Alternative:** restore One-Seat as a coordination program, not a normal provider card. Define its exact
  disability/ADA requirement, participating agencies, geography, contact path, and whether it has any fare.

Do not restore the old broad polygon/fixed-fare provider behavior.

### D2 — Meaning of “single agency can fulfill the trip”

Confirm whether this suppresses only cross-agency coordination products or also suppresses LINK when another
local program can serve the rider. The August 24 notes explicitly say to suppress LINK in those cases, so this
plan assumes that rule until product says otherwise.

### D3 — Residence evidence

Recommended rule: accept an explicit residence statement from the rider. Do not infer residence from an
arbitrary pickup address. A phrase that unambiguously identifies the pickup as home may populate residence,
but the parsed fact must remain visible and correctable.

## Target contract

### Structured provider eligibility

Add an `eligibility_policy JSONB` column to `optimat.providers` while retaining `eligibility_reqs` as display
and source text. Use a small versioned schema, for example:

```json
{
  "version": 1,
  "qualifying_categories": {
    "any_of": [
      { "fact": "age", "operator": ">=", "value": 60 },
      { "fact": "disabled", "operator": "=", "value": true }
    ]
  },
  "residence": {
    "one_of_cities": ["Walnut Creek", "Concord", "Clayton", "Pleasant Hill", "Martinez"]
  },
  "proof_or_application": ["Complete the Walnut Creek Transportation Program application"],
  "source": { "url": "...", "reviewed_at": "..." }
}
```

The schema must support:

- age thresholds;
- disability, ADA paratransit eligibility, and veteran flags as distinct facts;
- AND/OR category groups;
- city, county, and named-community residence constraints;
- provider-only verification and application/proof steps;
- no eligibility restriction for fixed-route transit.

Do not derive this JSON at request time from prose. Populate and review it during provider import/migration.

### Structured rider facts

Use one `RiderEligibility` object throughout the tool contract and persisted chat state:

```ts
type RiderEligibility = {
  age?: number;
  disabled?: boolean;
  ada_paratransit_eligible?: boolean;
  veteran?: boolean;
  residence_city?: string;
  residence_county?: string;
  declined?: boolean;
};
```

Unknown is absence, not `false`. Store only facts the rider explicitly states or explicitly confirms.

### Evaluator output

A pure server-side evaluator returns one of:

- `eligible`: all required facts are known and match;
- `ineligible`: at least one required fact is known and fails with no matching OR branch;
- `conditional`: one or more unknown facts could change the result;
- `provider_verification`: rider facts match, but only the provider can finish the determination.

Each result includes stable reason codes, the decisive rule, missing facts, and rider-safe explanation facts.
The model may phrase those facts but may not change the bucket.

### Recommendation policy

Eligibility and recommendation are separate stages:

1. Geocode and validate both addresses.
2. Find providers whose service areas cover the trip.
3. Apply verified service hours.
4. Evaluate structured eligibility.
5. Apply trip-level recommendation policy:
   - remove fixed-route agencies from paratransit cards;
   - suppress providers excluded by single-agency/cross-agency policy;
   - produce a connection advisory separately from provider cards;
   - rank direct eligible options ahead of conditional/provider-verification options.
6. Generate attachments and prose from the same immutable result.

The response verifier must reject any answer that names an ineligible/suppressed provider as a recommendation,
omits a recommended provider, changes counts, or makes a definitive eligibility claim.

## Implementation phases

### Phase 0 — Freeze the review matrix and reproduce production

**Files:** new `tests/chat/feedback-2026-08-24.json`, new AWS chat integration harness, QA evidence folder

1. Transcribe every screenshot row into a machine-readable fixture containing origin, destination, date,
   outbound/return times, rider facts, expected recommended/conditional/excluded providers, and expected
   next question.
2. Separate historical “Eligible Providers” cells from August 24 acceptance notes when they conflict. The
   August 24 note and resolved product decisions are authoritative.
3. Add explicit exclusions and reason codes instead of checking only that desired names are present.
4. Replay every case against production and save the raw provider-search attachment, prose, model ID, code
   SHA, and latency. Redact rider-sensitive data from committed artifacts.
5. Add controls for cases currently correct: Mobility Matters for a 65-year-old Contra Costa resident,
   Mobility Matters as conditional for a 55-year-old veteran-unknown rider, and the Richmond-to-Concord
   cross-agency example.

**Exit:** every August 24 observation is reproduced or documented as already fixed, and the expected matrix
has product sign-off.

### Phase 1 — Make AWS chat the tested authoritative implementation

**Files:** `infra/lambda/chat/index.ts`, `infra/lambda/chat/tools.ts`, new runtime-neutral modules under
`infra/lambda/chat/domain/`, `infra/package.json`

1. Port the proven concepts from `supabase/functions/chat/trip.ts`, `state.ts`, and `responses.ts` into
   runtime-neutral modules using the AWS database and location adapters.
2. Add structured `find_providers` input, one-way/round-trip semantics, exact date resolution, structured
   rider facts, and durable per-conversation trip state.
3. Change `find_providers` to return candidates and diagnostics; make a separate deterministic assessment
   stage produce rider-facing provider buckets.
4. Remove the production prompt's fixed eligibility interrogation and generic booking assertions. Search
   with known facts, then ask the highest-value missing question returned by the evaluator.
5. Put model ID, effort, and token limit behind environment configuration, but do not use a model change as
   the correctness fix.
6. Add a TypeScript unit-test runner to `infra` and make AWS domain tests a deployment gate.

**Exit:** the production implementation has structured state, candidate/assessment separation, response
verification, and unit coverage; no rider-facing result depends on an unvalidated model verdict.

### Phase 2 — Normalize and migrate eligibility policy

**Files:** new ordered Aurora migration, `scripts/ddl/tables.sql`, `scripts/provider-cleaning.mjs`, provider
import/update scripts, provider API serializers

1. Add `eligibility_policy JSONB`, a schema-version check, source metadata, and an optional
   `recommendation_policy JSONB` for rules that are not rider eligibility.
2. Create reviewed mappings for all active providers. Start with the providers in this feedback before
   expanding the migration:
   - Lamorinda Spirit;
   - Rossmoor Dial-A-Bus;
   - Mobility Matters;
   - Senior Express Van (San Ramon);
   - Go San Ramon!;
   - LINK Paratransit;
   - Walnut Creek Mini Bus;
   - Walnut Creek Lyft Self Access Pass;
   - Walnut Creek Lyft Concierge Pass.
3. Correct LINK's rule so disability and ADA paratransit eligibility are not treated as synonyms. Encode the
   approved single-agency suppression as recommendation policy rather than eligibility prose.
4. Validate Senior Express Van's actual July 30 operating window and service-area geometry against the
   authoritative source. Correct the data if the expected noon–3 p.m. trip should be served; otherwise update
   the acceptance expectation with evidence rather than bypassing the hours filter.
5. Ensure the import pipeline preserves structured policies and fails closed when an active provider's policy
   is missing or invalid. A future workbook refresh must not revert the reviewed rules to free text.
6. Keep `eligibility_reqs` for display/provenance during migration, then stop using it for decisions.

**Exit:** all active providers validate against the versioned schema, the feedback providers have reviewed
rules, and dry-run migration reports show the intended before/after policy differences.

### Phase 3 — Implement deterministic eligibility and residence handling

**Files:** new `infra/lambda/chat/domain/eligibility.ts`, `trip-state.ts`, `recommendations.ts`, AWS chat tools

1. Implement the evaluator as pure functions with table-driven tests for every operator and AND/OR group.
2. Normalize city aliases without using service-area membership as residence proof. Resolve county from a
   maintained locality reference only after the rider supplies a residence city; retain the original answer.
3. Compute `next_question` from the missing fact that changes the most candidate outcomes. Do not ask about
   residence when all remaining providers lack a residence rule or the answer is already known.
4. Persist rider facts per conversation and apply explicit supersede/correction rules. A new trip keeps rider
   facts unless the rider changes them; a stated new residence replaces the old one.
5. Emit stable exclusions such as `residence_city_mismatch`, `age_below_minimum`,
   `ada_eligibility_required`, `veteran_status_unknown`, `outside_service_hours`, and
   `suppressed_single_agency_trip`.
6. Render conditional matches separately. Never label “veteran unknown” as eligible and never recommend
   Mobility Matters to a 55-year-old solely because they are disabled.

**Exit:** repeated runs of every fixture produce identical provider buckets and next questions without model
involvement.

### Phase 4 — Implement same-agency and cross-agency policy

**Files:** `infra/lambda/chat/domain/recommendations.ts`, provider policy migration, response/card mapping

1. Determine the agencies covering each endpoint and the providers covering both endpoints.
2. When a qualifying single-agency option can fulfill the whole trip, suppress connection-only products and
   apply the resolved LINK policy with a stable reason code.
3. For a true cross-agency trip, produce a structured connection advisory. Apply D1:
   - retired path: name the applicable agencies and omit One-Seat as a card;
   - restored-program path: show a coordination advisory only after its explicit eligibility and network rules pass.
4. Keep connection advisories out of provider counts and fare calculations.
5. Add boundary, overlapping-area, and origin-only/destination-only tests so broad polygons cannot reintroduce
   a coordination option on a local trip.

**Exit:** Walnut Creek local, San Ramon local, Richmond-to-Concord, and Richmond-to-Walnut-Creek cases all
produce the approved connection behavior.

### Phase 5 — Lock prose and UI to authoritative results

**Files:** `infra/lambda/chat/index.ts`, response verifier, `src/components/ProviderResults.svelte`,
`src/components/ProviderCard.svelte`

1. Build provider cards only from the deterministic `recommended` and `conditional` arrays.
2. Inject compact result facts into the model context for explanation; do not give the model permission to
   promote excluded candidates.
3. Verify provider names, buckets, counts, next question, and preliminary wording before sending. Re-prompt
   once on mismatch, then use a deterministic fallback generated from the result.
4. Show why conditional providers need more information and expose the single relevant follow-up question.
5. Keep internal exclusions available in safe diagnostics/evidence, not as a confusing list of unusable
   provider cards.

**Exit:** the UI and prose cannot disagree, and every recommendation shown in text has a matching card and
server decision.

### Phase 6 — Staged deployment and proof

1. Deploy the schema and provider-policy migration to staging first; run validation before enabling new chat
   code.
2. Run unit tests, TypeScript checks, SAM validation/build, API contract tests, the existing chat eval, and the
   complete August 24 matrix.
3. Run each matrix case repeatedly across fresh and multi-turn conversations to detect nondeterminism and
   state leakage.
4. Capture before/after screenshots plus raw structured results for each unique failure class: residence,
   age/veteran, ADA versus disability, missing Senior Express Van, single-agency suppression, and cross-agency
   coordination.
5. Release behind a chat-version environment flag, canary production traffic, watch error rate/latency and
   result-verifier failures, then promote. Roll back code independently from the additive schema/data migration.
6. After production smoke tests pass, archive or clearly mark the Supabase chat implementation as non-runtime
   reference so future fixes are not applied to the wrong backend.

## Before/after video evidence and delivery plan

Every behavior change in this plan requires paired video evidence. Screenshots remain useful for quick review,
but they do not replace video when the result depends on question order, remembered residence, provider-search
progress, or a multi-turn correction.

### Evidence set

Create three layers of evidence:

1. **Raw scenario pairs:** one `before` and one `after` recording for every row in
   `tests/chat/feedback-2026-08-24.json`. These are the complete audit record.
2. **Change-focused comparisons:** one short comparison per failure class, using the clearest representative
   scenario and showing before followed immediately by after:
   - residence questioning and memory;
   - Lamorinda and Rossmoor residence exclusions;
   - age/veteran handling for Mobility Matters;
   - disability versus ADA paratransit eligibility for LINK;
   - single-agency LINK suppression;
   - Senior Express Van inclusion and schedule handling;
   - cross-agency/One-Seat behavior after D1 is resolved;
   - agreement between provider cards and assistant prose.
3. **Stakeholder summary reel:** a concise video containing all change-focused comparisons, title cards, and a
   final acceptance summary. Target 3–6 minutes; link to the raw pairs for detail.

### Capture protocol

Add a deterministic Playwright evidence harness, for example
`tests/chat/feedback-2026-08-24-video-evidence.mjs`, and store artifacts under
`docs/qa/feedback-2026-08-24/`.

For each scenario:

1. Record **before** from the production version or a clean build pinned to the exact pre-fix commit. Record
   the commit SHA, backend version, provider-data version, model ID, viewport, browser, and capture timestamp
   in `manifest.json`.
2. Record **after** from staging at the candidate release commit with the migrated provider-policy data.
3. Use the exact same messages, addresses, dates, times, rider facts, viewport, browser, and starting state.
   Freeze the service clock where relative dates could change the result.
4. Start from a fresh conversation unless the scenario explicitly tests remembered residence. For memory
   cases, use the same prescribed turn sequence in both recordings.
5. Show the decisive behavior visibly: the assistant's follow-up question, the completed recommendation text,
   and the full provider-card list. Expand conditional details when they are part of the acceptance criterion.
6. Add a brief end card showing `Expected`, `Actual`, and `PASS` only after automated assertions for that run
   succeed. The harness must not label a recording as passing based only on visual appearance.
7. Capture at 1440×900 desktop. Repeat the representative summary scenarios at 390×844 to prove the existing
   mobile layout still presents the same provider result.
8. Keep each raw clip focused—normally 20–60 seconds—and avoid idle loading footage where possible without
   hiding material transitions.

### Artifact layout and naming

Use stable scenario IDs from the regression fixture:

```text
docs/qa/feedback-2026-08-24/
  README.md
  manifest.json
  before/
    WC-65-DISABLED-ADA.webm
    SR-55-VETERAN-UNKNOWN.webm
  after/
    WC-65-DISABLED-ADA.webm
    SR-55-VETERAN-UNKNOWN.webm
  comparisons/
    residence-exclusions.mp4
    mobility-matters-age-veteran.mp4
    link-ada-and-single-agency.mp4
    senior-express-van.mp4
    cross-agency-one-seat.mp4
    prose-card-consistency.mp4
  feedback-2026-08-24-before-after-summary.mp4
```

The `README.md` maps every feedback row to its before clip, after clip, expected providers, actual providers,
automated-test result, and comparison segment timestamp. Generate MP4 delivery copies for broad compatibility;
the raw browser recordings may remain WebM.

### Editing and quality checks

1. Normalize before/after clips to the same resolution, frame rate, and audio policy.
2. Precede each comparison with a 2–3 second title card naming the scenario and expected correction.
3. Label footage continuously as `BEFORE` or `AFTER`; do not rely on color alone.
4. Use a hard cut or a short neutral transition. Do not accelerate through the decisive response or obscure it
   with annotations.
5. Add captions or readable text callouts for the exact provider added, removed, or moved to conditional.
6. Redact tokens, conversation identifiers, browser profiles, console output, and any rider information not
   already part of the approved synthetic fixture.
7. Review every exported MP4 from beginning to end and verify duration, readable text, correct ordering,
   synchronized labels, and successful playback in Chrome, Safari, and the intended sharing destination.
8. Generate SHA-256 checksums for the delivered files and record them in the manifest so replacements are
   detectable.

### Video acceptance matrix

| Change | Required before evidence | Required after evidence |
| --- | --- | --- |
| Residence questions | Residence omitted, re-asked, or ignored inconsistently | Residence asked only when decisive and remembered on the next turn |
| Lamorinda/Rossmoor | Incorrect provider appears for a Walnut Creek resident | Provider absent with the correct residence exclusion in diagnostics |
| Mobility Matters | Disability incorrectly treated as qualifying, or veteran uncertainty mishandled | 60+/veteran and county-residence rule produces eligible, conditional, or excluded correctly |
| LINK eligibility | Disability alone causes LINK to appear | ADA fact and approved LINK policy control the result |
| Single-agency policy | LINK/coordination option appears despite a direct local solution | Direct provider remains and suppressed option is absent |
| Senior Express Van | Qualifying San Ramon trip omits the van | Van appears when verified date/time rules pass, or evidence clearly shows why hours exclude it |
| Cross-agency/One-Seat | Current inconsistent or missing behavior | Resolved D1 behavior is shown without a fabricated provider/fare |
| Prose/card agreement | Assistant mentions a provider not represented correctly in cards | Text and cards show identical recommended/conditional sets and counts |
| State correction | Prior residence is lost or stale facts leak into the answer | Remembered facts persist and an explicit correction cleanly supersedes them |
| Mobile regression | Representative pre-fix flow at 390×844 | Same corrected result is readable at 390×844 with no map/layout regression |

### Delivery workflow

1. Do not send draft footage until the matching automated scenario and staging smoke test pass.
2. Have engineering review the raw pairs for technical accuracy and product review the provider expectations,
   especially One-Seat, LINK, and Senior Express Van.
3. Upload the summary MP4 and the full evidence folder to the stakeholder-approved shared location. Preserve
   the version-controlled `README.md`, manifest, and reasonably sized evidence files in the repository; use a
   shared-drive link for files that exceed repository limits.
4. Send one stakeholder message containing:
   - the summary-reel link;
   - the full before/after evidence-folder link;
   - the release SHA and staging/production environment;
   - a concise list of corrected behaviors;
   - unresolved or evidence-backed exceptions;
   - a request for explicit approval of D1 and final acceptance.
5. After production deployment, run a small production smoke capture for each change-focused comparison. If
   staging and production match, add the production confirmation and date to the README; if they differ, stop
   distribution of the “final” label and reopen the failed scenario.

**Video exit gate:** every feedback fixture has a valid before/after pair, every change category appears in
the summary reel, all after runs pass their automated assertions, the artifact manifest is complete, and the
stakeholder delivery links have been tested with the intended recipient permissions.

## Required regression matrix

At minimum, automate these assertions:

| Scenario | Required result |
| --- | --- |
| Walnut Creek resident, 65, disabled, ADA eligible | Exclude Lamorinda and Rossmoor; include only policy- and schedule-valid Walnut Creek/direct options |
| Walnut Creek resident, 65, not disabled | Exclude LINK and Lamorinda; evaluate age-eligible Walnut Creek programs and Mobility Matters |
| Walnut Creek resident, 55, not disabled, veteran unknown | Mobility Matters conditional on veteran; exclude 60+ programs, LINK, and Lamorinda |
| Walnut Creek resident, 55, disabled, ADA eligible | Exclude Mobility Matters unless veteran; apply LINK single-agency rule; exclude Lamorinda |
| San Ramon resident, 65, disabled, ADA eligible | Include Senior Express Van when verified hours cover the trip; exclude residence-mismatched providers |
| San Ramon resident, 65, not disabled | Exclude LINK; include age/residence matches and Mobility Matters |
| San Ramon resident, 55, not disabled, veteran unknown | Mobility Matters conditional on veteran; exclude LINK; include valid San Ramon resident programs |
| San Ramon resident, 55, disabled, ADA eligible | Include Senior Express Van if schedule-valid; apply LINK single-agency policy |
| Richmond resident, 65, disabled, not ADA eligible | Recommend Mobility Matters when schedule/geography permit; exclude ADA-only options |
| Richmond resident, 55, disabled, ADA eligible | Do not recommend Mobility Matters unless veteran; apply resolved cross-agency/One-Seat policy |
| Residence omitted | Ask residence only if it changes at least one candidate; never infer it from service area alone |
| Residence answered on prior turn | Do not ask again; corrected residence supersedes stored value |

Every row must also assert exact excluded-provider reason codes and that prose contains no excluded name as a
recommendation.

## Definition of done

- The August 24 fixture matrix is approved and passes in staging and production.
- One-Seat and LINK product decisions are encoded in policy data, reason codes, and tests.
- All active providers have validated structured eligibility policies or are quarantined from recommendation.
- Residence, service area, and destination are modeled as distinct concepts.
- No model-generated eligibility verdict reaches the UI without server validation.
- Repeating the same scenario produces identical provider buckets and follow-up question.
- AWS chat is the tested source of truth; obsolete Supabase behavior cannot create false confidence.
- Production before/after evidence and rollback results are recorded alongside the August 24 review artifacts.
