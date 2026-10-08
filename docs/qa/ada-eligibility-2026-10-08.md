# ADA eligibility question fix — production deployment

Deployed on 2026-10-08 at 18:24:34 UTC (11:24:34 America/Los_Angeles).

## Cause and change

Production `POST https://api.optimat.us/chat` routes to `optimat-prod-v2-chat` in
`us-west-1`. Its previous code was last updated on 2026-08-31 and still instructed
the assistant to collect `disabled/ADA paratransit eligibility`. The later local
prompt change had not reached that Lambda. Amplify's repository configuration
builds the frontend; it does not deploy the chat Lambda.

The local eligibility tool also still selected `ada_paratransit_eligible` as a
follow-up question. This update removes ADA approval from the model's available
`missing_fact` choices and makes the server skip it even in older model outputs.
Unknown ADA approval remains a provider verification requirement, not automatic
eligibility or a question for the rider. Voluntarily supplied ADA status remains
usable. The system prompt and tool descriptions explicitly reinforce this policy.

The current local chat source was bundled with esbuild for Node.js 24, CommonJS,
using `index.handler` to match the existing production configuration. The
`model-payload` import was changed to `.js` to match the project's TypeScript
module-resolution convention. No Lambda configuration or other function was
updated.

## Verification

- `npm test` in `infra`: 14 tests passed, including three new regression tests.
- `npm run check` in `infra`: passed.
- `git diff --check`: passed.
- Bundled handler loaded and returned HTTP 400 for missing request fields.
- AWS reported `State=Active`, `LastUpdateStatus=Successful`.
- AWS code SHA-256 matched the exact tested ZIP:
  `NcBp0SdJIHBRRuzetjwk7uoqe7ZUy62a5foFailIFCg=`.
- A new conversation marked as synthetic QA received the reported Dogwood Drive
  to Lennon Lane trip through the production API. The response asked about age,
  disability, veteran status, residence, companions and mobility aids; it did not
  ask about ADA eligibility or approval. This first turn did not invoke provider
  assessment tools, so it does not establish a full live assessment regression.
- A proposed second production turn with a fictional rider's disability status
  was blocked by automatic approval review and was not sent. The user then chose
  to rely on the existing verification and not send that turn. The corresponding
  server-side assessment paths were verified locally, including preserving
  verification status and not inferring ADA approval from disability.

## Deployment and rollback artifacts

Ignored local artifacts are in `infra/.aws-sam/ada-eligibility-fix-20261008/`:

- `chat.zip`: deployed code.
- `rollback.zip`: previous production code, saved before the update.
- `before.json`, `update.json`, `after.json`: deployment metadata.
- `smoke-turn-1.json`: first live response.
- `smoke-conversation-id.txt`: synthetic QA conversation identifier.

Previous code SHA-256: `I88motW2ItsGXaFQ5vULSQ3zHxck+tp3Emg7IH9M0rA=`.
The update used the previous revision ID to protect against concurrent changes.
If rollback is needed, use `rollback.zip` with `update-function-code` for
`optimat-prod-v2-chat`, after checking the current revision. No rollback was run.
