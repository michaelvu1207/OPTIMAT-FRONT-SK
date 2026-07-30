# OPTIMAT AWS Production Cutover Record

## Outcome

OPTIMAT production is authoritative on AWS in `us-west-1`. Supabase is fenced read-only and retained only as a 30-day rollback source.

## Deployed system

- Frontend: AWS Amplify app `d3loqorszhsxp7`, production branch `master`
- Production merge: `2814a6acbc2e1c9e6ff4c147b70c37d24fe1777d`
- API: `https://j3do4jmr96.execute-api.us-west-1.amazonaws.com`
- Database: encrypted Aurora PostgreSQL 17.7 Serverless v2 cluster `optimat-prod-v2`
- Archive: `s3://optimat-archive-147229569658-us-west-1/supabase-snapshots/2026-07-30T05-30-52-298Z/`
- CloudFormation: `optimat-v2-platform`, `optimat-v2-migrator`, `optimat-v2-application`, `optimat-v2-sync`, and `optimat-migration-archive`

All five stacks finished in `UPDATE_COMPLETE`. Aurora deletion protection is enabled. API Gateway throttling is 25 requests/second with a burst of 50.

## Zero-loss evidence

1. The write-fence rejection test passed inside a rolled-back transaction.
2. The fence was enabled atomically on all 12 mutable Supabase tables.
3. The final repeatable-read source snapshot and single Aurora transaction copied all 20 tables.
4. Final source and target totals were both 171,795 rows, with no per-table count difference.
5. After production began accepting AWS writes, `verify-all` computed SHA-256 row digests and compared row multisets. It found zero missing source rows across all 20 tables. The only additional target records were one conversation and three messages created by the production browser verification.
6. The final S3 dump was downloaded and its SHA-256 matched `0f90fb1ea59179b3039caf978c7ec791baa6bb77c250e50302eb3633e8897ab1`. `pg_restore --list` found table-data entries for all 20 application tables.

## Application verification

- 47/47 read-only AWS API harness checks passed.
- Amplify preview rendered with Supabase variables explicitly blank and became healthy after the CORS update.
- Production rendered on `https://optimat.us`, created an AWS conversation, loaded examples, and returned a live Bedrock chat response.
- Amplify production environment variables contain `VITE_API_BACKEND=aws` and the AWS API URL; no Supabase environment-variable names remain.
- The temporary preview branch and temporary Supabase Bedrock IAM principal were deleted after verification.

## Retention and access

The final archive is versioned and has no expiration action. Objects transition to Standard-IA after 30 days, Glacier after 90 days, and Deep Archive after 365 days. Bucket policies grant read/list access to principals in AWS organization `o-uowlpq5ezy` while public access remains blocked.

## Rollback window

Keep the Supabase trigger fence enabled for 30 days. Do not switch traffic back after AWS has accepted writes without first reconciling the Aurora delta into Supabase. During rollback, stop AWS writes, export/reconcile the delta, validate both sides, restore the Amplify Supabase variables, rebuild production, and only then disable the Supabase fence.

At the end of the approved window:

1. Re-run production and archive verification.
2. Delete the Supabase migration reader/DMS roles and related secrets.
3. Remove migration-only synchronizer resources.
4. Decommission the Supabase project only after owner approval.

## Remaining organization-level dependency

Identity Center-to-Cognito federation for workforce admin routes needs AWS management-account or delegated-administrator access. The `path` member-account principal cannot access the Identity Center instance or assume the management account's administration role. This does not affect the public production backend or the organization-scoped archive access.
