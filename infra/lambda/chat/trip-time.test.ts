import assert from 'node:assert/strict';
import test from 'node:test';
import { updateTripTime, knownTripTime, tripTimeFactsBlock, type TripTimeContext } from './trip-time.js';
import { clarifyTripTime } from './tripChoices.js';

const now = new Date('2026-11-17T20:00:00Z');
function pending(): TripTimeContext {
  const turn = {};
  updateTripTime(turn, 'I need a ride from Danville to Walnut Creek tomorrow at noon.', now);
  clarifyTripTime({ time: 'noon' }, turn);
  return turn;
}

test('pickup clarification survives persistence and a same-trip reminder without more buttons', () => {
  const turn = pending();
  updateTripTime(turn, 'noon is my requested pickup time.', now);
  const restored = JSON.parse(JSON.stringify(turn));
  updateTripTime(restored, 'I still need a ride tomorrow at noon.', now);
  assert.equal(knownTripTime(restored, '12:00 PM'), 'pickup');
  const result = clarifyTripTime({ time: 'noon' }, restored);
  assert.equal(result.data?.known, true);
  assert.equal(result.data?.options, undefined);
});

test('arrival clarification never supplies a pickup time or a travel buffer', () => {
  const turn = pending();
  updateTripTime(turn, 'I need to arrive by noon. This is not my pickup time.', now);
  assert.equal(knownTripTime(turn, 'noon'), 'arrival');
  assert.equal(turn.tripTime?.pickup, undefined);
  assert.match(tripTimeFactsBlock(turn), /arrival time does not supply a pickup time/);
  assert.equal(knownTripTime(turn, '11 AM'), null);
});

test('short meaning answers require a pending question; explicit corrections replace the meaning', () => {
  const empty: TripTimeContext = {};
  updateTripTime(empty, 'pickup time', now);
  assert.equal(empty.tripTime?.pickup, undefined);
  const turn = pending();
  updateTripTime(turn, 'pickup time', now);
  assert.equal(knownTripTime(turn, 'noon'), 'pickup');
  updateTripTime(turn, 'Actually I need to arrive by noon.', now);
  assert.equal(knownTripTime(turn, 'noon'), 'arrival');
  assert.equal(turn.tripTime?.pickup, undefined);
});

test('route, date, explicit new-trip and local-day changes discard old meanings', () => {
  for (const message of [
    'I need a ride from Concord to Richmond tomorrow at noon.',
    'I need a ride on Friday at noon.',
    'I need another ride at noon.',
    'Start over.',
  ]) {
    const turn = pending();
    updateTripTime(turn, 'noon is my requested pickup time.', now);
    updateTripTime(turn, message, now);
    assert.equal(knownTripTime(turn, 'noon'), null, message);
  }
  const turn = pending();
  updateTripTime(turn, 'noon is my requested pickup time.', now);
  updateTripTime(turn, 'I need a ride at noon.', new Date('2026-11-18T20:00:00Z'));
  assert.equal(knownTripTime(turn, 'noon'), null);
});

test('repeated identical route and date retain the answer; a different clock needs clarification', () => {
  const turn = pending();
  updateTripTime(turn, 'noon is my requested pickup time.', now);
  updateTripTime(turn, 'I need a ride from Danville to Walnut Creek tomorrow at noon.', now);
  assert.equal(knownTripTime(turn, 'noon'), 'pickup');
  assert.equal(knownTripTime(turn, '1 PM'), null);
  assert.equal(clarifyTripTime({ time: '1 PM' }, turn).data?.options?.length, 2);
});

test('unsupported, negative and hypothetical wording does not establish a time meaning', () => {
  for (const message of ['I do not want to arrive by noon.', 'Can I arrive by noon?', 'Maybe pickup at noon.', 'My pickup time is 13 PM.', 'My pickup time is 25:00.']) {
    const turn = pending();
    updateTripTime(turn, message, now);
    assert.equal(knownTripTime(turn, 'noon'), null, message);
  }
});

test('new routes, new dates, explicit new trips and a new local day discard old meanings', () => {
  for (const message of [
    'I need a ride from Concord to Richmond tomorrow at noon.',
    'I need a ride from Danville to Walnut Creek on Friday at noon.',
    'I need another ride tomorrow at noon.',
    'Start over.',
  ]) {
    const turn = pending();
    updateTripTime(turn, 'noon is my requested pickup time.', now);
    updateTripTime(turn, message, now);
    assert.equal(knownTripTime(turn, 'noon'), null, message);
  }
  const turn = pending();
  updateTripTime(turn, 'noon is my requested pickup time.', now);
  updateTripTime(turn, 'I still need a ride tomorrow at noon.', new Date('2026-11-18T20:00:00Z'));
  assert.equal(knownTripTime(turn, 'noon'), null);
});

test('short answers need a pending question and time corrections replace only explicit meanings', () => {
  const turn = pending();
  updateTripTime(turn, 'Pickup time', now);
  assert.equal(knownTripTime(turn, 'noon'), 'pickup');
  updateTripTime(turn, 'Actually I need to arrive by noon.', now);
  assert.equal(knownTripTime(turn, 'noon'), 'arrival');
  assert.equal(turn.tripTime?.pickup, undefined);
  updateTripTime(turn, 'My pickup time is 11 AM.', now);
  assert.equal(knownTripTime(turn, 'noon'), 'arrival');
  assert.equal(knownTripTime(turn, '11:00 AM'), 'pickup');
  const fresh = {};
  updateTripTime(fresh, 'Pickup time', now);
  assert.equal(knownTripTime(fresh, 'noon'), null);
});
