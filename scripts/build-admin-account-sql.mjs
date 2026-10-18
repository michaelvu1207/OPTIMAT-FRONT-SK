import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { hashPassword, verifyPassword, validPassword } from '../infra/lambda/_shared/portal-password.ts';

// Read the password through stdin, never from arguments or a source file.
async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node scripts/build-admin-account-sql.mjs output.sql');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false });
  let password;
  for await (const line of input) { password = line; break; }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  if (!validPassword(password)) throw new Error('Password must contain 8–128 characters.');
  const hash = await hashPassword(password);
  if (!await verifyPassword(password, hash)) throw new Error('Hash verification failed.');
  const sql = `-- Run in the optimat database after creating the portal account tables.
-- Creates one super administrator with access to every provider and account management.
-- No plaintext password is included. An existing admin username is never overwritten.
-- If execution fails, run ROLLBACK; before retrying.
BEGIN;

INSERT INTO optimat.portal_accounts
  (id, username, display_name, password_hash, role, active)
VALUES
  (gen_random_uuid(), 'admin', 'Super Administrator', '${hash}', 'super_admin', true);

COMMIT;

-- Verification: expect one active super_admin account.
SELECT id, username, display_name, role, active, created_at
FROM optimat.portal_accounts
WHERE username = 'admin';
`;
  await writeFile(output, sql, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log('Admin SQL generated. Password hash verified. No database changes made.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
