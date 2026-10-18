import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse/sync';
import { hashPassword, validPassword } from '../infra/lambda/_shared/portal-password.ts';

// Node.js 24+. Generate a reviewable SQL file only; never connect to a database.
export async function buildAccountImport(csv) {
  const rows = parse(csv, { bom: true, record_delimiter: ['\r\n', '\n', '\r'], skip_empty_lines: true, columns(headers) {
    const names = headers.map(value => value.trim());
    if (new Set(names).size !== names.length) throw new Error('Duplicate CSV column names.');
    for (const required of ['provider_id', 'username', 'password', 'display_name']) {
      if (!names.includes(required)) throw new Error(`Missing CSV column: ${required}`);
    }
    return names;
  } });
  if (!rows.length) throw new Error('CSV contains no account rows.');
  const accounts = new Map();
  for (const [index, row] of rows.entries()) {
    const fail = reason => { throw new Error(`CSV record ${index + 1}: ${reason}`); };
    const username = row.username.trim().toLowerCase();
    const displayName = row.display_name.trim();
    const providerIdText = row.provider_id.trim();
    if (!/^[a-z0-9][a-z0-9._@+-]{2,79}$/.test(username)) fail('invalid username.');
    if (!displayName || displayName.length > 120) fail('display_name must contain 1–120 characters.');
    if (!validPassword(row.password)) fail('password must contain 8–128 characters.');
    if (!/^\d+$/.test(providerIdText) || Number(providerIdText) <= 0 || Number(providerIdText) > 2147483647) fail('provider_id must be a positive PostgreSQL integer.');
    const existing = accounts.get(username);
    if (existing && (existing.password !== row.password || existing.display_name !== displayName)) fail('repeated username has inconsistent password or display_name.');
    const account = existing || { username, display_name: displayName, password: row.password, provider_ids: new Set() };
    account.provider_ids.add(Number(providerIdText));
    accounts.set(username, account);
  }
  const payload = [];
  for (const account of accounts.values()) {
    payload.push({ account_id: randomUUID(), username: account.username, display_name: account.display_name,
      password_hash: await hashPassword(account.password), provider_ids: [...account.provider_ids] });
  }
  const jsonLiteral = "'" + JSON.stringify(payload).replaceAll("'", "''") + "'";
  const sql = `-- Provider account import. Contains password hashes, never plaintext passwords.
-- New accounts only: duplicate usernames or missing providers abort the transaction.
-- Review and run in the optimat database using Navicat.
BEGIN;
SET LOCAL standard_conforming_strings = on;
CREATE TEMP TABLE portal_account_import ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset(${jsonLiteral}::jsonb)
AS account(account_id uuid, username text, display_name text, password_hash text, provider_ids integer[]);

INSERT INTO optimat.portal_accounts (id, username, display_name, password_hash, role, active)
SELECT account_id, username, display_name, password_hash, 'provider', true
FROM portal_account_import;

INSERT INTO optimat.portal_account_providers (account_id, provider_id)
SELECT account_id, provider_id FROM portal_account_import
CROSS JOIN LATERAL unnest(provider_ids) AS assigned(provider_id);

SELECT a.username, a.display_name, a.role, a.active, p.provider_id, p.provider_name
FROM optimat.portal_accounts a
JOIN portal_account_import i ON i.account_id = a.id
JOIN optimat.portal_account_providers ap ON ap.account_id = a.id
JOIN optimat.providers p ON p.provider_id = ap.provider_id
ORDER BY a.username, p.provider_id;
COMMIT;
`;
  return { sql, accountCount: payload.length, assignmentCount: payload.reduce((total, a) => total + a.provider_ids.length, 0) };
}

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('Usage: node scripts/build-portal-account-import.mjs <input.csv> <output.sql>');
  if (resolve(input) === resolve(output)) throw new Error('Input and output must be different files.');
  const result = await buildAccountImport(await readFile(input, 'utf8'));
  // Refuse to overwrite any existing artifact.
  await writeFile(output, result.sql, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`Generated SQL for ${result.accountCount} accounts and ${result.assignmentCount} provider assignments. No database changes were made.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // CSV parser errors may include raw record contents; do not print those.
    console.error(error?.code?.startsWith('CSV_') ? 'Invalid CSV structure. Check quoting and the number of columns.' : error.message);
    process.exitCode = 1;
  });
}
