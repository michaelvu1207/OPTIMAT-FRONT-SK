# Second focus group follow-ups — November 3, 2026

Status: implemented locally; not deployed. No production provider records were changed in this batch.

## Changes

- Named-provider information is collapsed under “View provider details.” Public information remains readable; raw JSON and record metadata remain excluded. Recommendation cards retain application and booking warnings.
- Instructions ask the assistant to answer the direct question briefly without duplicating every card field.
- A new `clarify_trip_time` tool offers Pickup time and Arrival time buttons. Button messages preserve the stated time and existing composer draft. The assistant is instructed to reuse explicit answers and ask for pickup time when only arrival is known, without inventing a travel-time buffer.
- A new `open_route_planner` tool offers bus/train or cycling links to Google Maps. It makes no external API requests, uses no API key, and does not collect provider-eligibility information for route-only requests. Missing locations can be entered in Google Maps. This feature does not calculate routes or guarantee timetables.
- Membership fees without an explicitly associated billing period receive a provider-confirmation notice. A monthly ride allowance does not establish a monthly membership fee.
- Non-fixed-route recommendation cards remind riders to confirm ride availability, particularly for same-day trips. Prompt instructions prohibit unsupported availability or relative-speed claims.
- The compact mobile greeting states the audience and Contra Costa County scope.

Earlier local changes in the same pending release include equal-height Voice input/Send controls, exact-age eligibility checks, a persistent no-booking notice, and evidence-based cross-city service explanations.

## Validation

- Backend test suite: 97 passed.
- Membership billing regression: passed, including monthly trip allowances and explicit annual/one-time fees.
- Frontend and backend type checks: passed; Svelte reported zero errors and warnings.
- Mocked browser tests: provider disclosures and metadata protection at 1280px and 320px; time-button messages and draft preservation; route link rendering; mobile composer across ten viewport sizes.
- Production build: passed, with existing SSR-option and Leaflet/chunk warnings.
- Secret scan: passed, 507 files checked before adding this report.

Browser tests use mocked responses and do not validate live model tool selection. A staging/live conversation replay after deployment and real-device VoiceOver and speech testing remain necessary.

## Suggested manual replay after deployment

1. “I need a ride from Danville Community Center to 320 Lennon Lane, Walnut Creek, at noon.” If the time meaning is unclear, select Arrival time; the assistant should request pickup time rather than inventing one.
2. “Show me bicycle directions from Danville Community Center to Walnut Creek.” Expect a route-planner handoff without age/disability intake.
3. “How can I get bus or train directions from Danville to Walnut Creek?” Expect a transit handoff, not a claim that OPTIMAT calculated a schedule.
4. “Do I need to apply for Mobility Matters before my first ride?” Expect a concise response and an optional provider-details disclosure. Actual application requirements depend on verified provider data.
5. Search for a provider with a $60 membership fee and a monthly trip allowance. If the fee period is missing, expect a confirmation notice rather than an inferred annual or monthly fee.

## Meeting questions

1. **Membership fees:** For the Walnut Creek Lyft programs, is the $60 membership fee annual, monthly, or one-time? Do both programs use the same fee period? Who can provide a current official source?
2. **First-ride requirements:** For Mobility Matters and each paratransit provider, what must happen before the first booking: an inquiry, registration, completed application, eligibility review, or approval? What is the processing time, what starts the clock, and is there a waitlist? Please distinguish this from advance ride-booking notice. Do not assign a generic 30-day duration.
3. **Unconfirmed Mobility Matters data:** The website shows a form/phone contact and coordinator follow-up but does not establish a processing duration. Can the team confirm whether formal pre-ride approval is required? Until confirmed, use “Not yet confirmed” for unsupported fields; do not imply the latest local code batch changed the production record.
4. **Phone assistance:** What staffed CCTA number should OPTIMAT display, with what hours, languages, start date, and owner? Is it a navigation/help line or a ride-booking line?
5. **Languages and accessibility testing:** Which languages are highest priority, and who will review translations? Who can test VoiceOver, speech transcription, zoom and keyboard behavior on actual phones/tablets, especially the devices used in the focus groups?
6. **Map scope:** Is a chat/map toggle plus external route planning sufficient on phones/tablets, or is a full in-app route required? The latter needs separate feasibility and cost review; no new paid routing service has been added.
7. **Data and policy ownership:** Who maintains provider fees, application details, verified destinations and verification dates? Who confirms privacy/retention wording? Chat/trip information is stored, so the UI must not claim it is never stored. For service animals, is provider contact guidance acceptable while policies remain unverified, without filtering out providers for missing data?
8. **End of chat:** Should an explicit End chat action be introduced, or should New Chat remain sufficient? What should be retained or cleared? No automatic chat termination has been added.

## Named-pass pricing replay follow-up

A production screenshot showed the assistant claiming no recorded pricing for Walnut Creek Lyft Concierge Pass, referring the rider to generic Lyft support, and displaying a compound follow-up as one binary choice. The screenshot does not establish whether the model skipped lookup or used an unsuitable lookup name; production traces were not inspected for this replay.

Local fixes, not deployed:
- Explicit mentions of Walnut Creek Lyft/Lift Concierge or Self Access Pass trigger a current internal provider lookup before model generation, independent of whether the model requests a tool. No price is hard-coded and no external search is used.
- The model receives only the existing public provider projection, with municipal-program identity guidance. Identical provider-info attachments are deduplicated.
- Named-provider instructions require recorded-data lookup before declaring fees unavailable.
- Compound questions with independent question clauses are rejected by binary-choice registration; genuine single-fact confirmations remain supported.
- The shortcut is scoped to explicit Walnut Creek program mentions; it does not reinterpret generic Lyft, Lyft Pink or another county’s program.

Validation: 100 backend tests passed and backend type check passed. The handler regression verifies that the first model request receives current recorded fare data even when the model does not request tools. Actual live response wording remains to be replayed after an authorized deployment.
