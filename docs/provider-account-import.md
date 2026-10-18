# Import existing provider accounts

The import is performed manually in Navicat. No utility in this workflow connects to AWS or modifies a database.

## Add English database comments

After creating the four portal tables, execute `infra/migrations/0003_portal_account_comments.sql` in the `optimat` database. This adds table and column comments without recreating tables or changing existing rows. Refresh the table metadata in Navicat to see the comments.

## Hash one existing password

Use Node.js 24 or newer. From the project root in PowerShell:

```powershell
cd D:\project\OPTIMAT_PATH\OPTIMAT-FRONT-SK
.\scripts\hash-portal-password.ps1
```

Enter the password you already generated at the hidden prompt. The output is one `scrypt:<salt>:<hash>` string. Copy the entire output into `portal_accounts.password_hash`. The original password remains the login password. The utility uses the same function as the login API; do not substitute PostgreSQL `md5()`, bcrypt, or a plain SHA-256 hash.

The utility generates a new random salt each time, so hashing the same password twice produces different strings; both verify correctly. Passwords must contain 8–128 characters under the application's current policy. Leading/trailing spaces are part of the password; do not trim them.

## Bulk import from an existing table or workbook

Export the relevant source rows from Navicat or Excel as UTF-8 CSV with these exact column names:

```csv
provider_id,username,password,display_name
```

- `provider_id`: the existing numeric `optimat.providers.provider_id`, not its UUID `id`.
- `username`: existing login name; normalized to lowercase. Must contain 3–80 characters using letters, digits, `.`, `_`, `@`, `+`, or `-`.
- `password`: existing plaintext password. It is hashed locally and is not included in the generated SQL.
- `display_name`: account label shown in the portal, such as the provider name.

If one account manages multiple providers, repeat its username, password and display_name on a row for each provider_id. Repeated entries must agree on password and display_name. Different accounts may share a provider. CSV quoting is supported, including passwords containing commas and quotes; export through a CSV-capable application rather than assembling rows manually.

Keep the input/output outside the repository, for example in a private import folder. Run from the project root:

```powershell
node .\scripts\build-portal-account-import.mjs "C:\YourPrivateFolder\provider-accounts.csv" "C:\YourPrivateFolder\provider-accounts-import.sql"
```

This requires Node.js 24+ and the existing `scripts/node_modules/csv-parse` dependency. If missing, install the project's script dependencies with `npm --prefix scripts ci`.

Open the generated SQL in Navicat, select the `optimat` database, and execute the entire script. It creates provider-role accounts and account/provider assignments in one transaction, then displays the imported usernames and provider names. It does not alter existing provider records, create a super administrator, or impose a first-login password change.

The import is intentionally **new accounts only**. An existing username or a missing provider causes the transaction to fail instead of silently overwriting credentials or leaving partial accounts. If Navicat stops at the first error, execute `ROLLBACK;` before correcting the CSV and trying again. The generator refuses to overwrite an existing SQL file; choose a new output filename for a corrected import.

If your source contains password hashes rather than plaintext passwords, do not put those hashes into the CSV password column. Confirm their algorithm and format first. Only the application's existing `scrypt:salt:hash` format can be reused directly.

## Source table column mapping

For a database source, export a query shaped like the following after replacing the table and column names with the actual names:

```sql
SELECT
    source_provider_id AS provider_id,
    source_username AS username,
    source_password AS password,
    source_provider_name AS display_name
FROM source_schema.source_accounts;
```

Use the dedicated hash utility for the first super administrator and insert that row manually as described in `docs/portal-accounts.md`.
