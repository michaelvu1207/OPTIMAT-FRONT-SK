import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountImport } from './build-portal-account-import.mjs';
import { verifyPassword } from '../infra/lambda/_shared/portal-password.ts';
const header = 'provider_id,username,password,display_name\n';

function payloadFromSql(sql) {
  const literal = sql.match(/jsonb_to_recordset\('([\s\S]*)'::jsonb\)/)[1];
  return JSON.parse(literal.replaceAll("''", "'"));
}
test('import hashes the existing password without changing it and maps provider IDs', async () => {
  const password = 'existing-password-123';
  const result = await buildAccountImport(header + `2006,LINK.ADMIN,${password},LINK Paratransit\n2007,link.admin,${password},LINK Paratransit\n`);
  assert.equal(result.accountCount, 1);
  assert.equal(result.assignmentCount, 2);
  assert.equal(result.sql.includes(password), false);
  const account = payloadFromSql(result.sql)[0];
  assert.equal(account.username, 'link.admin');
  assert.deepEqual(account.provider_ids, [2006, 2007]);
  assert.equal(await verifyPassword(password, account.password_hash), true);
  assert.equal(account.password, undefined);
  assert.match(result.sql, /'provider', true/);
  assert.doesNotMatch(result.sql, /ON CONFLICT|UPDATE optimat|super_admin/);
});
test('CSV quoting, BOM, Unicode, apostrophes, backslashes and whitespace are preserved', async () => {
  const password = '  already,generated password!  ';
  const result = await buildAccountImport('\ufeff' + header + `2006,link.user,"${password}","O'Brien, Provider \\ Branch"\r\n`);
  const account = payloadFromSql(result.sql)[0];
  assert.equal(account.display_name, "O'Brien, Provider \\ Branch");
  assert.equal(await verifyPassword(password, account.password_hash), true);
  assert.equal(await verifyPassword(password.trim(), account.password_hash), false);
  assert.match(result.sql, /SET LOCAL standard_conforming_strings = on/);
});
test('duplicate identical assignments are deduplicated', async () => {
  const row = '2006,link.user,existing-password-123,LINK\n';
  const result = await buildAccountImport(header + row + row);
  assert.equal(result.assignmentCount, 1);
});
test('inconsistent repeated accounts fail without exposing a password', async () => {
  await assert.rejects(buildAccountImport(header + '2006,link.user,existing-password-123,LINK\n2007,link.user,another-password-123,LINK\n'), /inconsistent password/);
});
test('invalid IDs, usernames, short passwords and missing columns are rejected', async () => {
  for (const row of [
    '2006junk,link.user,existing-password-123,LINK',
    '2147483648,link.user,existing-password-123,LINK',
    '0,link.user,existing-password-123,LINK',
    '2006,invalid user,existing-password-123,LINK',
    '2006,link.user,short,LINK',
  ]) await assert.rejects(buildAccountImport(header + row));
  await assert.rejects(buildAccountImport('provider_id,username,password\n2006,link.user,existing-password-123'), /Missing CSV column/);
  await assert.rejects(buildAccountImport('provider_id,username,password,display_name,username\n2006,a,b,c,d'), /Duplicate CSV/);
  await assert.rejects(buildAccountImport(header), /no account rows/);
});
