# Required rider facts, disability filtering and chat context limits

Deployed to `optimat-prod-v2-chat` (`us-west-1`) on 2026-10-08 at 18:43:37 UTC
(11:43:37 America/Los_Angeles). API route: `POST https://api.optimat.us/chat`.

## Behavior

- Exact age and residence city are mandatory before searching or assessing trip
  options. Both the tool schema and server checks enforce this. Known facts are
  reused; a pickup address is not treated as residence. A refusal leaves the
  search incomplete rather than allowing unassessed recommendations.
- `disabled=false` removes services classified as `ADA Paratransit` (including
  the legacy `ADA-para` spelling). Non-ADA services are not removed just because
  their requirements mention ADA documentation. The assessment path also applies
  this rule to stale candidates or incorrect model verdicts.
- `disabled=true` does not remove options on disability or ADA approval grounds.
  Unknown or negative ADA approval may require provider verification, but the
  option remains visible. Independent age, residence, geography, service hours,
  and other requirements still apply. Ineligible model verdicts identify their
  exclusion basis; unsupported disability/ADA exclusions are retained for provider
  verification. No ADA eligibility or approval question is generated.
- Pending verification results no longer trigger the misleading no-provider
  geographic-failure response. Eligibility exclusions are described separately.
- Model-only serialization removes map fields, raw imported data and GeoJSON
  objects recursively, including JSON-encoded nested records. Application data
  used for maps and stored tool results are retained.
- History retains recent complete exchanges within 24,000 bytes. Individual tool
  results are limited to 60,000 bytes and every complete model request, including
  tools and accumulated tool messages, is checked against 160,000 bytes. Oversized
  results are not silently truncated: a controlled incomplete-search response
  replaces a model context-overflow error. Incoming messages are limited to 16,000
  bytes. These are conservative byte budgets, not token-count estimates.

## Verification

- `npm test`: 28 tests passed.
- `npm run check`: TypeScript passed.
- `git diff --check`: passed.
- Built CommonJS bundle loads with Node.js 24 and validates malformed requests.
- Local full-handler tests mock database, location and Bedrock boundaries; they
  perform no production calls. They cover the supplied Walnut Creek prompt,
  mandatory facts despite an incorrect model response, and the supplied
  Pinole-to-Berkeley prompt with large synthetic geometry and ADA exclusion
  correction. An oversized non-geometry result returns a controlled response
  without sending another Bedrock request.
- Further local regressions cover age/residence omissions, refusal, negative and
  positive disability answers, volunteered ADA status, independent residence
  exclusions, large raw/JSON map payloads, long history and accumulated requests.
- AWS reports `State=Active`, `LastUpdateStatus=Successful`; its code SHA-256
  matches the tested ZIP: `YhOwMxHJoN/qAAX9pw/TNmRNrDHR2WDw3yAaFIDNLyU=`.
- A new synthetic QA conversation sent only the original Walnut Creek trip to
  production. Its response asked both age and residence city before searching,
  and did not ask about ADA eligibility. No disability-bearing production test
  was sent, respecting the user's earlier preference. The Pinole regression is
  verified locally with mocks, not as a fresh live Bedrock/provider-data replay.

## Deployment artifacts

Ignored directory: `infra/.aws-sam/rider-policy-fix-20261008/`.
It contains `chat.zip`, a hash-verified `rollback.zip`, `before.json`, `update.json`,
`after.json`, `smoke-turn-1.json`, and the synthetic QA conversation identifier.
The update used the previous revision ID to protect against concurrent changes.
No Lambda configuration, other function, frontend or database schema was changed.

Previous code SHA-256: `NcBp0SdJIHBRRuzetjwk7uoqe7ZUy62a5foFailIFCg=`.
Rollback, if needed, uses the saved `rollback.zip` with `update-function-code`
after checking the current production revision. No rollback was run.
