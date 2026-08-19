# OPT2608 Issue Replication and Remediation Plan

**Date:** 2026-08-17

**Updated:** 2026-08-18

**Scope:** OPT260810-02, OPT260813-01 through OPT260813-06, and OPT260817-01

**Goal:** Reproduce each reported issue, implement the smallest reliable correction, and provide comparable before/after visual evidence for every ticket.

## Current-state findings

- The working tree already contains uncommitted work that retires One-Seat Regional Ride, removes its fare, excludes it from provider search and the chat roster, and clears eligibility text from fixed-route providers. Treat this as in-progress work that still needs review, tests, and deployment validation.
- `origin/master` currently places **Save as Example** permanently in the chat status bar.
- The chat still contains rider-facing uses of **ADA certification**, including the provider-card label and generated/example conversations.
- Fixed-route results already request Google transit directions and can carry route geometry and step detail. The UI also has a fallback origin-to-destination connection line, which can create the reported straight-line presentation when usable route geometry is absent.
- The desktop chat is a permanently horizontal map/chat split using resizable panes. There is no mobile layout breakpoint that removes or collapses the map.
- Existing provider data records WestCAT paratransit products as bookable 1–7 days ahead, not 14 days.
- Tri Delta Transit fixed-route geometry comes from the configured regional GeoJSON source and must not be changed until Joshua confirms the authoritative boundary.

## Product and implementation decisions

These decisions are final for implementation unless new authoritative evidence contradicts them:

1. **One Seat Ride:** OPT260810-02 supersedes the narrower behavior described in OPT260813-04. Retire One Seat Ride as a standalone provider because the participating agencies arrange cross-area connections. Preserve agency transfer/coordination guidance for cross-area trips, but do not return a separate One Seat result, map area, booking contact, or fixed fare.
2. **WestCAT:** Model the rule by trip type rather than applying 14 days to every WestCAT ride. WestCAT ADA regional trips may be booked up to 14 days ahead; ordinary WestCAT ADA and Senior Dial-A-Ride reservations remain 1–3 days ahead. This is supported by WestCAT's current [ADA Paratransit Guide](https://www.westcat.org/Content/pdf/REVADA-Paratransit-Guide.pdf) and [Senior Dial-A-Ride Guide](https://www.westcat.org/Content/pdf/REVSenior-Dial-A-Ride-Guide.pdf).
3. **Fixed route:** Keep the richer in-app Google itinerary and add an **Open in Google Maps** handoff. Never show a straight-line substitute as a transit route.
4. **Mobile:** Implement a chat-first phone layout with no map below 768 px and preserve the desktop split view.
5. **Tri Delta:** Do not guess at a boundary. Joshua must confirm the authoritative geometry source before it is changed. Reproduction, source comparison, and all unrelated work may proceed in parallel.

## Evidence protocol for every ticket

Before implementation, reproduce against a clean `origin/master` build in an isolated worktree so current uncommitted changes do not contaminate the baseline. After implementation, repeat the exact same scenario, seed data, viewport, and browser.

For every ticket, attach:

- `before.png` and `after.png` at the decisive UI state;
- a short `before.webm` and `after.webm` when the defect depends on interaction, multiple chat turns, routing, or responsive behavior;
- a small manifest recording commit SHA, environment, viewport, browser, test input, expected result, and actual result;
- automated-test output tied to the same fixture or scenario.

Use stable test data and freeze date/time where scheduling affects results. Redact rider information and keep API keys, tokens, and other secrets out of recordings, browser consoles, filenames, and manifests.

## Ticket-by-ticket plan

### OPT260810-02 — Remove One Seat Ride as a standalone option and its fixed cost

**Replicate**

- Run a known trip that currently returns One-Seat Regional Ride.
- Capture the provider card, fare, map/service-area overlay, provider directory entry, and chat recommendation.

**Fix**

- Retain the database row for audit history but mark it inactive; exclude it consistently from provider APIs, the chat roster, search results, provider directory, service-area import, and example/evaluation fixtures.
- Clear the standalone fare so `$3.00` or another fixed cost cannot leak through legacy endpoints.
- For cross-agency trips, have OPTIMAT recommend the applicable participating agencies and explain that they coordinate the connection; do not present One Seat Ride as a separate bookable provider.
- Make imports idempotent so a later provider-data refresh cannot reactivate the retired entry.

**Verify**

- Unit tests for name aliases, `is_operating`, imports, provider endpoints, roster generation, and search filtering.
- Regression scenarios for both a same-agency trip and a cross-agency trip.
- Confirm no rider-facing result, directory, or map overlay contains One Seat Ride or its fare.

**Visual proof:** paired screenshots of the old/new result cards and provider directory; paired recordings of the complete trip search.

### OPT260813-01 — WestCAT can be booked 14 days in advance

**Replicate**

- Search for each WestCAT paratransit product and capture its booking window in the result card, chat answer, and provider information page.

**Fix**

- Replace the misleading single generic window with structured rules: ordinary WestCAT ADA Paratransit `1–3 days`, WestCAT ADA regional trips `up to 14 days`, and WestCAT Senior Dial-A-Ride `1–3 days`.
- Store the regional-trip exception in canonical provider data rather than hard-coding display text in the card or prompt.
- Update provider-import source data/defaults and add a migration so development, staging, and production remain consistent.
- Render the correct rule from trip context. If OPTIMAT cannot determine whether a trip is regional, display both rules clearly instead of choosing one silently.
- Cite the official WestCAT ADA and Senior guides in source metadata.

**Verify**

- Data migration assertions for WestCAT ADA Paratransit and Senior Dial-A-Ride.
- Formatting and chat tests for an ordinary local trip, a regional trip 8–14 days away, and an ambiguous trip classification.
- Confirm an ordinary local trip is not incorrectly advertised as bookable 14 days ahead.

**Visual proof:** paired screenshots of the WestCAT booking line and paired recordings of a chat asking how early the ride can be booked.

### OPT260813-02 — Fixed-route results must defer to Google Maps or show a real itinerary

**Replicate**

- Use the reported scenario from before the recent modification, plus one trip with transit geometry and one with no transit route.
- Capture the card, map, and response showing a straight connection or insufficient detail.
- Use Git history to identify the specific recent change that caused the regression and add its scenario as a permanent test.

**Fix**

- Establish one fixed-route contract: Google transit directions must provide an actual itinerary before OPTIMAT labels the option as a fixed-route recommendation.
- When route data exists, show agency/line, walk legs, stops, transfer count, departure/arrival times, duration, and decoded step polylines.
- Add an **Open in Google Maps** transit-directions link containing origin, destination, and travel mode.
- When route data is missing or malformed, omit the route line and itinerary claim; show a neutral Google Maps handoff instead.
- Never use the origin/destination connection line as a fixed-route path. Keep it only for clearly labeled non-route orientation, or suppress it while fixed-route is selected.

**Verify**

- Unit tests for complete, partial, malformed, and empty Google responses.
- UI tests proving route steps and polylines render together and the straight-line fallback does not masquerade as transit.
- Regression test for the exact recently broken trip.

**Visual proof:** paired map/card screenshots; paired recordings opening the itinerary, selecting **Show route**, and following the Google Maps handoff.

### OPT260813-03 — Standardize on “ADA paratransit eligibility”

**Replicate**

- Search the rendered app and run an ADA-related chat flow to capture every rider-facing variant of “ADA certified” or “ADA certification.”

**Fix**

- Define a single presentation label: **ADA paratransit eligibility**.
- Replace rider-facing copy in provider cards, chat system instructions, response validation, examples, fixtures, public/provider information screens, and administrative labels where they describe the rider concept.
- Keep internal field names such as `ada_certified` only where renaming would create needless compatibility risk; map them to the standard display term at the boundary.
- Do not rewrite historical evidence quotations or third-party source text unless it is being presented as OPTIMAT-authored copy.

**Verify**

- Repository lint/test that fails on prohibited rider-facing phrases while excluding archival data and verbatim sources.
- Chat tests for positive, negative, and unknown ADA paratransit eligibility states.
- Manual pass through chat, provider card, directory, and provider portal.

**Visual proof:** paired screenshots of every affected UI surface, assembled into one before/after contact sheet; paired chat recordings for an eligibility conversation.

### OPT260813-04 — One Seat Ride must not appear for a single-provider-area trip

**Replicate**

- Use Lafayette → Martinez and verify both endpoints are inside County Connection’s service area.
- Also run a known cross-agency trip as a control.

**Fix**

- Close this ticket through the broader One Seat retirement in OPT260810-02 and retain regression coverage proving it cannot appear in either scenario.
- For a trip covered by one agency, recommend that agency normally.
- For a cross-area trip, identify the applicable endpoint agencies and explain that the rider should call the originating paratransit agency to coordinate the connection. Do not synthesize a separate One Seat provider or fare.
- Return diagnostic reason codes so tests and support logs can distinguish `single_provider_covers_trip`, `cross_agency_connection`, and `no_participating_connection`.

**Verify**

- Table-driven geography tests: Lafayette → Martinez, same-area boundary cases, each supported cross-agency pairing, overlapping agencies, and points outside the network.
- End-to-end chat assertion that County Connection is recommended for Lafayette → Martinez without One Seat Ride.

**Visual proof:** paired screenshots of Lafayette → Martinez results; paired recordings showing the same-area case and the cross-area control.

### OPT260813-05 — Correct Tri Delta Transit fixed-route service-area map

**Replicate**

- Capture the current Tri Delta polygon at a county-wide zoom and at the reported incorrect boundary locations.
- Record the current source URL, import timestamp, provider ID, and geometry checksum.

**Fix — blocked pending Joshua’s confirmation**

- Obtain the authoritative fixed-route coverage source and an effective date from Joshua.
- Compare it with the current regional GeoJSON, document added/removed areas, validate coordinate order and geometry type, and repair invalid polygons if necessary.
- Update only Tri Delta Transit fixed-route geometry; do not change TDT ADA or senior paratransit areas unless separately confirmed.
- Store source attribution and retrieval date so future updates are auditable.

**Verify**

- Geometry validity and point-in-polygon tests using confirmed inside, outside, and boundary points.
- Confirm affected provider recommendations change only where the authoritative geometry changed.
- Stakeholder sign-off on a before/after overlay.

**Visual proof:** paired county-wide and boundary-detail screenshots plus a short before/after map-pan recording. Mark the after artifact **pending confirmation** until Joshua signs off.

### OPT260813-06 — Phone-compatible interface

**Replicate**

- Record the primary trip flow at 320×568, 375×667, 390×844, and 430×932, plus landscape phone orientation.
- Document horizontal overflow, unreadable type, map/chat contention, touch targets, keyboard obstruction, scrolling, modal fit, and route/provider-card behavior.

**Fix**

- Switch below 768 px to a single-column, chat-first layout and do not mount the map.
- Keep provider and fixed-route details inline in chat; ensure no action depends on map selection.
- Use at least 16 px composer/input text to avoid mobile browser zoom, readable message/card type, 44×44 px touch targets, safe-area padding, and a modal layout that fits above the software keyboard.
- Preserve the existing resizable map/chat layout on tablets/desktops unless testing shows the breakpoint should move.

**Verify**

- Responsive automated checks for overflow, hidden map, touch-target sizing, and composer visibility.
- Real-device or device-emulation passes on iOS Safari and Android Chrome, including voice input permissions, rotation, long results, and the on-screen keyboard.
- Accessibility pass for zoom, focus order, screen reader labels, contrast, and reduced motion.

**Visual proof:** paired screenshots at every required viewport and paired end-to-end recordings on one iPhone-sized and one Android-sized viewport.

### OPT260817-01 — Move “Save as Example” to the end of a chat

**Replicate**

- Capture a new/empty chat and an active conversation showing the persistent header action.

**Fix**

- Remove **Save as Example** from the top status bar.
- Render it once at the bottom of the message history only after the conversation has at least one rider message and a completed assistant response.
- Do not show it during loading, an empty chat, example playback, or a failed/incomplete response.
- Keep the existing save modal and refresh behavior; ensure the action remains reachable by keyboard and does not cover the composer.

**Verify**

- Component/UI tests for empty, in-progress, completed, failed, saved, and example-playback states.
- Confirm the button scrolls naturally with the conversation and is not sticky.

**Visual proof:** paired screenshots of the top bar and completed chat end; paired recordings from new chat through completion and save.

## Implementation order

1. Freeze reproducible fixtures and capture all baseline evidence from `origin/master`.
2. Record the decided One Seat, WestCAT, fixed-route, and mobile behavior in acceptance fixtures; obtain Joshua's Tri Delta source confirmation independently.
3. Apply shared provider-data/schema changes: operating status, One Seat retirement or cross-area model, WestCAT notice, fixed-route eligibility cleanup, and source metadata.
4. Correct back-end provider filtering and fixed-route response contracts; add unit and regression tests.
5. Update rider-facing terminology, cards, chat behavior, and Save as Example placement.
6. Implement the approved phone layout.
7. Apply the confirmed Tri Delta geometry last so it can be reviewed independently.
8. Run type checks, unit tests, chat regressions, provider API tests, and browser/device tests.
9. Capture after evidence using the exact baseline scenarios, create contact sheets/recordings, and obtain Joshua/product sign-off where required.
10. Deploy database and back-end changes before or atomically with the front end, then repeat smoke tests in production.

## Definition of done

- Every ticket has a reproducible test case and passes its acceptance checks.
- Every ticket has before/after screenshots; interaction-dependent tickets also have before/after recordings.
- One Seat is absent as a standalone provider, while cross-area results direct riders to the appropriate coordinating agency or agencies without inventing a fixed fare.
- WestCAT and Tri Delta changes cite an authoritative source or named stakeholder approval.
- Desktop behavior remains intact and the approved phone view works without horizontal scrolling or map dependency.
- Production smoke tests match staging, and all evidence links are attached to their corresponding tickets.
