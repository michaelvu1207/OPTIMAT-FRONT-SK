# One Seat production deployment and live verification

Deployed the chat backend to `optimat-prod-v2-chat`, `us-west-1`, through the `optimat-dev` profile. AWS reports Active / Successful. Configuration and provider records were not changed. The public frontend uses this backend; no frontend or Supabase deployment was needed.

The deployed ZIP SHA-256 matches `E9sLl81vUdPu+9nEwv54XIWCJg9sytMDWxNOG6b94m0=`. The prior package, metadata, tested ZIP, full QA responses, and assertion summary are retained under ignored `infra/.aws-sam/one-seat-20261116/`. The update used the previous revision to prevent concurrent overwrites. Rollback is available as `rollback.zip` and requires reading the current revision before updating.

Local validation: 115 backend tests passed; backend TypeScript check passed; targeted One Seat import checks passed. The legacy full import test requires an unavailable developer-local CSV fixture.

Live requests used `https://api.optimat.us` and separately labelled QA conversations:

- `d104df2d-9823-42f0-af41-750e1f37429b`: the requested 3815 Lakeside Dr Building F to 365 Lennon Ln trip, San Pablo resident, age 65+, noon outbound and 3 PM return. After supplying the explicit date November 20, 2026 and the structured declined disability answer, a fresh search returned One Seat and Mobility Matters. Regional diagnostics were west → central. One Seat was in `verification_required` with (925) 680-2134, variable fare guidance, and confirmation instructions. AWS geocoding labels the origin street address San Pablo rather than Richmond and omits Building F; exact pickup remains a booking confirmation.
- `68d4e7eb-c631-43e8-8c9f-e77e16faade6`: 365 Lennon Ln to 1601 Civic Dr, both Walnut Creek, on November 20 at the same times. Diagnostics were central → central / `single_agency_covers_trip`; One Seat was absent, and LINK remained available subject to eligibility verification.
- `c771d32a-3999-43ee-b607-e6ed30a0bfc9`: general One Seat lookup invoked `get_provider_info` and returned the booking phone and origin-dependent fares. It initially asked an unnecessary clarification, then answered the general-information follow-up correctly.

Assertions verify the final search date, regional classification, One Seat verification status, booking phone, variable fare, saved declined answer, same-agency suppression, retained LINK, and lookup tool use. These are live API tests, not a visual browser check or confirmation of transport availability.

## Separate issues found, not fixed by this deployment

Subsequent status: both issues below were fixed and deployed in the [date/refusal follow-up release](date-refusal-release-2026-11-16.md). The following paragraphs describe the original One Seat release test findings.

The model initially called November 21, 2026 a Friday and later incorrectly challenged November 20 as Thursday. Explicit ISO date `2026-11-20` produced the correct search. Relative-date/weekday interpretation still needs correction.

A typed sentence saying “I would rather not say whether I have a disability” was incorrectly recorded as `yes`. The structured “Would rather not say” choice correctly saved `declined`; the final trip search was rerun with that saved answer. Free-text refusal interpretation still needs correction. The test results must not be represented as an entirely clean end-to-end intake flow.
