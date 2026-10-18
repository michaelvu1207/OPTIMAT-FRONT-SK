# Provider accounts

## Database setup

Apply `infra/migrations/0002_portal_accounts.sql` once to the AWS application's PostgreSQL database using the schema owner. The migration creates:

- `optimat.portal_accounts`: username, display name, password hash, role, active status.
- `optimat.portal_account_providers`: many-to-many account/provider permissions, with foreign keys.
- `optimat.portal_sessions`: hashed random session tokens, expiring after eight hours.
- `optimat.portal_login_limits`: shared login throttling across Lambda instances.

After creating the tables, apply `infra/migrations/0004_portal_updated_at.sql` to add `updated_at` to all four tables. Database triggers refresh the timestamp on every row UPDATE, including no-op updates and changes made through Navicat. Inserts receive a default timestamp. Existing rows are initialized to the migration execution time, not a reconstructed historical update time. The migration can be rerun without resetting existing timestamps. This timestamp does not extend session expiry or reset login rate-limit windows.

If the Lambda database login differs from the table owner, grant that login SELECT, INSERT, UPDATE, DELETE on these four tables. Do not grant public/anonymous access. Existing provider-table privileges remain necessary.

There is no automatic bootstrap endpoint, deployment-created account, default password, or public registration. Insert the first super administrator manually. Generate a salted password hash by passing a password through stdin to `node --import tsx scripts/hash-portal-password.ts` from `infra/`. The utility does not write to the database. Keep passwords out of source control and shell command history.

Then run this SQL in your database client, substituting your username, display name, and generated hash:

```sql
INSERT INTO optimat.portal_accounts
  (id, username, display_name, password_hash, role, active)
VALUES
  (gen_random_uuid(), 'your.admin', 'Administrator',
   '<generated scrypt:salt:hash value>', 'super_admin', true);
```

Usernames are lowercase, 3–80 characters, and use letters, digits, `.`, `_`, `@`, `+`, or `-`. Passwords contain 8–128 characters. First login and administrator password resets do **not** require a password change.

## Deployment and usage

For English field comments, secure single-password hashing in PowerShell, and CSV account imports, see [provider-account-import.md](provider-account-import.md). Apply `infra/migrations/0003_portal_account_comments.sql` after creating the tables.

1. Apply the SQL migration and provision the first administrator manually.
2. Build/deploy `infra/application-template.yaml`, including the new `PortalAuthFunction` and updated providers/trip-records functions.
3. Build/deploy the frontend with `VITE_API_BACKEND=aws` and the correct `VITE_AWS_API_URL`.
4. Open `/#/provider-portal`, sign in, and use **Manage accounts** (`/#/admin/accounts`).
5. Create an account, choose its role/status, and select one or more providers. A provider account with no assignments cannot modify any provider.
6. Users can select an assigned provider, edit its profile, upload trip records, or change their own password.

Account updates revoke the target's existing sessions (except an administrator editing their own display name). Password changes revoke all sessions. Administrators cannot disable/demote/reset themselves; use the ordinary Change password form. This preserves at least one administrator through UI/API operations. Direct database edits remain the operator's responsibility.

## Scope and security

Authorization is checked on the server for profile writes and trip uploads. The account-management API requires the super_admin role. Sessions use random bearer tokens; only SHA-256 token hashes are stored in PostgreSQL. The browser keeps its token in sessionStorage, scoped to the tab; protect the site against XSS and serve it over HTTPS. Passwords use Node's salted scrypt.

Existing public provider discovery and trip/dashboard read APIs retain their existing visibility. Assignments control management access; this change does not turn the existing public analytics APIs into private data APIs. The Supabase legacy backend does not implement these new account endpoints.

The browser selects the active provider in memory; after refreshing a provider detail page, return to My account / Providers and select it again. An expired/revoked session returns an authentication error and requires signing in again.

## Validation

Run `npm run check` in the frontend and `infra/`, `npm run build` in the frontend, and `npm run test:portal` in `infra/`. Database migrations and real remote login must also be verified in the target environment before releasing. Unit tests use a stubbed database and do not constitute a production database migration test.
