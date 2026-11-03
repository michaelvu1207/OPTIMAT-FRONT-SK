import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
import { buildAddressQuery, verifyDestination, destinationAddressAllowed, applyUserDestination, type LocationContext } from './destination.js';
import { executeTool, executeFindProviders, type TurnContext } from './tools.js';

const url = 'https://healthy.kaiserpermanente.org/northern-california/facilities/Park-Shadelands-Medical-Offices-100343/departments/vision-care-dlp-102926';
const title = 'Vision Essentials - Optometry at Park Shadelands Medical Offices';
const content = '# ' + title + '\n\n## Location\nBuilding 4 - Shasta\n320 Lennon Ln, Left side of building\nWalnut Creek, CA 94598\n\n## Hours\nMonday through Friday';
const input = { user_query: 'Kaiser optometry Shadelands Walnut Creek', organization: 'Kaiser', facility: 'Shadelands', department: 'Optometry', city: 'Walnut Creek' };
const context = (): TurnContext => ({ riderEligibility: {}, lastSearch: null, latestAssessment: null, locationMessages: ['I need a ride from downtown Danville to Kaiser optometry in Shadelands, Walnut Creek.'] });
function mocks(t: TestContext, results: unknown[] = [{ title, url, raw_content: content }], address = 'Park Shadelands Medical Offices, 320 Lennon Lane, Walnut Creek, CA 94598, USA') {
  const previousKey = process.env.TAVILY_API_KEY;
  const previousArn = process.env.API_KEYS_SECRET_ARN;
  delete process.env.API_KEYS_SECRET_ARN;
  process.env.TAVILY_API_KEY = 'synthetic-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previousKey;
    if (previousArn === undefined) delete process.env.API_KEYS_SECRET_ARN; else process.env.API_KEYS_SECRET_ARN = previousArn;
  });
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', (async (endpoint: string, options: RequestInit) => {
    assert.equal(endpoint, 'https://api.tavily.com/search');
    requests.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as any);
  t.mock.method(GeoPlacesClient.prototype, 'send', (async () => ({ ResultItems: [{ Title: 'Occupational Health', Address: { Label: address }, Position: [-122.029, 37.928], PlaceId: 'synthetic-320', PlaceType: 'PointOfInterest' }] })) as any);
  return requests;
}

test('destination queries retain organization and specialty without copying the pickup city', () => {
  const turn = context();
  assert.throws(() => buildAddressQuery({ user_query: 'Kaiser optometry Danville', role: 'destination', city: 'Danville' }, turn), /Destination city/);
  assert.throws(() => buildAddressQuery({ user_query: 'Kaiser optometry Danville', role: 'destination' }, turn), /pickup city/);
  assert.match(buildAddressQuery({ user_query: 'eye doctor Shadelands Walnut Creek', role: 'destination' }, turn), /^Kaiser .*Optometry$/);
  assert.equal(buildAddressQuery({ user_query: 'Danville Community Center', role: 'pickup' }, turn), 'Danville Community Center');
});

test('a later trip does not inherit a destination city from an earlier senior center question or residence', () => {
  const turn: LocationContext = { locationMessages: ['What is the Danville Senior Center address?', 'I live in Danville.', 'How can I get from downtown Danville to Shadelands Medical Center?', 'Kaiser optometrists'] };
  assert.throws(() => buildAddressQuery({ user_query: 'Kaiser optometry', role: 'destination', city: 'Danville' }, turn), /Destination city/);
  assert.match(buildAddressQuery({ user_query: 'eye doctor Shadelands', role: 'destination' }, turn), /^Kaiser/);
});

test('official department address and matching map location produce one sourced destination', async t => {
  const requests = mocks(t);
  const turn = context();
  const result = await verifyDestination(input, turn);
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.equal(result.places.length, 1);
  const place = result.places[0] as any;
  assert.equal(place.address, '320 Lennon Ln, Walnut Creek, CA 94598');
  assert.equal(place.building, 'Building 4 - Shasta');
  assert.equal(place.source_url, url);
  assert.equal(place.role, 'destination');
  assert.equal(place.name, title, 'Do not replace an official department title with the map vendor occupational-health label');
  assert.equal(turn.destinationVerification?.status, 'verified');
  assert.deepEqual(requests[0].include_domains, ['healthy.kaiserpermanente.org']);
  assert.match(requests[0].query, /"Optometry".*site:healthy\.kaiserpermanente\.org\/northern-california\/facilities/);
  assert.equal(requests[0].include_raw_content, true);
  assert.equal(requests[0].include_answer, false);
  assert.doesNotMatch(requests[0].query, /paratransit|transportation/);
});

test('a campus or different department is not proof of optometry location', async t => {
  mocks(t, [{ title: 'Occupational Health at Park Shadelands Medical Offices', url, raw_content: content }]);
  const result = await verifyDestination(input, context());
  assert.equal(result.status, 'verification_required');
  assert.deepEqual(result.places, []);
});

test('lookalike and non-HTTPS source URLs are not trusted', async t => {
  mocks(t, [
    { title, url: 'https://kaiserpermanente.org.evil.example/department', raw_content: content },
    { title, url: 'http://healthy.kaiserpermanente.org/department', raw_content: content },
  ]);
  const result = await verifyDestination(input, context());
  assert.equal(result.status, 'verification_required');
  assert.deepEqual(result.sources, []);
});

test('conflicting official addresses stay pending rather than asking the rider to guess', async t => {
  mocks(t, [{ title, url, raw_content: content }, { title, url: url + '?other=true', raw_content: content.replace('320 Lennon', '370 Lennon') }]);
  const result = await verifyDestination(input, context());
  assert.equal(result.status, 'verification_required');
  assert.deepEqual(result.places, []);
  assert.match(result.message, /disagree/);
});

test('a map result for a different building cannot confirm an official address', async t => {
  mocks(t, undefined, '370 Lennon Ln, Walnut Creek, CA 94598, USA');
  const result = await verifyDestination(input, context());
  assert.equal(result.status, 'verification_required');
  assert.deepEqual(result.places, []);
  assert.match(result.message, /map/);
});

test('a missing street number or a wrong source city stays pending', async t => {
  mocks(t, [{ title, url, raw_content: content.replace('320 Lennon Ln', 'Lennon Ln') }]);
  assert.equal((await verifyDestination(input, context())).status, 'verification_required');
});

test('search or map failures return a usable pending state, not a fabricated destination', async t => {
  mocks(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
  const turn = context();
  const result = await verifyDestination(input, turn);
  assert.equal(result.status, 'verification_required');
  assert.equal(turn.destinationVerification?.status, 'pending');
  assert.deepEqual(result.places, []);
});

test('missing web credentials fail closed without calling the search service', async t => {
  mocks(t);
  delete process.env.TAVILY_API_KEY;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Should not call'); });
  assert.equal((await verifyDestination(input, context())).status, 'verification_required');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a department map search automatically invokes official verification', async t => {
  mocks(t);
  const result = await executeTool('search_addresses_from_user_query', { ...input, role: 'destination' }, '', context());
  assert.equal(result.success, true);
  assert.equal((result.data as any).status, 'verified');
});

test('a road or unrelated clinic is not selectable as Kaiser', async t => {
  mocks(t);
  t.mock.method(GeoPlacesClient.prototype, 'send', (async () => ({ ResultItems: [
    { Title: 'Kaiser Quarry Rd', Address: { Label: 'Kaiser Quarry Rd, Concord, CA 94521' }, Position: [-121.95, 37.93], PlaceType: 'Street' },
    { Title: 'Other Clinic', Address: { Label: '123 Main St, Concord, CA 94521' }, Position: [-121.95, 37.93], PlaceType: 'PointOfInterest' },
  ] })) as any);
  const turn = context(); turn.locationMessages = ['What is the address of Kaiser in Concord?'];
  const result = await executeTool('search_addresses_from_user_query', { user_query: 'Kaiser Concord', role: 'destination', city: 'Concord', organization: 'Kaiser' }, '', turn);
  assert.equal((result.data as any).status, 'verification_required');
  assert.ok((result.data as any).places.every((place: any) => !place.selectable));
  assert.equal(turn.destinationVerification?.status, 'pending');
});

test('provider search cannot proceed with a pending or mismatched destination', async () => {
  const turn = context(); turn.destinationVerification = { status: 'pending', query: input.user_query };
  const result = await executeFindProviders({ source_address: 'Danville Community Center', destination_address: '370 Lennon Ln', travel_date: '2026-11-11', departure_time: '12:00' }, '', turn);
  assert.equal(result.success, false);
  assert.match(result.error!, /destination is pending/);
  turn.destinationVerification = { status: 'verified', query: input.user_query, address: '320 Lennon Ln, Walnut Creek, CA 94598' };
  assert.equal(destinationAddressAllowed(turn, '370 Lennon Ln, Walnut Creek'), false);
  assert.equal(destinationAddressAllowed(turn, '1320 Lennon Ln, Walnut Creek'), false);
  assert.equal(destinationAddressAllowed(turn, '320 Lennon Ln, Danville'), false);
  assert.equal(destinationAddressAllowed(turn, '320 Lennon Lane, Walnut Creek'), true);
  applyUserDestination(turn, 'Use 370 Lennon Ln, Walnut Creek, CA 94598 as my destination.');
  assert.equal(turn.destinationVerification.status, 'user_provided');
  assert.equal(destinationAddressAllowed(turn, '370 Lennon Lane, Walnut Creek'), true);
});

test('a street number suffix is not a map match for the official building', async t => {
  mocks(t, undefined, '1320 Lennon Ln, Walnut Creek, CA 94598, USA');
  assert.equal((await verifyDestination(input, context())).status, 'verification_required');
});

test('an official page in a different city does not verify the requested destination', async t => {
  mocks(t, [{ title, url, raw_content: content.replace('Walnut Creek, CA', 'Danville, CA') }]);
  assert.equal((await verifyDestination(input, context())).status, 'verification_required');
});

test('a clearly new trip clears a previous destination lock', () => {
  const turn = context(); turn.destinationVerification = { status: 'verified', query: input.user_query, address: '320 Lennon Ln, Walnut Creek, CA 94598' };
  applyUserDestination(turn, 'I need a ride from Danville to Concord Library.');
  assert.equal(turn.destinationVerification, undefined);
});

test('medical destination queries cannot bypass city grounding by omitting the role', async () => {
  const result = await executeTool('search_addresses_from_user_query', { user_query: 'Kaiser Optometry Danville' }, '', context());
  assert.equal(result.success, false);
  assert.match(result.error!, /pickup city/);
});

test('verification cannot invent an organization or convert an ambiguous eye-doctor request into a specialty', () => {
  const turn: LocationContext = { locationMessages: ['I need the eye doctor in Walnut Creek.'] };
  assert.throws(() => buildAddressQuery({ user_query: 'Kaiser Walnut Creek', role: 'destination', organization: 'Kaiser' }, turn), /organization named/);
  assert.throws(() => buildAddressQuery({ user_query: 'eye doctor Walnut Creek', role: 'destination', department: 'Optometry' }, turn), /guess the department/);
});

test('a free-form query alone cannot verify an unanchored department in another city', async t => {
  const requests = mocks(t);
  const result = await verifyDestination({ user_query: 'Kaiser Optometry Walnut Creek' }, context());
  assert.equal(result.status, 'verification_required');
  assert.equal(requests.length, 0);
  assert.match(result.message, /structured field/);
});


test('full-trip lookup retries doctor-profile and Optical Center noise with department-focused search', async t => {
  const requests = mocks(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (async (_endpoint: string, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    calls++;
    return new Response(JSON.stringify({ results: calls === 1 ? [
      { title: 'My Doctor Online | Helen Lee', url: 'https://mydoctor.kaiserpermanente.org/ncal/doctor/helenlee', raw_content: content },
      { title: 'Optical Center at Park Shadelands Medical Offices', url: url.replace('102926', '102861'), raw_content: content.replace('320 Lennon Ln', '370 Lennon Ln') },
    ] : [{ title, url, raw_content: content }] }), { status: 200 });
  }) as any);
  const turn = context();
  const result = await verifyDestination({ ...input, facility: 'Shadelands' }, turn);
  assert.equal(result.status, 'verified');
  assert.equal(calls, 2);
  assert.equal(result.places[0].address, '320 Lennon Ln, Walnut Creek, CA 94598');
  assert.deepEqual(requests[1].include_domains, ['healthy.kaiserpermanente.org', 'espanol.kaiserpermanente.org']);
});

test('unsuccessful official department lookups stop after two searches', async t => {
  const requests = mocks(t, [{ title: 'Optical Center at Park Shadelands', url, raw_content: content }]);
  assert.equal((await verifyDestination(input, context())).status, 'verification_required');
  assert.equal(requests.length, 2);
});


test('official location extraction survives long navigation before the department and nonbreaking spaces', async t => {
  const longContent = '# Official page\n' + 'Navigation and account links\n'.repeat(1200) + content.replace('## Location', '## **Location**').replace('CA 94598', 'CA\u00a094598');
  mocks(t, [{ title, url, raw_content: longContent }]);
  const result = await verifyDestination(input, context());
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.equal(result.places[0].address, '320 Lennon Ln, Walnut Creek, CA 94598');
});
