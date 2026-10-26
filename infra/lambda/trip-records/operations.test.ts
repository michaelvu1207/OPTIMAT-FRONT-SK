import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getPool } from '../_shared/db.js';
import { handler } from './index.js';
import { OPERATIONS_SQL, parseFilters } from './operations.js';

function event(query = '', auth = true, method = 'GET'): APIGatewayProxyEventV2 {
  return { rawPath: '/trip-records/operations', rawQueryString: query,
    headers: auth ? { authorization: `Bearer ${'ab'.repeat(32)}` } : {},
    requestContext: { http: { method } } } as APIGatewayProxyEventV2;
}
afterEach(() => mock.restoreAll());

test('date, mode, pagination and hour filters reject invalid input', () => {
  for (const query of ['date_from=2025-02-30', 'date_from=2025-08-01&date_to=2025-07-01', 'mode=routes',
    'hour_from=18&hour_to=6', 'hour_from=-1', 'limit=101', 'offset=1.5', 'provider_id=NaN', 'status=P%27']) {
    assert.throws(() => parseFilters(new URLSearchParams(query)), query);
  }
  assert.equal(parseFilters(new URLSearchParams()).hourTo, 24);
  assert.equal(parseFilters(new URLSearchParams('date_to=2025-12-31')).to, '2025-12-31');
});

test('anonymous operations requests read published data, including with mock=true', async () => {
  mock.method(await getPool(), 'query', async (sql: string, args: unknown[]) => {
    assert.equal(sql, OPERATIONS_SQL);
    assert.deepEqual(args, [null, null, null, 0, 24, null, 'combined', 50, 0]);
    return { rows: [{ payload: { summary: { records: 48832 }, trips: [] } }] };
  });
  const result = await handler(event('mock=true', false)) as any;
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).summary.records, 48832);
});

test('login headers do not change public scope and responses are not cached', async () => {
  let observed: unknown[] = [];
  mock.method(await getPool(), 'query', async (sql: string, args: unknown[]) => {
    assert.equal(sql, OPERATIONS_SQL);
    observed = args;
    return { rows: [{ payload: { imports: [], trips: [] } }] };
  });
  const result = await handler(event('provider_id=9999&date_to=2025-12-31&mode=destinations')) as any;
  assert.equal(result.statusCode, 200);
  assert.deepEqual(observed.slice(0, 3), [9999, null, '2025-12-31']);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('missing migration gives an actionable response without leaking SQL or credentials', async () => {
  mock.method(await getPool(), 'query', async (sql: string) => {
    throw Object.assign(new Error('private database details'), { code: '42P01' });
  });
  const result = await handler(event()) as any;
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /migration 0005/);
  assert.doesNotMatch(result.body, /private database details/);
});

test('invalid filters and unsupported writes do not query operational rows', async () => {
  mock.method(await getPool(), 'query', async () => { throw new Error('Unexpected query'); });
  assert.equal((await handler(event('hour_to=99')) as any).statusCode, 400);
  assert.equal((await handler(event('', true, 'POST')) as any).statusCode, 405);
});
