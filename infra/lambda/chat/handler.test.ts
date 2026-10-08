import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import { handler } from './index.js';
import { MAX_MODEL_REQUEST_BYTES } from './model-payload.js';

function mockDatabase(t: TestContext, providers: unknown[] = []) {
  t.mock.method(pg.Pool.prototype, 'query', (async (sql: string) => {
    if (sql.startsWith('SELECT id FROM')) return { rows: [{ id: 'local-test' }] };
    if (sql.startsWith('SELECT * FROM optimat.providers')) return { rows: providers };
    return { rows: [] };
  }) as any);
  t.mock.method(GeoPlacesClient.prototype, 'send', (async () => ({
    ResultItems: [{ Title: 'Synthetic local location', Position: [-122.3, 37.8] }],
  })) as any);
}

async function sendLocalMessage(message: string) {
  const result = await handler({
    requestContext: { http: { method: 'POST' } }, rawPath: '/chat', headers: {},
    body: JSON.stringify({ conversation_id: 'local-test', message }),
  } as any) as { statusCode: number; body: string };
  assert.equal(result.statusCode, 200);
  return JSON.parse(result.body);
}

function toolResponse(name: string, input: unknown) {
  return { stopReason: 'tool_use', output: { message: { content: [{ toolUse: { toolUseId: name, name, input } }] } } };
}

test('Walnut Creek full handler asks both mandatory facts even when the model ignores the tool error', async (t) => {
  mockDatabase(t);
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => ++calls === 1
    ? toolResponse('find_providers', {
      source_address: '317 Dogwood Dr, Walnut Creek', destination_address: '301 Lennon Lane, Walnut Creek',
      travel_date: '2026-10-09', departure_time: '12:00', return_time: '14:00', rider_eligibility: {},
    })
    : { stopReason: 'end_turn', output: { message: { content: [{ text: 'Incorrect model recommendation.' }] } } }) as any);
  const result = await sendLocalMessage('Hi, I am planning a trip from 317 Dogwood Dr in Walnut Creek to 301 Lennon Lane in Walnut Creek and am departing tomorrow at 12pm and returning at 2pm.');
  assert.match(result.message, /How old.*what city/);
  assert.doesNotMatch(result.message, /ADA/);
  assert.deepEqual(result.attachments, []);
});

test('Pinole-Berkeley full handler strips large geometry, assesses candidates and retains ADA options', async (t) => {
  const hugeGeometry = { type: 'Polygon', coordinates: [Array.from({ length: 100_000 }, (_, i) => [-122 + i / 1e6, 37.9])] };
  mockDatabase(t, [{
    provider_name: 'Synthetic ADA option', provider_type: 'ADA Paratransit',
    eligibility_reqs: 'Disabled riders, subject to provider application.', service_hours: null,
    service_zone: { type: 'Polygon', coordinates: [[[-123, 37], [-121, 37], [-121, 39], [-123, 39], [-123, 37]]] },
    service_area_geojson: hugeGeometry, raw_data: { imported_geometry: hugeGeometry },
  }]);
  const requests: any[] = [];
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async (command: any) => {
    requests.push(command.input);
    if (requests.length === 1) return toolResponse('find_providers', {
      source_address: '801 Patrick Dr, Pinole', destination_address: '2240 Channing Way, Berkeley',
      travel_date: '2026-10-15', departure_time: '10:00', return_time: '13:00', trip_type: 'round_trip',
      rider_eligibility: { age: 65, disabled: true, residence_city: 'Pinole' },
    });
    if (requests.length === 2) return toolResponse('assess_eligibility', { assessments: [{
      provider_name: 'Synthetic ADA option', verdict: 'ineligible', exclusion_basis: 'ada_approval', reason: 'Approval unknown.',
    }] });
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'This option remains available to consider; the provider must confirm its application requirements.' }] } } };
  }) as any);
  const result = await sendLocalMessage("I'm going from 801 Patrick Dr in Pinole to 2240 Channing Way Berkeley on Thursday. I want to leave at 10am and return at 1pm. I'm 65, disabled, and a Pinole resident.");
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const encoded = JSON.stringify(request);
    assert.ok(Buffer.byteLength(encoded) < MAX_MODEL_REQUEST_BYTES);
    assert.doesNotMatch(encoded, /imported_geometry|service_area_geojson/);
  }
  const assessment = result.attachments.find((item: any) => item.metadata.tool_name === 'assess_eligibility').data;
  assert.equal(assessment.verification_required.length, 1);
  assert.equal(assessment.excluded_providers.length, 0);
  assert.equal(assessment.next_question, null);
  assert.doesNotMatch(result.message, /couldn't find|Internal server error|\?/);
});

test('an oversized non-geometry tool result is handled without another Bedrock request or a 500', async (t) => {
  mockDatabase(t, [{ provider_name: 'Huge details', eligibility_reqs: 'x'.repeat(100_000) }]);
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => {
    calls++;
    return toolResponse('get_provider_info', { provider_name: 'Huge details' });
  }) as any);
  const result = await sendLocalMessage('Tell me about Huge details.');
  assert.equal(calls, 1);
  assert.match(result.message, /too many search details/);
  assert.deepEqual(result.attachments, []);
});
