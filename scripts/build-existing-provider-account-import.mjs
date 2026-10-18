import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { hashPassword, verifyPassword } from '../infra/lambda/_shared/portal-password.ts';

// Explicit existing-password import. Does not change the policy for new passwords.
const [input, outputDirectory] = process.argv.slice(2);
if (!input || !outputDirectory) throw new Error('Usage: node scripts/build-existing-provider-account-import.mjs input.csv output-directory');
const literal = value => "'" + value.replaceAll("'", "''") + "'";
async function main() {
  const records = parse(await readFile(input, 'utf8'), { bom: true, columns: true, skip_empty_lines: true, record_delimiter: ['\r\n', '\n', '\r'] });
  if (!records.length) throw new Error('No account records.');
  const usernames = new Set(); const names = new Set(); const payload = [];
  for (const [index, row] of records.entries()) {
    const username = String(row.Username || '').trim().toLowerCase();
    const name = String(row['Provider name'] || '').trim();
    const password = row.Password;
    const fail = reason => { throw new Error(`Record ${index + 1}: ${reason}`); };
    if (!/^[a-z0-9][a-z0-9._@+-]{2,79}$/.test(username) || usernames.has(username)) fail('invalid or repeated username');
    if (!name || name.length > 120 || names.has(name.toLowerCase())) fail('invalid or repeated provider name');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('existing password must be 8–128 characters');
    usernames.add(username); names.add(name.toLowerCase());
    const hash = await hashPassword(password);
    if (!await verifyPassword(password, hash)) fail('password hash verification failed');
    payload.push({ account_id: randomUUID(), provider_name: name, username, password_hash: hash });
  }
  const source = literal(JSON.stringify(payload.map(({provider_name,username}) => ({provider_name,username}))));
  const preflight = `-- Read-only: every row must show READY before importing.
WITH source AS (
 SELECT * FROM jsonb_to_recordset(${source}::jsonb) AS x(provider_name text, username text)
)
SELECT s.provider_name, s.username,
 (SELECT string_agg(p.provider_id::text, ', ' ORDER BY p.provider_id) FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name)) AS matched_provider_ids,
 CASE WHEN EXISTS (SELECT 1 FROM optimat.portal_accounts a WHERE lower(a.username) = s.username) THEN 'USERNAME ALREADY EXISTS'
 WHEN (SELECT count(*) FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name)) = 0 THEN 'PROVIDER NOT FOUND'
 WHEN (SELECT count(*) FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name)) > 1 THEN 'AMBIGUOUS PROVIDER NAME'
 WHEN EXISTS (SELECT 1 FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name) AND p.provider_id IS NULL) THEN 'PROVIDER ID IS NULL'
 ELSE 'READY' END AS import_status
FROM source s ORDER BY s.username;
`;
  const sql = `-- Import ${payload.length} existing provider accounts. No plaintext passwords are included.
-- Run the entire script in the optimat database. Run 01-check-provider-accounts.sql first.
-- Existing usernames are never overwritten. Missing or ambiguous providers abort the transaction.
-- If Navicat stops on an error, execute ROLLBACK; before retrying.
BEGIN;
SET LOCAL standard_conforming_strings = on;
CREATE TEMP TABLE portal_existing_account_import ON COMMIT DROP AS
SELECT *, NULL::integer AS provider_id
FROM jsonb_to_recordset(${literal(JSON.stringify(payload))}::jsonb)
AS x(account_id uuid, provider_name text, username text, password_hash text);

DO $validation$
DECLARE problems text;
BEGIN
 SELECT string_agg(s.provider_name, '; ' ORDER BY s.provider_name) INTO problems
 FROM portal_existing_account_import s
 WHERE (SELECT count(*) FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name)) <> 1
 OR EXISTS (SELECT 1 FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name) AND p.provider_id IS NULL);
 IF problems IS NOT NULL THEN
   RAISE EXCEPTION 'Provider names missing, ambiguous, or without an ID: %', problems;
 END IF;
 SELECT string_agg(s.username, ', ' ORDER BY s.username) INTO problems
 FROM portal_existing_account_import s
 WHERE EXISTS (SELECT 1 FROM optimat.portal_accounts a WHERE lower(a.username) = s.username);
 IF problems IS NOT NULL THEN RAISE EXCEPTION 'Usernames already exist; no accounts were imported: %', problems; END IF;
END $validation$;

UPDATE portal_existing_account_import s SET provider_id = (
 SELECT p.provider_id FROM optimat.providers p WHERE lower(btrim(p.provider_name)) = lower(s.provider_name)
);
ALTER TABLE portal_existing_account_import ALTER COLUMN provider_id SET NOT NULL;

INSERT INTO optimat.portal_accounts (id, username, display_name, password_hash, role, active)
SELECT account_id, username, provider_name, password_hash, 'provider', true
FROM portal_existing_account_import;

INSERT INTO optimat.portal_account_providers (account_id, provider_id)
SELECT account_id, provider_id FROM portal_existing_account_import;

COMMIT;

-- Verification: expect ${payload.length} rows, each with the intended provider and active = true.
SELECT a.username, a.display_name, a.role, a.active, p.provider_id, p.provider_name
FROM optimat.portal_accounts a
JOIN optimat.portal_account_providers ap ON ap.account_id = a.id
JOIN optimat.providers p ON p.provider_id = ap.provider_id
WHERE a.id IN (${payload.map(a => literal(a.account_id) + '::uuid').join(', ')})
ORDER BY a.username;
`;
  // Verify that the serialized hashes still authenticate the original credentials.
  const serialized = JSON.parse(JSON.stringify(payload));
  for (let i = 0; i < records.length; i++) {
    if (!await verifyPassword(records[i].Password, serialized[i].password_hash)) throw new Error('Serialized hash verification failed.');
  }
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, '01-check-provider-accounts.sql'), preflight, { flag: 'wx', mode: 0o600 });
  await writeFile(join(out, '02-import-provider-accounts.sql'), sql, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ accounts: payload.length, uniqueUsernames: usernames.size, verifiedPasswordHashes: serialized.length, outputDirectory: out, databaseModified: false }));
}
main().catch(error => { console.error(error?.code?.startsWith('CSV_') ? 'Invalid CSV structure; check column names and quoting.' : error.message); process.exitCode = 1; });
