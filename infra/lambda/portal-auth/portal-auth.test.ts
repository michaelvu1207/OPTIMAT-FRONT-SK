import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getPool } from '../_shared/db.js';
import { parseRequest } from '../_shared/adapter.js';
import { requireProviderAccess } from '../_shared/portal-auth.js';
import { hashPassword, verifyPassword, validPassword, hashToken } from '../_shared/portal-password.js';
import { handler } from './index.js';
import { handler as providersHandler } from '../providers/index.js';
import { handler as tripHandler } from '../trip-records/index.js';

const token = 'ab'.repeat(32);
const admin = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', username: 'admin', display_name: 'Admin', role: 'super_admin', active: true };
const provider = { ...admin, role: 'provider' };
function event(path: string, method = 'GET', body?: unknown, auth = true): APIGatewayProxyEventV2 {
  return { rawPath: path, rawQueryString: '', headers: auth ? { authorization: `Bearer ${token}` } : {},
    requestContext: { http: { method, sourceIp: '127.0.0.1' } }, body: body === undefined ? undefined : JSON.stringify(body),
  } as APIGatewayProxyEventV2;
}
async function database(fn: (sql: string, args: unknown[]) => unknown[]) {
  const pool = await getPool();
  const calls: string[] = [];
  const execute = async (sql: string, args: unknown[] = []) => { calls.push(sql); const rows = fn(sql, args); return { rows, rowCount: rows.length }; };
  mock.method(pool, 'query', execute);
  mock.method(pool, 'connect', async () => ({ query: execute, release() {} }));
  return calls;
}
afterEach(() => mock.restoreAll());

test('salted passwords verify correctly, reject wrong passwords and enforce limits', async () => {
  const first = await hashPassword('Test1234');
  assert.notEqual(first, await hashPassword('Test1234'));
  assert.equal(await verifyPassword('Test1234', first), true);
  assert.equal(await verifyPassword('Wrong password', first), false);
  assert.equal(await verifyPassword('anything', 'bad hash'), false);
  assert.equal(validPassword('short'), false);
  assert.equal(validPassword('1234567'), false);
  assert.equal(validPassword('12345678'), true);
  assert.equal(validPassword('x'.repeat(128)), true);
  assert.equal(validPassword('x'.repeat(129)), false);
});
test('anonymous management requests fail without querying or writing to the database', async () => {
  await database(() => { throw new Error('Unexpected DB access'); });
  for (const [path, method, run] of [
    ['/portal-auth/accounts', 'GET', handler],
    ['/providers/2006', 'PUT', providersHandler],
    ['/trip-records/upload', 'POST', tripHandler],
  ] as const) assert.equal((await run(event(path, method, { provider_id: 2006 }, false)) as any).statusCode, 401);
});
test('provider assignment permits only the assigned ID, including malformed ID rejection', async () => {
  await database((sql, args) => sql.includes('portal_sessions') ? [provider] : args[1] === '2006' ? [{ allowed: 1 }] : []);
  const req = parseRequest(event('/providers/2006', 'PUT'));
  assert.equal(await requireProviderAccess(req, '2006'), null);
  assert.equal((await requireProviderAccess(req, '2007') as any).statusCode, 403);
  assert.equal((await requireProviderAccess(req, '2006junk') as any).statusCode, 400);
});
test('expired, revoked, or disabled sessions are rejected', async () => {
  await database(sql => { assert.match(sql, /expires_at > now\(\) AND a.active/); return []; });
  assert.equal((await handler(event('/portal-auth/me')) as any).statusCode, 401);
});
test('provider account cannot list or create accounts or change role through admin endpoint', async () => {
  const calls = await database(() => [provider]);
  for (const method of ['GET', 'POST', 'PUT']) {
    assert.equal((await handler(event('/portal-auth/accounts', method, { role: 'super_admin' })) as any).statusCode, 403);
  }
  assert.equal(calls.every(sql => sql.startsWith('SELECT')), true);
});
test('super administrator can access any valid provider without assignment', async () => {
  await database(() => [admin]);
  assert.equal(await requireProviderAccess(parseRequest(event('/providers/2007')), 2007), null);
});
test('new account login succeeds immediately without a password-change requirement', async () => {
  const encoded = await hashPassword('Test1234');
  let savedHash: unknown;
  await database((sql, args) => {
    if (sql.includes('RETURNING attempts')) return [{ attempts: 1 }];
    if (sql.includes('SELECT * FROM optimat.portal_accounts')) return [{ ...provider, password_hash: encoded }];
    if (sql.includes('INSERT INTO optimat.portal_sessions')) { savedHash = args[0]; return [{ expires_at: '2026-10-16T00:00:00Z' }]; }
    return [];
  });
  const result = await handler(event('/portal-auth/login', 'POST', { username: 'admin', password: 'Test1234' }, false)) as any;
  assert.equal(result.statusCode, 200);
  const payload = JSON.parse(result.body);
  assert.match(payload.token, /^[a-f0-9]{64}$/);
  assert.equal(savedHash, hashToken(payload.token));
  assert.equal(payload.password_hash, undefined);
});
test('throttled login returns 429 before password lookup', async () => {
  await database(sql => { assert.match(sql, /portal_login_limits/); return [{ attempts: 51 }]; });
  assert.equal((await handler(event('/portal-auth/login', 'POST', { username: 'admin', password: 'wrong' }, false)) as any).statusCode, 429);
});
test('self-disable, self-demotion, and own admin password reset are prohibited', async () => {
  await database(() => [admin]);
  for (const changes of [{ active: false }, { role: 'provider' }, { password: 'Test1234' }]) {
    const result = await handler(event(`/portal-auth/accounts/${admin.id}`, 'PUT', { display_name: 'Admin', role: 'super_admin', active: true, provider_ids: [], ...changes })) as any;
    assert.equal(result.statusCode, 400);
  }
});
test('account creation writes hashed password and provider permissions in one transaction', async () => {
  let storedHash = '';
  const calls = await database((sql, args) => {
    if (sql.includes('portal_sessions')) return [admin];
    if (sql.startsWith('INSERT INTO optimat.portal_accounts')) storedHash = String(args[3]);
    return [];
  });
  const result = await handler(event('/portal-auth/accounts', 'POST', { username: 'new.provider', display_name: 'New Provider', password: 'Test1234', role: 'provider', active: true, provider_ids: [2006, 2007] })) as any;
  assert.equal(result.statusCode, 201);
  assert.equal(await verifyPassword('Test1234', storedHash), true);
  assert.equal(calls.filter(sql => sql.startsWith('INSERT INTO optimat.portal_account_providers')).length, 2);
  assert.equal(calls.at(-1), 'COMMIT');
});
test('invalid provider assignment rolls back account creation', async () => {
  const calls = await database(sql => {
    if (sql.includes('portal_sessions')) return [admin];
    if (sql.startsWith('INSERT INTO optimat.portal_account_providers')) throw Object.assign(new Error('FK'), { code: '23503' });
    return [];
  });
  const result = await handler(event('/portal-auth/accounts', 'POST', { username: 'new.provider', display_name: 'New', password: 'Test1234', role: 'provider', active: true, provider_ids: [99999] })) as any;
  assert.equal(result.statusCode, 400);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
});
test('administrator password reset revokes sessions without imposing a first-login password change', async () => {
  const calls = await database(sql => sql.includes('portal_sessions') || sql.startsWith('UPDATE optimat.portal_accounts') ? [admin] : []);
  const result = await handler(event('/portal-auth/accounts/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'PUT', { display_name: 'Provider', password: 'Next1234', role: 'provider', active: true, provider_ids: [2006] })) as any;
  assert.equal(result.statusCode, 200);
  assert.equal(calls.some(sql => sql.startsWith('DELETE FROM optimat.portal_sessions')), true);
  assert.equal(calls.some(sql => sql.includes('must_change_password')), false);
});
test('changing own password validates current password and revokes every session', async () => {
  const passwordHash = await hashPassword('Test1234');
  const calls = await database(sql => sql.includes('FROM optimat.portal_sessions') ? [provider] : sql.includes('SELECT password_hash') ? [{ password_hash: passwordHash }] : []);
  const result = await handler(event('/portal-auth/password', 'POST', { current_password: 'Test1234', password: 'Next1234' })) as any;
  assert.equal(result.statusCode, 200);
  assert.equal(calls.some(sql => sql === 'DELETE FROM optimat.portal_sessions WHERE account_id = $1'), true);
  assert.equal(calls.at(-1), 'COMMIT');
});
test('provider profile preserves text eligibility and saves all visible fields', async () => {
  let updateSQL = ''; let values: unknown[] = [];
  await database((sql, args) => {
    if (sql.includes('FROM optimat.portal_sessions')) return [provider];
    if (sql.includes('portal_account_providers')) return [{ ok: 1 }];
    if (sql.startsWith('UPDATE optimat.providers')) { updateSQL = sql; values = args; }
    return [{ provider_id: 2006, provider_type: 'ADA Paratransit' }];
  });
  const result = await providersHandler(event('/providers/2006', 'PUT', { eligibility_reqs: 'Adults with disabilities', planning_type: 'Advance', provider_org: 'Agency', provider_software: 'Dispatch', service_hours: { monday: '9–5' }, service_area_cities: ['Concord'], service_area_source: 'manual', service_area_notes: 'Reviewed' })) as any;
  assert.equal(result.statusCode, 200);
  for (const field of ['eligibility_reqs', 'planning_type', 'provider_org', 'provider_software', 'service_hours', 'service_area_cities', 'service_area_source', 'service_area_notes']) assert.ok(updateSQL.includes(field));
  assert.ok(values.includes(JSON.stringify('Adults with disabilities')));
});
