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

async function sendLocalMessage(message: string, age_range?: string) {
  const result = await handler({
    requestContext: { http: { method: 'POST' } }, rawPath: '/chat', headers: {},
    body: JSON.stringify({ conversation_id: 'local-test', message, age_range }),
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
  assert.match(result.message, /Which age range.*What city/);
  assert.doesNotMatch(result.message, /ADA/);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].type, 'age_choices');
  assert.deepEqual(result.attachments[0].data.options.map((x: any) => x.id), ['under_18', '18_49', '50_54', '55_59', '60_64', '65_plus']);
});

test('button selections are saved as age ranges before the model answers', async (t) => {
  mockDatabase(t);
  const queries: Array<{ sql: string; values: any[] }> = [];
  t.mock.method(pg.Pool.prototype, 'query', (async (sql: string, values: any[]) => {
    queries.push({ sql, values });
    return { rows: sql.startsWith('SELECT id FROM') ? [{ id: 'local-test' }] : [] };
  }) as any);
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async (command: any) => {
    const prompt = command.input.system[0].text;
    assert.match(prompt, /age_range=60_64/);
    assert.match(prompt, /exact age is unknown/);
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'Thanks. What city do you live in?' }] } } };
  }) as any);
  const result = await sendLocalMessage('My age range is 60–64.', '60_64');
  assert.equal(result.attachments.some((x: any) => x.type === 'age_choices'), false);
  const saved = queries.find(x => x.sql.startsWith('INSERT INTO optimat.chat_trip_state'));
  assert.deepEqual(JSON.parse(saved!.values[1]), { rider_eligibility: { age_range: '60_64' } });
});

test('prose age questions get buttons without requiring a tool call', async (t) => {
  mockDatabase(t);
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => ({ stopReason: 'end_turn', output: { message: { content: [{ text: 'Which age range are you in?' }] } } })) as any);
  const result = await sendLocalMessage('I need a ride.');
  assert.equal(result.attachments[0].type, 'age_choices');
});

test('the age-choice tool returns one structured choice set', async (t) => {
  mockDatabase(t);
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => ++calls === 1
    ? toolResponse('ask_age_range', {})
    : { stopReason: 'end_turn', output: { message: { content: [{ text: 'Choose the age range that applies to you.' }] } } }) as any);
  const result = await sendLocalMessage('I need to find a ride.');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].type, 'age_choices');
  assert.equal(result.attachments[0].data.options.length, 6);
});

test('a saved age band is reused on later turns without repeating the age choices', async (t) => {
  mockDatabase(t);
  t.mock.method(pg.Pool.prototype, 'query', (async (sql: string) => ({ rows:
    sql.startsWith('SELECT id FROM') ? [{ id: 'local-test' }] :
    sql.startsWith('SELECT trip FROM') ? [{ trip: { rider_eligibility: { age_range: '55_59', residence_city: 'Richmond' } } }] : []
  })) as any);
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async (command: any) => {
    assert.match(command.input.system[0].text, /age_range=55_59/);
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'What time would you like to travel?' }] } } };
  }) as any);
  const result = await sendLocalMessage('Tomorrow morning.');
  assert.equal(result.age_range, '55_59');
  assert.equal(result.attachments.some((x: any) => x.type === 'age_choices'), false);
});

test('invalid age selections are rejected before using the database or model', async () => {
  const result = await handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/chat', headers: {}, body: JSON.stringify({ conversation_id: 'local-test', message: 'My age range is 65+.', age_range: 'invalid' }) } as any) as { statusCode: number };
  assert.equal(result.statusCode, 400);
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

test('binary tool groups survive compaction and prose fallback deduplicates them', async (t) => {
  mockDatabase(t);
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => {
    calls++;
    if (calls === 1) return toolResponse('ask_yes_no', { question: 'Do you have a disability?' });
    if (calls === 2) return toolResponse('ask_yes_no', { question: 'Are you a veteran?' });
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'Do you have a disability? Are you a veteran?' }] } } };
  }) as any);
  const result = await sendLocalMessage('Help me check eligibility.');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].type, 'yes_no_choices');
  assert.equal(result.attachments[0].data.questions.length, 2);
});

test('structured refusal is saved before inference and is never interpreted as No', async (t) => {
  mockDatabase(t);
  let stored: any;
  const question = { id: 'stored-question', question: 'Do you have a disability?' };
  t.mock.method(pg.Pool.prototype, 'query', (async (sql: string, values: any[]) => {
    if (sql.startsWith('INSERT INTO optimat.chat_trip_state')) stored = JSON.parse(values[1]);
    return { rows: sql.startsWith('SELECT id FROM') ? [{ id: 'local-test' }] : sql.startsWith('SELECT trip FROM') ? [{ trip: { rider_eligibility: {}, binary_questions: [question] } }] : [] };
  }) as any);
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async (command: any) => {
    assert.match(command.input.system[0].text, /"answer":"declined"/);
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'You can confirm eligibility directly with the provider.' }] } } };
  }) as any);
  const result = await handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/chat', headers: {}, body: JSON.stringify({ conversation_id: 'local-test', message: 'ignored', yes_no_answer: { question_id: question.id, answer: 'declined' } }) } as any) as { statusCode: number; body: string };
  assert.equal(result.statusCode, 200);
  assert.equal(stored.rider_eligibility.disabled, null);
  assert.deepEqual(stored.rider_eligibility.declined_facts, ['disabled']);
  assert.equal(JSON.parse(result.body).binary_answers[0].answer, 'declined');
});

test('unverified destination results override model advice to choose either building and persist pending state', async t => {
  mockDatabase(t);
  let saved: any;
  t.mock.method(pg.Pool.prototype, 'query', (async (sql: string, values: any[]) => {
    if (sql.startsWith('INSERT INTO optimat.chat_trip_state')) saved = JSON.parse(values[1]);
    return { rows: sql.startsWith('SELECT id FROM') ? [{ id: 'local-test' }] : [] };
  }) as any);
  // No real web request is allowed in this regression, even if a developer has a key configured.
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => ++calls === 1
    ? toolResponse('verify_destination_address', { user_query: 'Kaiser Optometry Shadelands Walnut Creek', city: 'Walnut Creek', department: 'Optometry' })
    : { stopReason: 'end_turn', output: { message: { content: [{ text: 'Either address is fine; the driver knows the complex. Which building do you choose?' }] } } }) as any);
  const result = await sendLocalMessage('I need Kaiser Optometry in Shadelands, Walnut Creek. I do not know which building.');
  assert.match(result.message, /Enter an address/);
  assert.doesNotMatch(result.message, /Either address|driver knows|Which building/);
  assert.equal(result.attachments[0].data.status, 'verification_required');
  assert.deepEqual(result.attachments[0].data.places, []);
  assert.equal(saved.destination_verification.status, 'pending');
});

test('separate pickup and destination address searches survive attachment compaction', async t => {
  mockDatabase(t);
  t.mock.method(GeoPlacesClient.prototype, 'send', (async (command: any) => ({ ResultItems: [{
    Title: command.input.QueryText.includes('Danville') ? 'Danville Community Center' : 'Walnut Creek Library',
    Address: { Label: command.input.QueryText.includes('Danville') ? '420 Front St, Danville, CA 94526' : '1644 N Broadway, Walnut Creek, CA 94596' },
    Position: [-122, 37.9], PlaceType: 'PointOfInterest',
  }] })) as any);
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => {
    calls++;
    if (calls === 1) return toolResponse('search_addresses_from_user_query', { user_query: 'Danville Community Center', role: 'pickup' });
    if (calls === 2) return toolResponse('search_addresses_from_user_query', { user_query: 'Walnut Creek Library', role: 'destination', city: 'Walnut Creek' });
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'Please confirm the trip locations.' }] } } };
  }) as any);
  const result = await sendLocalMessage('I need a ride from Danville Community Center to Walnut Creek Library.');
  const attachments = result.attachments.filter((item: any) => item.type === 'address_search');
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments.map((item: any) => item.data.role), ['pickup', 'destination']);
});

test('provider detail attachments do not return raw metadata or geometry to the chat client', async t => {
  mockDatabase(t, [{
    provider_name: 'Mobility Matters', id: 'internal-id-sentinel', provider_id: 4021,
    created_at: 'internal-time-sentinel', raw_data: { note: 'internal-import-sentinel' },
    service_area_geojson: { type: 'FeatureCollection', coordinates: [[-122, 37]] },
    booking: { method: 'call', details: '(925) 284-6161', metadata: 'internal-booking-sentinel' },
    eligibility_reqs: 'Senior (60+) or veteran, and a county resident.',
  }]);
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => ++calls === 1
    ? toolResponse('get_provider_info', { provider_name: 'Mobility Matters' })
    : { stopReason: 'end_turn', output: { message: { content: [{ text: 'Contact the provider to confirm application requirements.' }] } } }) as any);
  const result = await sendLocalMessage('Do I need to apply before using Mobility Matters?');
  const details = result.attachments.find((item: any) => item.type === 'provider_info').data;
  assert.equal(details.provider_name, 'Mobility Matters');
  assert.equal(details.booking.details, '(925) 284-6161');
  assert.doesNotMatch(JSON.stringify(details), /internal-|provider_id|created_at|FeatureCollection|coordinates|metadata/);
});

test('complete Danville-to-Kaiser query offers AWS destination choices without third-party search', async t => {
  mockDatabase(t);
  const previousKey = process.env.TAVILY_API_KEY; const previousArn = process.env.API_KEYS_SECRET_ARN;
  process.env.TAVILY_API_KEY = 'synthetic-test-key'; delete process.env.API_KEYS_SECRET_ARN;
  t.after(() => {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previousKey;
    if (previousArn === undefined) delete process.env.API_KEYS_SECRET_ARN; else process.env.API_KEYS_SECRET_ARN = previousArn;
  });
  t.mock.method(GeoPlacesClient.prototype, 'send', (async (command: any) => ({ ResultItems: [command.input.QueryText.includes('Kaiser')
    ? { Title: 'Kaiser Park Shadelands', Address: { Label: '320 Lennon Ln, Walnut Creek, CA 94598' }, Position: [-122.029, 37.927], PlaceType: 'PointAddress' }
    : { Title: 'Danville', Address: { Label: 'Danville, CA, United States' }, Position: [-122, 37.8], PlaceType: 'Locality' }] })) as any);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Third-party search must not run for normal address choices'); });
  let calls = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async () => {
    calls++;
    if (calls === 1) return toolResponse('search_addresses_from_user_query', { user_query: 'downtown Danville', role: 'pickup' });
    if (calls === 2) return toolResponse('verify_destination_address', { user_query: 'Kaiser Shadelands Optometry Walnut Creek', organization: 'Kaiser', facility: 'Shadelands', department: 'Optometry', city: 'Walnut Creek' });
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'Please confirm the destination.' }] } } };
  }) as any);
  const result = await sendLocalMessage('I need a ride from downtown Danville to Kaiser optometry in Shadelands, Walnut Creek. I don’t know the address. Can you find it?');
  assert.match(result.message, /possible locations/);
  assert.doesNotMatch(result.message, /could not verify/);
  const searches = result.attachments.filter((item: any) => item.type === 'address_search');
  assert.equal(searches.length, 2);
  assert.equal(searches.find((item: any) => item.data.role === 'pickup').data.places[0].place_type, 'Locality');
  assert.equal(searches.find((item: any) => item.data.role === 'destination').data.status, 'confirmation_required');
});

test('named municipal pass pricing is loaded before an answer even when the model skips tools', async t => {
  mockDatabase(t, [{
    provider_id: 5032, provider_name: 'Walnut Creek Lyft Concierge Pass',
    fare: { type: 'fixed', cost: '$60 annual membership fee. 10 one-way rides per month. $5 within a city; $10 between cities.' },
    booking: { method: 'call', details: '(925) 256-3533' }, id: 'internal-pass-id',
  }]);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external lookup needed'); });
  t.mock.method(BedrockRuntimeClient.prototype, 'send', (async (command: any) => {
    const prompt = command.input.system[0].text;
    assert.match(prompt, /\$60 annual membership fee/);
    assert.match(prompt, /10 one-way rides per month/);
    assert.match(prompt, /not ordinary Lyft or Lyft Pink/);
    assert.doesNotMatch(prompt, /internal-pass-id/);
    return { stopReason: 'end_turn', output: { message: { content: [{ text: 'The membership fee is $60 annually. Rides are not free.' }] } } };
  }) as any);
  const result = await sendLocalMessage('How much does the Walnut Creek Lyft Concierge Pass cost? Is the $60 membership fee monthly or annual, and are the 10 rides each month free? How much would a one-way ride from Concord to Walnut Creek cost?');
  assert.equal(result.attachments.find((item: any) => item.type === 'provider_info').data.fare.cost.startsWith('$60 annual'), true);
  assert.equal(result.attachments.some((item: any) => item.type === 'age_choices' || item.type === 'web_search'), false);
});
