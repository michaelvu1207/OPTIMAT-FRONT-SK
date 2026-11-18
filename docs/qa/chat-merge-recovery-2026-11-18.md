# Chat merge recovery — November 18, 2026

The working tree combined the unpublished One Seat, travel-date, and typed-refusal changes with commit `a2ac0cb`. Integration had removed calls that updated and reused clarified trip times, and state serialization omitted the resolved travel date. The backend type check passed, but three of 141 regression tests failed.

Restored the trip-time update, model context, known-time guard, pending-time recording, and duplicate-choice suppression. Travel dates are now serialized alongside rider facts and trip times. Calendar conflicts take precedence over time clarification so the date question is not overwritten.

Added stateful coverage proving that the resolved date, clarified pickup time, and typed refusal survive together across subsequent turns, plus coverage for simultaneous date and time ambiguity. Backend TypeScript validation and all 143 backend tests pass. The existing One Seat and rider-correction regressions remain passing.

The full legacy provider-import test still requires a developer-local CSV at a macOS path. Targeted One Seat import checks can run without that fixture. Historical November 16 release reports describe those deployments; they do not establish that this recovered source version is deployed. No production deployment or browser verification was performed during this recovery.

## Follow-up verification and production deployment

The user subsequently supplied the validation CSV containing 31 records. The original provider-cleaning test passed with only its input path replaced in memory; neither the CSV nor repository source was changed for that run.

Source commit `7e1baff` was deployed to `optimat-prod-v2-chat` in `us-west-1` at `2026-11-18T20:32:34Z`. AWS reported Active / Successful, and the code SHA-256 matched the tested deployment ZIP: `NcqOe2mDqAmImU9Zas78U+G+rJyFRWnwsHy8Y6rt0sA=`. The previous production package was downloaded and hash-verified before replacement. Deployment artifacts and full API responses are retained under ignored `infra/.aws-sam/chat-recovery-20261118/`.

Production API verification passed:

- The original Richmond/San Pablo to Walnut Creek trip returned One Seat as verification-required alongside Mobility Matters, with November 20, 2026 as next Friday.
- Two subsequent turns preserved that date; the typed disability refusal stayed declined, including a follow-up that did not repeat the date or refusal.
- The Walnut Creek control excluded One Seat and retained LINK as verification-required.
- An ambiguous noon request produced time choices. After the pickup clarification, a later reminder reused noon without repeating time choices.

These checks used synthetic QA conversations and validated API responses and attachments. Browser rendering was not tested. No provider records or Lambda configuration were changed.
