import test from 'node:test';
import assert from 'node:assert/strict';
import { riderProviderDetails } from './provider-details.js';

const provider = {
  id: 'internal-provider-id', provider_id: 4021, provider_name: 'Mobility Matters',
  created_at: 'internal-created-time', updated_at: 'internal-updated-time', investigated: true,
  service_area_geojson: { type: 'FeatureCollection', features: [{ geometry: { coordinates: [[-122, 37]] } }] },
  service_zone: { coordinates: [[-122, 37]] }, raw_data: { private: 'import-row' },
  eligibility_reqs: 'Senior (60+) or veteran, and a Contra Costa County resident.',
  contacts: [{ name: 'Example contact', email: 'contact@example.com', metadata: 'internal-contact-note' }],
  booking: { method: 'call', details: '(925) 284-6161', metadata: 'internal-booking-note', application: {
    required: true, instructions: 'Contact the provider before your first ride.', source_notes: 'internal-source-note',
    processing_time: { kind: 'range', minimum: 2, maximum: 4, unit: 'business_days', debug: 'internal-debug-note' },
  } },
  fare: { type: 'free', raw_data: 'internal-fare-note' },
  service_hours: { hours: [{ day: '1111100', start: '0900', end: '1700', metadata: 'internal-hours-note' }] },
};

test('provider details preserve rider facts and discard internal fields recursively', () => {
  const result = riderProviderDetails(provider) as any;
  assert.equal(result.provider_name, provider.provider_name);
  assert.equal(result.eligibility_reqs, provider.eligibility_reqs);
  assert.equal(result.contacts[0].email, 'contact@example.com');
  assert.equal(result.booking.application.processing_time.unit, 'business_days');
  assert.deepEqual(result.service_hours, { hours: [{ day: '1111100', start: '0900', end: '1700' }] });
  assert.doesNotMatch(JSON.stringify(result), /internal-|coordinates|FeatureCollection|provider_id|created_at|updated_at|source_notes|raw_data|metadata/);
  assert.equal(provider.booking.metadata, 'internal-booking-note', 'Do not mutate source records');
});

test('legacy serialized fields, structured eligibility, and multiple providers remain readable', () => {
  const result = riderProviderDetails([{ ...provider, booking: JSON.stringify(provider.booking), eligibility_reqs: JSON.stringify([{ type: 'Senior', proof: 'Contact provider', metadata: 'internal-note' }]) }, { provider_name: 'Other service', fare: 'Free', extra_internal_key: 'hidden' }]) as any[];
  assert.equal(result.length, 2);
  assert.equal(result[0].booking.method, 'call');
  assert.deepEqual(result[0].eligibility_reqs, [{ type: 'Senior', proof: 'Contact provider' }]);
  assert.equal(result[1].fare, 'Free');
  assert.doesNotMatch(JSON.stringify(result), /internal|extra_internal_key/);
});

test('unexpected objects in scalar fields do not escape the projection', () => {
  assert.deepEqual(riderProviderDetails({ provider_name: 'Example', website: { metadata: 'hidden' }, unknown: 'hidden' }), { provider_name: 'Example' });
  assert.deepEqual(riderProviderDetails(null), null);
});
