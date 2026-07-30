# OPTIMAT Supabase-to-AWS Backend Migration Plan

**Date:** 2026-07-29
**Status:** Execution in progress; AWS green stack and full-data rehearsal complete
**Scope:** Migrate every production dependency on the OPTIMAT Supabase project to AWS, prove behavioral and data parity, cut over safely, and retire Supabase.

## 1. Executive recommendation

Use the existing AWS prototype only as a source of reusable code. Rebuild it into a production-grade, version-controlled AWS stack with:

- Amazon Aurora PostgreSQL Serverless v2 with multi-AZ durable cluster storage, one cost-optimized writer initially, RDS Proxy only if the connection-load test justifies it, private subnets, encrypted storage, deletion protection, and tested point-in-time recovery.
- API Gateway and Node.js 24 Lambda functions for the REST-style APIs.
- A short architecture spike for chat streaming. Prefer Lambda response streaming through a private Lambda Function URL behind CloudFront and WAF if it passes the 60-second, SSE, and disconnect tests; otherwise run the chat endpoint on ECS Fargate behind an ALB. Do not cut over chat through the current non-streaming HTTP API integration.
- AWS IAM Identity Center as the workforce identity source, federated through Cognito for browser/API JWTs, plus API Gateway JWT authorizers for provider/admin mutations. Every active human identity assigned access within the AWS organization receives OPTIMAT admin access; service principals and raw IAM credentials do not. Public read and rider-chat routes remain deliberately public but rate-limited and bound to an anonymous session, not to a database-wide public credential.
- Secrets Manager and workload IAM roles. No long-lived AWS access keys in Supabase, source code, developer `.env` files, or CI.
- CloudWatch, X-Ray/OpenTelemetry, WAF, CloudTrail, alarms, dashboards, backup/restore tests, and cost budgets.
- GitHub Actions using AWS OIDC for CI/CD, with separate dev, staging, and production stacks.

Deploy the replacement as a parallel green stack with new names and a canary hostname. Do not update the stale `optimat-api` stack in place until its resource drift, DNS/load-balancer ownership, and any unknown consumers are understood. Adopt or delete old resources only after traffic evidence proves they are unused.

The approved migration objective is zero data loss with minimized downtime. Use a native PostgreSQL schema export plus AWS DMS full-load and continuous change-data-capture (CDC). At cutover, enforce a short database-level write fence, record the source log position, wait for DMS lag to reach zero, validate the target, switch traffic, and only then enable AWS writes. `pg_dump`/`pg_restore` remains the rehearsed fallback if Supabase cannot provide the logical-replication settings required by DMS, but that fallback requires a longer read-only window.

### Execution amendment — 2026-07-30

Live validation proved that Supabase exposes `wal2json` but not the `pglogical` or `test_decoding` output plugins supported by AWS DMS. The dual-stack DMS endpoints and target connection were proven, but source CDC was therefore abandoned before cutover and the temporary DMS instance was deleted to stop cost. The zero-loss mechanism is now a reviewed dual-stack Lambda synchronizer: it opens a repeatable-read source snapshot, replaces all 20 target tables inside one Aurora transaction with foreign-key triggers disabled for that transaction, and commits only after exact per-table row-count verification. The full rehearsal copied and verified all tables, including 151,390 manifest rows, in approximately 22 seconds. Production cutover requires the Supabase write fence before invoking `sync-all`; without `confirm_write_fence=true`, the function refuses the final action.

The green stack is live in `us-west-1`: Aurora PostgreSQL 17.7 Serverless v2, API Gateway, all 16 Lambda function equivalents, Amazon Location replacing the invalid Google credential, Amazon Transcribe replacing the missing OpenAI credential, an indefinite versioned S3 archive, and organization-scoped read access. The remaining production gates are the Amplify AWS-backend build, fenced final sync, production frontend promotion, post-cutover observation, Identity Center delegated-administrator access, and the 30-day Supabase rollback window.

## 2. Decisions required before implementation

These are approval gates, not reasons to delay the inventory and security work:

1. **Availability target — resolved:** planned-cutover RPO is zero and downtime should be minimized. Use the rehearsed transactional full sync plus a brief final write fence; the measured data-copy window is approximately 22 seconds.
2. **Data classification — resolved:** no HIPAA or other regulated-data obligation is currently expected. Rider addresses, eligibility/disability statements, trip data, conversations, and audio must still receive normal sensitive-data controls and documented retention.
3. **Cost versus availability — resolved:** choose the lowest practical monthly cost. Start with one Aurora writer, one NAT gateway, no reader/failover instance, and minimum safe capacity established by load test. Accept longer compute recovery during an AZ/instance failure while retaining Aurora's multi-AZ durable storage and PITR. Revisit HA when usage or business criticality grows.
4. **Identity policy — resolved:** every active human identity with access assigned through the AWS organization's IAM Identity Center may use all OPTIMAT provider/admin functions. Federate Identity Center into Cognito so the browser receives short-lived application JWTs; do not give the browser IAM keys or direct database access. Record the individual Identity Center subject on every administrative mutation.
5. **Retention — resolved:** retain application data for as long as the AWS organization exists unless an authorized owner explicitly deletes it. Apply no automatic expiration to conversations, messages, tool calls, states, feedback, trip data/uploads, transcripts, or raw audio. Keep recent data online and transition older/high-volume objects to encrypted S3 Glacier tiers to minimize cost while preserving retrieval.

All five initial product decisions are resolved. This plan assumes `us-west-1`, a rehearsed transactional sync with a brief scheduled write fence, no current use of Supabase Auth/Storage/Realtime, and a 30-day read-only Supabase rollback period.

### Cost guardrails selected

- Keep a single production NAT gateway initially; accept it as an egress single point of recovery rather than paying for one per AZ.
- Keep one Aurora Serverless v2 writer at the lowest ACU floor that passes latency and concurrency tests. Do not provision a reader until failover requirements justify it.
- Benchmark direct TLS database connections with reserved Lambda concurrency against RDS Proxy. Remove the proxy if direct connections pass burst tests with safe headroom; retain it if connection exhaustion is a realistic risk.
- Auto-pause or tear down nonproduction databases and compute outside active test windows. Keep verbose operational/debug logs on a short, explicit CloudWatch retention period, but archive required audit logs and application records to S3/Glacier with no expiration.
- Retention must not force all history to remain in costly Aurora storage. Archive cold records and original audio/upload objects to versioned, encrypted S3, transition them to Glacier Flexible Retrieval/Deep Archive, and maintain indexed manifests and checksums for retrieval.
- Price a consolidated Fargate API that avoids NAT against Lambda + NAT before finalizing compute. Switch only if the measured monthly saving exceeds the added porting and operating cost.
- Set an initial AWS monthly budget and anomaly alarm before staging load tests. Review actual cost after 7 and 30 production days.

## 3. Evidence from the current system

### Live Supabase

- The linked production project is in `us-east-2`, while the target AWS stack is in `us-west-1`. The cutover therefore also changes region and should include measured latency tests from actual users.
- Sixteen Edge Functions are active. The live set includes `feedback` and `admin-provider-advance-update`, which have no AWS port. `transcribe` has a local Lambda port but is not in the deployed AWS stack. `provider-import-admin` is an intentional 410 tombstone.
- The live `chat` function was updated on 2026-07-28; the deployed AWS Lambdas were last updated on 2026-04-03. The AWS chat copy also uses an older model and omits the current state, trip, response-verification, and tool behavior.
- The repository migration history and the remote Supabase migration history have diverged in both directions. The Aurora DDL is therefore not an authoritative schema baseline and currently omits `chat_feedback`.
- The frontend makes one direct PostgREST query for messages in addition to Edge Function calls.
- Supabase secrets include long-lived AWS credentials used to invoke Bedrock. They must be constrained immediately and removed and rotated when chat moves to AWS workload IAM.
- A public frontend credential can currently update provider records. This is a critical authorization defect independent of the migration.
- Repository configuration, frontend documentation, tests, and scripts contain hard-coded Supabase project details and public credentials.

### Existing AWS prototype

- CloudFormation stack `optimat-api` is deployed and its raw API Gateway `/health` route responds, but `https://api.optimat.us/health` currently returns 503 through a stale or unhealthy load-balancer path.
- Aurora is encrypted but currently has one writer, one day of backup retention, no deletion protection, and no CloudWatch alarms.
- The stack has one NAT gateway, hard-coded Availability Zones, permissive CORS, database master credentials for application code, and no API authorizer, WAF, custom API domain, access-log policy, or CI/CD pipeline.
- The local `infra/` tree is untracked. It fails TypeScript compilation and SAM lint. Its `nodejs20.x` runtime can no longer be updated in the current AWS lifecycle and must move to Node.js 24.
- The data migration scripts are ad hoc and include row caps, manual column reconstruction, a Lambda capable of executing arbitrary SQL, hard-coded resource names, and a hard-coded public token. They are unsuitable for production cutover.
- The API parity harness performs mutations during its default provider test. It must become non-destructive by default before it is used against either production system.

## 4. Target service map

| Supabase capability | Current use | AWS target | Migration note |
|---|---|---|---|
| PostgreSQL | Core system of record | Aurora PostgreSQL Serverless v2; RDS Proxy only if justified by load test | Preserve UUIDs, JSONB, arrays, intervals, functions, constraints, and timestamps |
| PostgREST | One direct message query; indirect access elsewhere | Lambda-owned REST API | Remove all direct browser-to-database access |
| Edge Functions | 16 deployed functions | Lambda for REST; streaming Lambda URL or Fargate for chat | Port from the latest Supabase source and prove contract parity |
| Auth | No confirmed application use | Cognito User Pool | Required for provider/admin writes even if Supabase Auth is empty |
| Storage | No confirmed application use | S3 + presigned URLs + lifecycle rules | Create only if live audit finds objects or upload retention is required |
| Realtime | No confirmed application use | None initially; AppSync or API Gateway WebSocket if discovered | Do not build an unused replacement |
| Scheduled jobs/webhooks | Not represented in repo | EventBridge Scheduler/EventBridge + Lambda/SQS | Discover from live project and migrate each job explicitly |
| Secrets | Supabase function secrets | Secrets Manager + KMS + IAM roles | Rotate third-party keys after migration and remove AWS access keys |
| Function logs | Supabase logs | CloudWatch Logs, metrics, traces, alarms | Redact prompts, addresses, tokens, and audio metadata as policy requires |
| Frontend API configuration | Supabase URL and key | Runtime API base URL, no database credential | Retain a temporary rollback endpoint selector |

## 5. Definition of done

Supabase may be retired only when all of the following are true:

- Every live Supabase function, database table, view, function/RPC, trigger, extension, policy, bucket, object, auth user, webhook, secret dependency, and scheduled job is classified as migrated or intentionally retired with approval.
- Every implicit Supabase control—RLS policy, grant, JWT claim dependency, storage policy, function JWT setting, realtime publication, rate limit, request-size limit, and platform backup/log behavior—has a documented AWS equivalent and a negative test. Functional parity alone is not sufficient.
- All production code, tests, scripts, documentation, DNS, and CI use AWS endpoints and AWS-native credentials; repository search finds no runtime Supabase dependency.
- Schema fingerprints, exact row counts, table-level checksums, foreign-key/orphan checks, min/max timestamps, and sampled JSON/GeoJSON comparisons pass after the final copy.
- Public, authenticated, and administrative API contract suites pass in staging and production canary, including SSE, multipart audio, error shapes, CORS, rate limits, authorization, cancellation, and timeouts.
- Chat regression and replay suites show no material quality regression on the same Bedrock model and settings used in production.
- Load, failover, backup restore, security, and rollback rehearsals pass with recorded evidence.
- Production has dashboards, alerts, runbooks, budgets, access logs, backup retention, deletion protection, and an on-call owner.
- AWS has operated successfully for 30 days, the final Supabase archive is verified, and Supabase credentials and project resources are revoked/deleted.
- Indefinite-retention controls are active: no lifecycle expiration for application archives, quarterly restore sampling passes, and every administrative access or deletion is attributable to an IAM Identity Center subject.

## 6. Phased execution plan

### Phase 0 — Stop current security and test hazards

**Goal:** prevent avoidable data exposure or corruption while the migration is being built.

1. Disable anonymous provider updates immediately. Require an authenticated admin/provider identity for `PUT /providers/:id`; apply equivalent restrictions to conversations, messages, examples, replay saves, trip uploads, feedback administration, and admin update functions.
2. Inventory which routes must be public, user-owned, provider-owned, or admin-only. Deny every unclassified write.
3. Change `tests/api-harness.mjs` so its default mode is read-only. Mutation tests must require `--allow-writes`, use uniquely prefixed fixtures, target staging by default, and register verified cleanup before the write.
4. Remove hard-coded tokens and resource identifiers from scripts and examples. Add secret scanning to pre-commit/CI and rotate any credential that was private or over-privileged.
5. Reduce the Supabase AWS IAM user's policy to only the required Bedrock actions/model until cutover. Record it for mandatory post-cutover rotation and deletion.
6. Take and verify a Supabase database backup before schema or RLS changes.

**Exit gate:** anonymous writes return 401/403; read-only production smoke tests cannot mutate data; secret scanning passes.

### Phase 1 — Complete the live Supabase inventory and freeze the contract

**Goal:** make the production system, not the incomplete repository history, the migration source of truth.

1. Export a timestamped, encrypted inventory from the live project:
   - PostgreSQL schemas, tables, columns, sequences, constraints, indexes, views/materialized views, functions/RPCs, triggers, extensions, grants, RLS policies, publications, replication settings, and approximate sizes/counts.
   - Auth providers/configuration and user count, without exporting user PII into logs.
   - Storage buckets, object counts/bytes, policies, and checksums.
   - Edge Function names, deployed versions, JWT settings, environment-variable names, invocation volume, p95 duration, error rate, and external dependencies.
   - Cron jobs, database webhooks, queues, realtime subscriptions/publications, custom domains, network restrictions, and log drains.
2. Capture OpenAPI-like request/response fixtures for every route and error case. Include all function versions that exist live but not locally.
3. Record the current database row counts and canonical checksums without writing raw sensitive records to logs.
4. Reconcile the remote schema into a new ordered SQL migration baseline. Do not infer the production schema solely from `supabase/migrations/` or `scripts/ddl/tables.sql`.
5. Copy all historical/internal application data. Decide which portions remain online versus move to the indefinite archive: conversations, messages, tool calls, conversation states, feedback, raw trip records, manifest reviews, examples, original uploads, transcripts, and any captured audio.
6. Build a **control-equivalence register**. For every RLS policy, role grant, auth claim, function `verify_jwt` setting, storage/realtime policy, timeout, payload limit, and retention behavior, record the current Supabase behavior, AWS replacement, owner, test, and retirement approval. Include negative tests that prove one user/provider/session cannot access another's rows.

**Exit gate:** an approved inventory manifest has exactly one disposition for every Supabase resource: migrate, archive, or retire.

### Phase 2 — Rebuild the AWS foundation as version-controlled infrastructure

**Goal:** create repeatable dev, staging, and production environments.

1. Commit and refactor `infra/` into parameterized SAM/CloudFormation nested stacks for network, data, API, security, and observability. Preserve SAM to minimize migration churn. Create a parallel green stack; first inventory CloudFormation drift and the owners/consumers of the existing API Gateway, Aurora cluster, load-balancer DNS records, certificates, and Route 53 records.
2. Remove hard-coded account IDs, function names, secret ARNs, profiles, and Availability Zones. Select AZs from parameters/mappings and use stack outputs/SSM parameters.
3. Upgrade all Lambdas to Node.js 24 and make `sam validate --lint`, TypeScript, unit tests, and `sam build` pass.
4. Build separate dev/staging/prod stacks and accounts if available. Protect production with change sets and manual approval.
5. Configure the VPC:
   - Private database/Lambda subnets in two AZs.
   - Public subnets only for NAT/ingress resources.
   - One NAT gateway as the approved cost-optimized exception; document recovery steps and the expected effect of an AZ/NAT failure.
   - VPC endpoints for Secrets Manager, CloudWatch Logs, S3, STS, and other used AWS services to reduce NAT dependence and cost.
   - Least-privilege security groups and VPC Flow Logs.
6. Configure Aurora:
   - Supported Aurora PostgreSQL version validated against every required extension.
   - One writer initially. Keep a tested runbook and IaC switch for adding a reader/failover target when requirements justify the cost.
   - A dedicated least-privilege application database user, not the master user. Use RDS Proxy only if the connection-load test demonstrates that it is necessary.
   - KMS encryption, TLS certificate verification, at least 7 days of PITR retention initially, deletion protection, maintenance windows, log export, Performance Insights/Database Insights where cost-appropriate, and alarms.
7. Replace the arbitrary-SQL `DbSetupFunction` with a VPC-connected, auditable migration job invoked only by CI. Separate schema-owner/migrator credentials from runtime credentials.
8. Configure API Gateway/CloudFront, ACM, Route 53, WAF managed rules, request size limits, throttles/quotas, structured access logs, and explicit production CORS origins.
9. Configure Secrets Manager rotation/ownership and IAM roles per function. Bedrock access uses the Lambda/ECS task role, never static AWS keys.
10. Add GitHub Actions with OIDC: lint/test/build, deploy dev, integration tests, deploy staging, approval, production change set, deploy, and post-deploy smoke test.

**Exit gate:** a clean checkout can create staging from IaC; no console-only resource is required; restore and redeploy procedures are documented.

### Phase 3 — Establish the authoritative Aurora schema and migration pipeline

**Goal:** make data movement complete, repeatable, and verifiable.

1. Convert the reconciled live schema into ordered, idempotent SQL migrations. Keep Supabase-owned schemas (`auth`, `storage`, `realtime`, etc.) out of Aurora unless the live audit proves application data must be translated.
2. Preserve application UUIDs and timestamps so foreign keys, replay fixtures, and frontend references remain stable.
3. Create least-privilege roles:
   - `optimat_migrator`: schema changes only through CI.
   - `optimat_app`: required CRUD on named application tables/functions.
   - Optional read-only analytics/support role.
   - No runtime use of the Aurora master account.
4. Build a migration command that:
   - Creates an encrypted source dump using a pinned PostgreSQL client version.
   - Restores schema and data into an empty staging database.
   - Runs post-restore grants, ownership, sequence alignment, `ANALYZE`, and required extension setup.
   - Produces a machine-readable verification report with no sensitive row contents.
   - Can be rerun from scratch without manual fixes.
5. Replace row-count limits and one-off reconstruction scripts. Preserve `TIME`, `INTERVAL`, arrays, JSONB, GeoJSON, and RPC semantics directly rather than re-encoding through REST responses.
6. Verification must cover exact counts, deterministic aggregate hashes per table/chunk, null counts per column, FK/orphan checks, sequence maxima, timestamp ranges, and targeted semantic queries for provider zones, service hours, manifests, conversations, tool calls, feedback, and trip state.
7. Create DMS full-load + CDC tasks and validate Supabase logical replication, WAL retention, replication-slot, network/TLS, and source-plan support before relying on the zero-loss objective. Allow only the DMS source address rather than opening the database broadly.
8. Freeze production DDL from the start of the final full load through cutover; DMS is not the schema migration authority. Inventory tables without primary keys or replica identity—especially append-only/raw trip tables—and add a safe key/`REPLICA IDENTITY FULL` or a separately verified migration path so updates/deletes cannot be silently missed.
9. Record and compare source LSN, DMS checkpoint, per-table validation status, CDC latency, rejected-row logs, and target sequence values. The cutover may proceed only after the write fence is active, CDC lag is zero, rejected changes are zero, and the independent checksum report passes.

**Exit gate:** three consecutive staging migrations from fresh infrastructure produce identical verification reports and no manual repair step.

### Phase 4 — Port every backend capability from current source

**Goal:** reach behavioral parity without carrying Supabase client semantics into the new backend.

1. Treat the latest `supabase/functions/` code as the reference. Extract domain logic into runtime-neutral TypeScript modules, with PostgreSQL/AWS adapters at the boundary.
2. Port and test the full live endpoint set:
   - `health`
   - `geocode`
   - `directions`
   - `providers`, including map, search, filter, service-zone, and authorized update
   - `conversations`
   - `messages`
   - `chat`
   - `transcribe`
   - `tool-calls`
   - `chat-examples`
   - `replay`
   - `trip-records`
   - `tri-delta-transit`
   - `feedback`
   - `admin-provider-advance-update`, redesigned as a protected admin operation
   - `provider-import-admin` as an explicit retired/tombstoned route if clients still call it
3. Port the current chat implementation exactly before optimizing it: model/inference profile, system prompt, tool schemas, state and trip-state handling, tool loop, provider reasoning, response verification/correction, attachments, timeouts, cancellation, and persistence.
4. Complete the chat streaming spike early. Test first-byte time, continuous SSE delivery, 60+ second requests, browser cancellation, Lambda/task cancellation, CloudFront buffering, WAF behavior, and cost. Select Fargate if the serverless path fails any gate.
5. Preserve multipart transcription behavior and apply audio size, MIME, duration, timeout, and rate limits. API Gateway and synchronous Lambda payload limits are lower than Supabase's configured 50 MiB ceiling; create and test a service-limit matrix before choosing the path. Use direct S3 presigned upload plus an opaque object token for larger audio/CSV payloads, with short upload expiry, malware/content validation, encryption, versioning, and lifecycle transition to Glacier without expiration. Persist raw audio and original uploads under the approved indefinite-retention policy.
6. Add the missing `chat_feedback` schema/API and admin update behavior to Aurora rather than silently dropping them.
7. Make every SQL statement parameterized. Add transaction boundaries for multi-table chat and replay writes; enforce idempotency keys for retryable POST/upload operations.
8. Return stable error codes without raw exception, SQL, secret, or provider-contact leakage.
9. Add structured logs with correlation ID, route, status, latency, cold start, dependency latency, and safe error category. Redact authorization headers, chat content, addresses, eligibility details, audio, and third-party payloads according to the data policy.

**Exit gate:** unit tests pass and the staging contract suite shows no unexplained request, response, side-effect, or chat-quality difference from Supabase.

### Phase 5 — Add identity, authorization, abuse controls, and privacy boundaries

**Goal:** replace the current database-wide public trust model.

1. Configure the AWS organization's IAM Identity Center as the workforce source and create an OPTIMAT SAML application federated into a Cognito User Pool. Assign all active organization human users to the application and map them to the `optimat-admin` group. Exclude service accounts/roles, disable direct local signup, require MFA according to the organization's Identity Center policy, and automate deprovisioning when organization access is removed.
2. Attach API Gateway JWT authorizers to all protected routes. Check resource ownership inside the handler as well as group membership.
3. For anonymous rider chat, issue an opaque signed session cookie/token and store a one-way session identifier. A caller may access only its own conversations/messages; listing all conversations is never public.
4. Keep public provider reads, geocoding, directions, health, chat, transcription, and feedback only if product requirements require them. Apply WAF rate-based rules, API throttles, body limits, bot controls as needed, and per-session quotas.
5. Separate public and private response DTOs so contacts, internal notes, raw tool inputs, and administrative fields cannot leak through broad `SELECT *` queries.
6. If Supabase Auth has separate users, determine whether any are workforce identities. Migrate valid workforce users into the organization identity process rather than maintaining a second password directory; archive or retire unowned accounts after approval.
7. Complete a threat model for IDOR, anonymous enumeration, prompt injection/tool abuse, SSRF through search/map tools, CSV upload abuse, replay exposure, log leakage, and cost-amplification attacks.
8. Enable CloudTrail, GuardDuty/security notifications as appropriate, KMS key policies, secret rotation, dependency scanning, SBOM generation, and least-privilege IAM review.
9. Translate, do not silently drop, Supabase RLS and grant behavior. Where row isolation moves to the service layer, document the trust-boundary change and add database views/functions or transaction-scoped identity context where practical for defense in depth. Prove equivalent denial behavior with cross-tenant and cross-session tests.
10. Write immutable audit events for provider/admin mutations with Identity Center subject, action, target, correlation ID, timestamp, and before/after hashes. Never treat access to the AWS organization as permission for direct Aurora, S3, or Secrets Manager access; application access and infrastructure access remain separate IAM policies.

### Phase 5A — Implement indefinite, cost-tiered retention

**Goal:** retain all application history without allowing Aurora and CloudWatch costs to grow without bound.

1. Keep current operational records in Aurora and define an age/size-based archival job for append-only history. Export archival batches in a versioned, documented format to S3 before deleting any online copy; verify counts and hashes before and after archival.
2. Store raw audio and original trip uploads directly in a dedicated, private S3 archive bucket with Block Public Access, SSE-KMS, versioning, access logging, bucket-owner enforcement, and tightly scoped application roles.
3. Add lifecycle transitions to lower-cost storage classes and Glacier Deep Archive, but no `Expiration` action. Keep a searchable manifest containing object ID, content hash, schema/content type, source record, creation time, storage class, and restore status.
4. Use 7-day PITR for fast operational recovery, retain monthly Aurora snapshots without automatic deletion, and produce periodic logical exports to the archive. Backups supplement the archive; they are not the only historical-data format.
5. Archive CloudTrail and application audit events to a separate security-log bucket with organization controls and no automatic expiration. Keep verbose Lambda/application debug logs in CloudWatch only for the shorter operational window documented in the runbook.
6. Run quarterly archive retrieval and restore samples, including Glacier restore timing and KMS/key-access verification. Alarm on failed archival jobs, missing manifests, checksum drift, lifecycle-policy changes, and unauthorized deletion attempts.
7. Define a controlled manual-deletion procedure for legal, privacy, corrupted-data, or organization-closure cases. Require named approval, audit the deletion, and account for object versions, replicas, snapshots, manifests, and backup retention.

**Exit gate:** authorization matrix tests pass for anonymous, rider-session, organization-admin, and service roles; Identity Center deprovisioning removes access; archive checksums and a Glacier restore pass; no application-data lifecycle rule expires objects; and an external security review has no critical/high open finding.

### Phase 6 — Decouple the frontend, scripts, tests, and documentation from Supabase

**Goal:** make AWS the only runtime backend while preserving rapid rollback.

1. Replace `src/lib/supabase.ts` with a provider-neutral HTTP client configured by one runtime `API_BASE_URL`; remove the Supabase URL/key fallback and `@supabase/supabase-js`.
2. Route the direct PostgREST message replay query through the AWS messages/replay API.
3. Update `src/lib/api.ts` for AWS auth/session headers, consistent route construction, SSE endpoint selection, and typed error codes. Remove `/functions/v1` assumptions.
4. Use runtime configuration or a controlled feature flag so the frontend can switch between Supabase and AWS during rehearsal without a code change. Delete the fallback after the rollback window.
5. Update `.env.example`, `src/config.js`, API/architecture documentation pages, test harness targets, chat tests, provider scripts, deployment docs, and operator runbooks.
6. Replace Supabase-specific administrative scripts with authenticated AWS CLI/API jobs. No script may contain a token, static function name, or arbitrary-SQL production path.
7. Archive historical Supabase migrations/functions after decommission rather than deleting evidence immediately. CI must fail if new runtime code imports Supabase or contains the old project hostname.

**Exit gate:** an AWS-only build works from a clean environment and repository search finds no active Supabase endpoint, credential, SDK import, or operational instruction.

### Phase 7 — Observability, resilience, performance, and cost qualification

**Goal:** prove that AWS is operable before it receives production writes.

1. Build CloudWatch dashboards and alarms for API 4xx/5xx, Lambda errors/throttles/duration/concurrency/cold starts, chat first-byte/total latency, Bedrock throttles/errors/token use, third-party failures, Aurora ACUs/connections/CPU/lag/storage, RDS Proxy saturation, NAT errors, WAF blocks, and synthetic health checks.
2. Add dead-letter/on-failure handling for asynchronous work and idempotent retry policies. Do not retry synchronous mutations blindly.
3. Run representative load tests with public read, chat, geocode/directions, audio, provider updates, and trip uploads. Verify database connection limits and third-party quotas.
4. Run fault tests: one Aurora instance unavailable, Lambda cold burst, Bedrock/Google/Tavily/OpenAI timeout, NAT/AZ impairment, expired secret, malformed upload, and downstream throttling.
5. Restore the latest Aurora snapshot/PITR into an isolated environment and validate the application against it. Record actual RTO/RPO and explicitly distinguish normal backup/PITR recovery from the migration's zero-loss planned cutover.
6. Create an AWS Pricing Calculator estimate and budgets/alerts for normal, launch, and abuse scenarios. Include Aurora minimum ACUs, optional second instance, optional RDS Proxy, the single NAT gateway, CloudFront/WAF, logs, Lambda/Fargate, Bedrock, and third-party API charges.
7. Run accessibility/product regression suites against staging; compare chat replay results and provider matching to the frozen Supabase baseline.

**Exit gate:** service-level objectives, load thresholds, restore targets, alert routing, and monthly budget are approved; no critical alert is untested.

### Phase 8 — Rehearse the production cutover

**Goal:** turn cutover into a scripted, timed procedure.

1. Lower relevant DNS TTLs at least 48 hours before cutover. Create a staging/canary hostname that uses the exact production stack configuration.
2. Run a complete production-sized migration rehearsal from a fresh database and record duration for backup, transfer, restore, validation, application start, and rollback.
3. Run read-only shadow comparisons for safe endpoints. Never duplicate mutation, chat, transcription, or paid third-party calls without an explicit idempotency/cost design.
4. Test a small internal canary cohort on AWS, then weighted traffic if session/data routing makes it safe.
5. Execute the rollback rehearsal, including frontend config/DNS reversal and handling of any writes accepted by AWS.
6. Produce a minute-by-minute runbook, named commander, data lead, application lead, observer, decision deadlines, customer communication, and go/no-go checklist.

**Exit gate:** two successful rehearsals, including one rollback, finish inside the approved maintenance window.

### Phase 9 — Production cutover

**Goal:** make AWS authoritative without data divergence.

1. Announce the maintenance/read-only window and confirm green AWS dashboards, empty deployment queues, current backups, staff availability, and rollback readiness.
2. Enable a server-side write fence on Supabase. Verify every mutating route is fenced; do not rely only on a frontend banner.
3. Take the final Supabase backup/export, record the source LSN, wait for DMS CDC lag to reach zero with no rejected changes, and stop the task at its recorded checkpoint. Use the rehearsed dump/restore fallback only if the DMS path was explicitly abandoned before cutover.
4. Run the full automated data-verification report. Any unexplained mismatch is a no-go.
5. Deploy the final AWS application version and run protected and public smoke tests using synthetic fixtures.
6. Point the runtime frontend configuration and `api.optimat.us` to the AWS CloudFront/API path. Increase traffic gradually while watching error, latency, database, auth, WAF, Bedrock, and business metrics.
7. Keep writes disabled until the canary verification passes. Then enable AWS writes and mark Aurora authoritative.
8. Record cutover timestamp, source backup, source LSN/snapshot identifiers, target schema version, deployed commit, verification report, and decision log.

**Rollback rule:** before AWS writes are enabled, switch traffic/config back to Supabase. After AWS accepts writes, do not blindly switch back: re-enter maintenance, export the AWS delta, reconcile it into Supabase or make the product read-only, validate, and only then reverse traffic. Define numeric abort thresholds before the event.

**Exit gate:** all traffic and writes use AWS, validation is green, and Supabase remains fenced/read-only.

### Phase 10 — Stabilize and decommission Supabase

**Goal:** remove the old platform without losing rollback or audit evidence.

1. Operate a heightened-monitoring period for at least 7 days and retain Supabase read-only for 30 days unless compliance/cost policy requires another duration.
2. Re-run row-count/checksum and API parity checks at 24 hours, 7 days, and before deletion.
3. Rotate Google, Tavily, OpenAI, database, public-session signing, and any other migrated credentials. Delete the Supabase-held AWS access key and its IAM user after confirming no CloudTrail use.
4. Export final encrypted database/schema, function/configuration, auth, storage, logs/metrics needed for audit, and billing evidence. Test that the archive is readable and record retention/owner.
5. Remove Supabase environment variables, CI secrets, local credentials, DNS references, webhooks, scheduled jobs, and SDK packages. Disable Edge Functions and database access in a staged order.
6. Cancel/delete the Supabase project only after the product owner, data owner, and engineering owner sign the decommission checklist.
7. Remove temporary compatibility flags and rollback code, close migration-only IAM access, and update diagrams, runbooks, ownership, and incident procedures.

**Exit gate:** no production or operational dependency contacts Supabase; credentials are revoked; the project is deleted or formally retained as an approved archive.

## 7. Testing and acceptance matrix

| Area | Required evidence |
|---|---|
| Schema | Canonical schema diff; extensions/functions/triggers/indexes/grants accounted for |
| Data | Exact counts, chunked aggregate hashes, FK/orphan checks, null/timestamp/sequence checks |
| Provider behavior | All/search/map/filter/service-zone parity; contacts never in public DTOs; authorized update only |
| Chat | Frozen replay corpus, tool traces, attachments, state continuity, date/trip logic, model/settings parity, SSE/cancel tests |
| Conversations | Ownership isolation; CRUD and pagination; no anonymous global list |
| Trip data | Upload validation/idempotency; pairs/grouping/stats/manifests; sample interval/route equality |
| Audio | Multipart types/sizes, timeouts, no credential/audio leakage, transcription response parity |
| Platform controls | Supabase-to-AWS equivalence register; negative RLS/tenant tests; payload/timeout/quota/retention limit matrix |
| Admin | Cognito group/resource authorization, audit record, negative IDOR tests |
| Identity | IAM Identity Center assignment/deprovisioning, Cognito federation, MFA, short-lived JWTs, per-human audit attribution |
| Retention | No-expiration lifecycle audit, online-to-archive checksum, Glacier retrieval, snapshot/log archive verification, controlled deletion test |
| Resilience | Load test, AZ/database failover, third-party failure, restore rehearsal, rollback rehearsal |
| Operations | Dashboards, alarms, runbooks, logs/trace correlation, budget alerts, on-call routing |

## 8. Estimated delivery shape

Working estimate with all five initial decisions resolved:

- **One experienced engineer:** approximately 6–9 weeks, plus the 30-day observation window.
- **Two engineers with split data/platform and API/frontend ownership:** approximately 4–6 weeks, plus observation.

The highest-variance work is live-resource discovery, Supabase logical-replication/DMS feasibility, Cognito/product authorization design, and current chat parity and streaming. Do not compress the schedule by skipping migration rehearsal, restore testing, or the read-only rollback period.

Suggested milestone sequence:

1. Week 1: urgent security fixes, inventory, architecture decisions, contract baseline.
2. Weeks 1–2: production-grade IaC, CI/CD, Aurora/security/observability foundation.
3. Weeks 2–4: schema/data pipeline and latest backend ports, including streaming decision.
4. Weeks 3–5: Cognito/authorization, frontend decoupling, parity and security tests.
5. Weeks 5–6: load/restore tests, rehearsals, production cutover.
6. Following 30 days: observation, credential rotation, Supabase decommission.

## 9. Primary implementation files

- `infra/template.yaml` and `infra/lambda/**`: refactor, update, complete, secure, and test the AWS stack.
- `scripts/ddl/tables.sql`: replace as authority with a reconciled remote-derived migration baseline.
- `scripts/migrate-db.mjs` and the remaining migration scripts: replace with a dump/restore or DMS workflow and non-sensitive verification reports.
- `tests/api-harness.mjs`: make read-only by default, fixture-safe, environment-safe, and contract-focused.
- `src/lib/supabase.ts`: replace with a provider-neutral AWS API client, then remove.
- `src/lib/api.ts`: remove PostgREST and Supabase URL semantics; add session/auth and AWS streaming support.
- `.env.example`, `package.json`, `deno.lock`, `src/config.js`, API/architecture docs, provider admin scripts, and chat tests: remove Supabase runtime assumptions after cutover.
- `supabase/functions/**` and `supabase/migrations/**`: retain as migration evidence through the rollback window, then archive.

## 10. Immediate next actions

1. Confirm the AWS organization's IAM Identity Center instance and group assignment mechanism, then create the OPTIMAT application assignment for all active human identities.
2. Fix anonymous provider mutation and the destructive-by-default API harness before further parity testing.
3. Export and approve the live Supabase resource inventory and data-classification manifest.
4. Commit the existing AWS prototype on a migration branch, then make the stack compile/lint on Node.js 24 before adding features.
5. Prove Supabase-to-AWS DMS CDC support with a nonproduction replication task, time the fallback dump/restore, and run the chat streaming and Lambda-versus-Fargate cost spikes. These measurements determine the final cutover runbook and compute architecture.
6. Create the encrypted S3 application archive, audit-log archive, no-expiration lifecycle rules, and a small end-to-end Glacier retrieval test before production data migration.
