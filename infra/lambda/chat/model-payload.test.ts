import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeToolResultForModel } from './model-payload.js';
import { executeAssessEligibility, type TurnContext } from './tools.js';

test('search and assessment keep geometry for the application but exclude it from model context', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [Array.from({ length: 10000 }, (_, i) => [-122 + i / 100000, 37.9])],
  };
  const provider = {
    provider_name: 'Example provider',
    service_zone: geometry,
    service_area_geojson: geometry,
    service_zone_geojson: JSON.stringify(geometry),
    service_area_cities: ['Richmond'],
    eligibility_requirement: 'Richmond residents age 60 or older.',
    service_hours: { start: '09:00', end: '17:00' },
  };
  const search = {
    status: 'awaiting_eligibility_assessment',
    candidates: [provider],
    source_coordinates: { lat: 37.9, lng: -122.3 },
  };
  const before = structuredClone(search);
  const turn: TurnContext = {
    riderEligibility: { age: 65, residence_city: 'Richmond' },
    lastSearch: { candidates: [provider], result: search },
    latestAssessment: null,
  };

  for (const verdict of ['eligible', 'verification_required'] as const) {
    const assessment = executeAssessEligibility({ assessments: [{
      provider_name: provider.provider_name,
      verdict,
      reason: 'Preserve this assessment reason.',
    }] }, turn);
    assert.equal(assessment.success, true);
    const modelSearch = JSON.parse(serializeToolResultForModel(search));
    const modelAssessment = JSON.parse(serializeToolResultForModel(assessment.data));
    const bucket = verdict === 'eligible' ? 'data' : 'verification_required';
    for (const modelProvider of [modelSearch.candidates[0], modelAssessment[bucket][0]]) {
      for (const key of ['service_zone', 'service_area_geojson', 'service_zone_geojson']) {
        assert.equal(Object.hasOwn(modelProvider, key), false);
      }
      assert.equal(modelProvider.eligibility_requirement, provider.eligibility_requirement);
      assert.deepEqual(modelProvider.service_area_cities, ['Richmond']);
      assert.deepEqual(modelProvider.service_hours, provider.service_hours);
    }
    assert.equal(modelAssessment[bucket][0].eligibility_reason, 'Preserve this assessment reason.');
    assert.deepEqual(modelSearch.source_coordinates, search.source_coordinates);
    assert.ok(serializeToolResultForModel([search, assessment.data]).length < 5000);
    const applicationResult = assessment.data as Record<string, any>;
    assert.deepEqual(applicationResult[bucket][0].service_area_geojson, geometry);
    assert.deepEqual(search, before);
  }
});

test('provider details, nested results and failures use the same model boundary', () => {
  const provider = { provider_name: 'Example', service_area_geojson: { coordinates: [1, 2] } };
  assert.deepEqual(JSON.parse(serializeToolResultForModel(provider)), { provider_name: 'Example' });
  assert.deepEqual(JSON.parse(serializeToolResultForModel([provider])), [{ provider_name: 'Example' }]);
  assert.deepEqual(JSON.parse(serializeToolResultForModel({ nested: { data: [provider] } })), {
    nested: { data: [{ provider_name: 'Example' }] },
  });
  assert.equal(serializeToolResultForModel({ error: 'Provider not found' }), '{"error":"Provider not found"}');
  assert.equal(serializeToolResultForModel(null), 'null');
});
