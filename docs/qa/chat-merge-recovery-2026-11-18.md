# Chat merge recovery — November 18, 2026

The working tree combined the unpublished One Seat, travel-date, and typed-refusal changes with commit `a2ac0cb`. Integration had removed calls that updated and reused clarified trip times, and state serialization omitted the resolved travel date. The backend type check passed, but three of 141 regression tests failed.

Restored the trip-time update, model context, known-time guard, pending-time recording, and duplicate-choice suppression. Travel dates are now serialized alongside rider facts and trip times. Calendar conflicts take precedence over time clarification so the date question is not overwritten.

Added stateful coverage proving that the resolved date, clarified pickup time, and typed refusal survive together across subsequent turns, plus coverage for simultaneous date and time ambiguity. Backend TypeScript validation and all 143 backend tests pass. The existing One Seat and rider-correction regressions remain passing.

The full legacy provider-import test still requires a developer-local CSV at a macOS path. Targeted One Seat import checks can run without that fixture. Historical November 16 release reports describe those deployments; they do not establish that this recovered source version is deployed. No production deployment or browser verification was performed during this recovery.
