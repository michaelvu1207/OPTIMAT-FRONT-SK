# Provider age ranges

Source: user-supplied `optimat_providers_2026-09-07.xlsx - providers.csv`, reviewed November 2, 2026. The file has 35 rows, including 31 named providers and four unnamed rows. This change uses its eligibility cutoffs to design questions; it does not import or change provider records or reactivate retired services.

| Cutoff | Examples in the supplied eligibility text |
| --- | --- |
| 18+ | LINK, WestCAT Paratransit, Wheels Dial-a-Ride, TDT ADA; disability alternatives in several city programs |
| 50+ | San Pablo Senior & Disabled Transportation |
| 55+ | R-Transit, Senior Express Van, Pleasant Hill Van Service |
| 60+ | Easy Ride, Mobility Matters, Lamorinda Spirit, Walnut Creek Mini Bus and Lyft programs |
| 65+ | WestCAT Senior Dial-A-Ride, TDT Senior Paratransit, GoGo Concord, Concord Senior Center Shuttle |

The resulting choices are **Under 18**, **18–49**, **50–54**, **55–59**, **60–64**, and **65+**. Each explicit cutoff falls on a band boundary. `65+` has no assumed upper limit. A voluntarily supplied exact age continues to work.

The server stores the selected band as `rider_eligibility.age_range`, never as a representative exact age. The model receives the full interval. A later band selection replaces a previous exact age. Explicitly recognized typed bands also work. Broad descriptions such as “in my 60s” are not silently narrowed to one band.

The chat provides an `age_choices` attachment through `ask_age_range`, with a fallback for a model's prose age question or a search attempted without age information. Buttons send both a readable chat confirmation and a validated band identifier, preserve unsent drafts, show pending/selected states, and allow retries.

Eligibility still depends on residence, disability, veteran status, geography, schedules, and provider decisions. Numeric checks compare the entire interval and preserve alternative age-category pathways. A future cutoff within a band remains subject to provider verification. Unrecognized rules are not automatically converted to exclusions. An unnumbered “Senior” rule, such as Seniors Around Town's, must not be assigned an invented cutoff.

Validation: backend age-boundary, alternate-category, stored-state, and handler tests; browser checks for keyboard/button selection, draft preservation, retries, narrow screens, and new-chat reset; existing address-selection and accessibility regressions; frontend/backend type checks and production build.

## Exact-age follow-up — November 3, 2026

The final eligibility guard previously ran only for age-band selections. A deliberately incorrect model verdict could therefore retain a senior-only service for a rider who volunteered an exact age below its minimum. The guard now uses the existing age bounds for both input forms. It still preserves disability and veteran alternatives, leaves unspecified senior thresholds for provider confirmation, and does not override exclusions based on independent residence requirements.

Regression cases reproduced the failure before the fix and now cover exact ages 55, 59, 60, 64 and 65, adult minimums on disability alternatives, known and unknown alternative facts, and unspecified senior requirements. All 93 backend tests and the backend TypeScript check passed. This follow-up is local and has not yet been deployed.
