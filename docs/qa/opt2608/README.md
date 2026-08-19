# OPT2608 Verification Evidence

Baseline: `origin/master` at `2bd1b6d`  
After state: current working tree on 2026-08-18  
Desktop viewport: 1440×900  
Phone viewport: 390×844  
Browser: Playwright Chromium, deterministic mocked API responses

Combined comparison: [all eight issues](OPT2608-before-after-all-issues.mp4) (64 seconds, 1080p)

The evidence harness is `tests/chat/opt2608-visual-evidence.mjs`. It drives the same trip in both builds and asserts the expected before/after behavior before saving artifacts.

| Ticket | Result | Before | After | Video |
| --- | --- | --- | --- | --- |
| OPT260810-02 | One Seat Ride retired as a standalone provider; fixed fare removed | [image](before/OPT260810-02-one-seat.png) | [image](after/OPT260810-02-one-seat.png) | [before](before/OPT260810-02-and-OPT260813-04-trip-flow.webm) · [after](after/OPT260810-02-and-OPT260813-04-trip-flow.webm) |
| OPT260813-01 | WestCAT local trips show 1–3 days; regional ADA trips show up to 14 days | [image](before/OPT260813-01-westcat.png) | [image](after/OPT260813-01-westcat.png) | Covered by trip-flow recording |
| OPT260813-02 | Fixed route uses a Google Maps handoff when no real itinerary geometry exists; no straight route substitute | [image](before/OPT260813-02-fixed-route.png) | [image](after/OPT260813-02-fixed-route.png) | Covered by trip-flow recording |
| OPT260813-03 | Rider-facing terminology standardized to “ADA paratransit eligibility” | [image](before/OPT260813-03-ada-terminology.png) | [image](after/OPT260813-03-ada-terminology.png) | Covered by trip-flow recording |
| OPT260813-04 | Same-area and cross-area logic no longer synthesize One Seat as a provider; cross-area diagnostics name coordinating agencies | [image](before/OPT260813-04-one-seat-logic.png) | [image](after/OPT260813-04-one-seat-logic.png) | [before](before/OPT260810-02-and-OPT260813-04-trip-flow.webm) · [after](after/OPT260810-02-and-OPT260813-04-trip-flow.webm) |
| OPT260813-05 | Unapproved Tri Delta fixed-route polygon quarantined from public display while retained for audit; authoritative replacement still requires Joshua’s approval | [image](before/OPT260813-05-tri-delta-pending.png) | [image](after/OPT260813-05-tri-delta-pending.png) | Static map/data correction |
| OPT260813-06 | Phone view is chat-first, does not mount the map, and has no horizontal overflow | [image](before/OPT260813-06-mobile-layout.png) | [image](after/OPT260813-06-mobile-layout.png) | [before](before/OPT260813-06-mobile-layout.webm) · [after](after/OPT260813-06-mobile-layout.webm) |
| OPT260817-01 | Save as Example removed from the header and shown after a completed exchange | [image](before/OPT260817-01-save-example.png) | [image](after/OPT260817-01-save-example.png) | Covered by trip-flow recording |

## Automated verification

- `npm run check` — 0 errors; one pre-existing accessibility warning in `ProviderPortalTripUpload.svelte`.
- `deno test --allow-env --allow-net supabase/functions/chat/trip.test.ts supabase/functions/chat/state.test.ts supabase/functions/chat/responses.test.ts supabase/functions/chat/tools.test.ts` — 59 passed.
- `node scripts/provider-cleaning.test.mjs` — passed.
- `node scripts/service-area-resolver.test.mjs` — passed.
- `npm run test:terminology` — passed.
- `npm run check --prefix infra` — passed.
- Browser verification — updated page renders with content, no Vite error overlay, mobile map count is zero, and 390 px horizontal overflow is false.

## Tri Delta disposition

The official [Tri Delta Transit system map](https://www.trideltatransit.com/local-and-express-routes/system-map/) documents the route network but does not publish an authoritative service-area polygon. The implementation therefore keeps the existing geometry in the database for comparison, removes it from public map/service-zone responses, labels the area as needing review, and routes riders through itinerary/Google Maps behavior. A replacement geometry should be released only after Joshua approves its source and boundaries.
