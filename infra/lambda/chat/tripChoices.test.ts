import assert from 'node:assert/strict';
import test from 'node:test';
import { clarifyTripTime, routePlanner, ambiguousTripTime } from './tripChoices.js';
test('time choices preserve the stated time without creating a pickup buffer', () => {
  const result = clarifyTripTime({ time: 'noon' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data?.options.map(option => option.message), ['noon is my requested pickup time.', 'I need to arrive by noon. This is not my pickup time.']);
  assert.equal(clarifyTripTime({ time: '' }).success, false);
  assert.equal(clarifyTripTime(null).success, false);
});
test('route handoffs encode locations, require an explicit mode and make no API request', () => {
  const result = routePlanner({ mode: 'bicycling', origin: 'A & B #1', destination: 'Danville' });
  const url = new URL(result.data!.url);
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.searchParams.get('origin'), 'A & B #1');
  assert.equal(url.searchParams.get('travelmode'), 'bicycling');
  assert.equal(new URL(routePlanner({ mode: 'transit' }).data!.url).searchParams.has('origin'), false);
  assert.equal(routePlanner({ mode: 'driving' }).success, false);
  assert.equal(routePlanner({ mode: 'transit', origin: {} }).success, false);
});

test('explicit ride requests clarify unqualified clock times but preserve stated pickup and arrival', () => {
  assert.equal(ambiguousTripTime('I need a ride from Danville to Walnut Creek, tomorrow at noon.'), 'noon');
  assert.equal(ambiguousTripTime('I need transportation tomorrow at 10 AM.'), '10 AM');
  for (const message of ['I need a ride with pickup at noon.', 'I need a ride to arrive at noon.', 'I need a ride for an appointment at noon.', 'The provider opens at 10 AM.', 'Show me bicycle directions at noon.']) assert.equal(ambiguousTripTime(message), null);
});
