import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlaceResults } from './location.js';

test('keeps the facility title separate from the full street address and preserves result identity', () => {
  const [place] = normalizePlaceResults([{
    Title: 'Example Medical Center',
    Address: { Label: '123 Example Street, Concord, CA 94520, USA' },
    Position: [-122.01, 37.98],
    PlaceId: 'facility-1',
    PlaceType: 'PointOfInterest',
  }], 'medical center');
  assert.equal(place.name, 'Example Medical Center');
  assert.equal(place.address, '123 Example Street, Concord, CA 94520, USA');
  assert.deepEqual([place.lat, place.lng], [37.98, -122.01]);
  assert.equal(place.placeId, 'facility-1');
  assert.equal(place.placeType, 'PointOfInterest');
});

test('does not invent a facility or street number for a road result', () => {
  const [place] = normalizePlaceResults([{
    Title: 'Kaiser Quarry Rd, Concord, CA',
    Position: [-122.01, 37.98],
    PlaceId: 'road-1',
    PlaceType: 'Street',
  }], 'Kaiser in Concord');
  assert.equal(place.name, place.address);
  assert.equal(place.placeType, 'Street');
  assert.equal(place.address, 'Kaiser Quarry Rd, Concord, CA');
});

test('drops results without usable coordinates', () => {
  assert.deepEqual(normalizePlaceResults([
    { Title: 'Missing', PlaceId: '1', PlaceType: 'PointOfInterest' },
    { Title: 'Invalid', Position: [NaN, 37], PlaceId: '2', PlaceType: 'PointOfInterest' },
  ], 'query'), []);
});
