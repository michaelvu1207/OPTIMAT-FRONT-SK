# Live Supabase Inventory and Disposition

Captured: 2026-07-30 UTC
Project: OPTIMAT (`htjohidcoyfuwfjecazu`)
Source region: `us-east-2`
PostgreSQL: 17.6, logical WAL enabled

Authoritative machine-readable evidence:

- `live-supabase-2026-07-30.json` — catalog, exact row counts, content checksums, functions, auth/storage configuration, grants, policies, publications, and cron.
- `supabase-schema-raw.sql` — native `pg_dump --schema-only` output from the production database.
- Encrypted retained snapshot in the `optimat-migration-archive` CloudFormation stack under `supabase-snapshots/2026-07-30T02-52-09-156Z/`.

The archive contains a transaction-consistent custom-format data dump, schema, inventory, downloaded live Edge Function sources, SHA-256 checksums, and a manifest. S3 versioning, SSE-KMS, Block Public Access, access logging, and no-expiration Glacier transitions are enabled.

## Product capabilities

| Capability | Live state | Disposition |
|---|---|---|
| PostgreSQL | 20 application tables, 7 application RPCs, 1 application view | Migrate all objects and rows to Aurora |
| Edge Functions | 16 active | Port all behavior; retain the disabled import endpoint as a 410 tombstone |
| Auth | 0 users, 0 identities, 0 sessions | No user migration; replace workforce access with IAM Identity Center → Cognito federation |
| Storage | 0 buckets, 0 objects | No legacy object copy; create AWS archive/audio/upload buckets |
| Realtime | `supabase_realtime` publication has no tables | No realtime replacement required |
| Cron | Daily `optimat.purge_stale_chat_trip_state()` | Replace with EventBridge Scheduler invoking a protected maintenance Lambda/job |
| Secrets | AWS, Google Maps, OpenAI, Tavily, and Supabase-generated keys | Move third-party secrets to Secrets Manager; use AWS workload roles; rotate after cutover |

## Tables and exact baseline

| Table | Rows | Disposition |
|---|---:|---|
| `chat_examples` | 13 | Migrate online |
| `chat_feedback` | 4 | Migrate online; archive indefinitely |
| `chat_trip_state` | 213 | Migrate online; scheduled purge behavior preserved |
| `conversation_states` | 75 | Migrate online |
| `conversations` | 1,483 | Migrate online; archive indefinitely |
| `demand_response_manifest_review` | 151,390 | Migrate; tier cold history to S3/Glacier |
| `demands` | 0 | Preserve schema and migrate empty table |
| `find_providers_calls` | 1,009 | Migrate; tier cold history |
| `general_question_calls` | 35 | Migrate; tier cold history |
| `geoaddress` | 5,384 | Migrate |
| `get_provider_info_calls` | 53 | Migrate; tier cold history |
| `messages` | 4,244 | Migrate online; archive indefinitely |
| `mobility_matters` | 3,849 | Migrate |
| `providers` | 30 | Migrate online |
| `providers_backup_service_area_20260518` | 29 | Preserve in indefinite archive and Aurora initially |
| `riderabilities` | 0 | Preserve schema and migrate empty table |
| `search_addresses_calls` | 293 | Migrate; tier cold history |
| `transit_driving_driving` | 1,005 | Migrate |
| `tri_delta_transit` | 1,340 | Migrate |
| `trip_record_pairs_raw` | 1,344 | Migrate; original uploads retained in S3 |

Each table's content checksum is recorded in the JSON inventory. The cutover verifier must regenerate counts and checksums after the write fence; these discovery values are not the final cutover values.

## Edge Functions

| Function | JWT at gateway | AWS disposition |
|---|---:|---|
| `health` | No | Public health Lambda |
| `providers` | Yes | Public reads/filter; Identity Center admin mutations |
| `geocode` | No | Public, rate-limited Lambda |
| `directions` | No | Public, rate-limited Lambda |
| `conversations` | Yes | Anonymous-session ownership + admin access |
| `messages` | Yes | Anonymous-session ownership + admin access |
| `chat` | Yes | Streaming Lambda URL/CloudFront or Fargate after spike |
| `transcribe` | Yes | Presigned S3 upload + protected transcription job/API |
| `tool-calls` | No | Session-owned/admin read API |
| `chat-examples` | Yes | Public reads; admin mutations |
| `replay` | Yes | Public approved examples; admin save operation |
| `trip-records` | Yes | Public approved reads; admin uploads |
| `tri-delta-transit` | No | Public read Lambda |
| `feedback` | Yes | Public session-bound submission; admin review |
| `admin-provider-advance-update` | No + custom token | Merge into Identity Center-protected provider admin API |
| `provider-import-admin` | No | Preserve 410 response until clients are proven absent |

Downloaded production sources match repository sources for every live function except:

- Repository `tool-calls` contains a newer, undeployed `general_provider_question` integration. Treat it as intended target behavior, but keep a live-baseline fixture for the deployed response.
- `admin-provider-advance-update` was missing locally and has now been recovered from the live deployment.

## DMS CDC feasibility

- `wal_level=logical`.
- `max_replication_slots=5` and `max_wal_senders=5`; no slots existed at discovery.
- Dedicated `optimat_dms` login has `REPLICATION` plus SELECT-only application grants. A separate SELECT-only dump reader is used for backups.
- The direct database hostname is IPv6-only and direct TLS login has been verified. The DMS replication instance must use a dual-stack subnet group and private IPv6 egress, or a temporary Supabase IPv4 add-on must be approved.
- Nine tables lack primary keys: `demand_response_manifest_review`, `demands`, `geoaddress`, `mobility_matters`, `providers_backup_service_area_20260518`, `riderabilities`, `transit_driving_driving`, `tri_delta_transit`, and `trip_record_pairs_raw`.
- Before CDC, each no-PK table must either receive a stable key/replica identity, be proven immutable during the migration window, or use a separately verified reload path. No update/delete may be silently dropped.
- Production DDL must be frozen from full-load start through cutover.

## Temporary migration controls

- Supabase administrative mutations now require `OPTIMAT_MIGRATION_ADMIN_TOKEN`, stored in the `MichaelAgents` 1Password vault.
- Public provider PostgREST mutations are denied by table grants.
- Two narrow database roles and a SELECT-only RLS policy exist for dump/DMS capture. Remove them after final archive verification.
- Database SSL enforcement is enabled and both migration logins have been revalidated over TLS. The current open IP allowlist remains temporary until it can be narrowed to the DMS path without breaking production.
- Supabase Bedrock access now uses a dedicated IAM user limited to the production Claude Opus inference profile. Delete it after AWS workload-role cutover.
