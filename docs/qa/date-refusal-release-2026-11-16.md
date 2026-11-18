# Date and typed-refusal fixes — production verification

Deployed to `optimat-prod-v2-chat` in `us-west-1` on November 16, 2026 at 08:48:07 UTC. The deployment reported Active / Successful and its SHA-256 matched the locally tested ZIP: `RSJZzd7hjhQHO0bKwmDhEqTmLVYXnhlStC5KrlxP+lI=`. This package retains the One Seat changes. No frontend deployment or provider database update was necessary.

The backend now resolves supported travel-date phrases using the America/Los_Angeles calendar, saves the result across turns, and uses it instead of model-generated search dates. “Next Friday” means the next occurrence of Friday. Real calendar conflicts request clarification. Impossible weekday/date claims in draft replies trigger a repair attempt, followed by a deterministic verified-date response if needed; provider attachments remain available.

Typed answers are evaluated by clause. Refusals take precedence over embedded phrases such as “I have a disability” inside “whether I have a disability.” A refusal sets the fact to unknown, saves `declined`, prevents model arguments from overriding it, and supports a later explicit rider correction.

Validation: backend TypeScript check and all 128 backend tests passed. Tests cover DST/calendar boundaries, invalid dates, model argument overrides, persistence, response repair, the exact reported refusal, hypothetical statements, independent facts, and explicit corrections.

Live API evidence is saved under ignored `infra/.aws-sam/date-refusal-20261116/` alongside the deployment metadata, ZIP, and rollback ZIP:

- Conversation `7b44cc77-8336-418c-9cf4-9f500c30986b`: the original trip wording with “next Friday” immediately returned Friday, November 20, 2026. The next turn used the exact typed refusal, without a button or date correction. It saved `declined`, searched November 20, and retained One Seat as verification-required alongside Mobility Matters. Follow-up searches retained the date and refusal. One follow-up exercised the verified-date fallback; the latest public API recheck returned the full recommendation text and correct date.
- Conversation `a89a74cf-750f-447b-984f-ca57682610e1`: the same-agency Walnut Creek control resolved November 20 without correction, suppressed One Seat, and retained LINK subject to eligibility verification.

During the later status recheck, AWS SSO had expired, so a fresh control-plane version query was unavailable. The original successful deployment/hash evidence remains saved, and the public production API was re-tested successfully. No redundant deployment was performed. These are live API tests, not visual browser verification or ride-availability confirmation.
