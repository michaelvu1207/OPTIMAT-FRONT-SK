# October 27 focus group release — November 4, 2026

This release contains the pending local follow-ups documented in focus-group-followups-2026-11-03.md, cross-city-coverage-2026-11-03.md and the exact-age QA follow-up. It updates the chat Lambda and Amplify frontend; it does not change provider records or add paid external APIs.

Changes include matched composer button heights, a persistent no-booking notice, the scoped mobile greeting, collapsed provider details, pickup/arrival choices, transit/cycling route-planner links, evidence-based cross-city explanations, exact-age checks, unknown membership billing notices, internal named municipal-pass lookups, compound-question rejection, and concise availability guidance. Application requirements recorded as unknown must remain unconfirmed in prose; enrollment does not waive booking notice.

Pre-release checks: 100 backend tests; frontend and backend type checks; production frontend build; secret scan; previously recorded mocked browser regressions for provider disclosures, trip choices, cross-city explanations and ten viewport sizes. The age screenshot from the manual replay did not reproduce an old failure and remains a baseline rather than an error example.

The chat package was built for the existing Node.js 24 CommonJS index.handler runtime. Update used the existing RevisionId to avoid concurrent changes. Previous code is retained locally under /tmp/optimat-release-2026-11-04/rollback.zip. Lambda configuration, credentials and provider data were not modified.

Source of Before slides: the user’s revised OPTIMAT_Fix_Oct_27 PDF. Page 5 now uses a readable cropped provider-details screenshot; page 11 now correctly shows Self Access without a fee period. The stray opening parenthesis in page 5 text is a minor editorial correction. After screenshots must be captured from the released application using matching prompts and viewport sizes.
