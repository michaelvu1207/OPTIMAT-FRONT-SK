import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNoProviderResponse } from './index.js';

test('retained options awaiting verification must not become a no-provider response', () => {
  assert.equal(buildNoProviderResponse({ status: 'complete', data: [], total_found: 0,
    verification_required: [{ provider_name: 'ADA option', eligibility_status: 'verification_required' }] }), null);
});

test('eligibility exclusion must not be described as a geographic failure', () => {
  const response = buildNoProviderResponse({ status: 'complete', data: [], total_found: 0,
    excluded_providers: [{ provider_name: 'ADA option', reason: 'Not disabled' }] });
  assert.match(response!, /eligibility requirements/);
  assert.doesNotMatch(response!, /no provider service area matched/i);
});
