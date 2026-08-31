import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeAssessEligibility,
  isTimeWithinServiceHours,
  type TurnContext,
} from './tools.js';

function turnWithCandidates(
  candidates: Array<Record<string, unknown>>,
  riderEligibility: TurnContext['riderEligibility'] = {},
): TurnContext {
  return {
    riderEligibility,
    lastSearch: {
      candidates,
      result: {
        status: 'awaiting_eligibility_assessment',
        source_address: 'Origin',
        destination_address: 'Destination',
        diagnostics: {},
      },
    },
    latestAssessment: null,
  };
}

test('requires one LLM eligibility verdict for every geographic candidate', () => {
  const turn = turnWithCandidates([
    { provider_name: 'Lamorinda Spirit', eligibility_requirement: 'Resident of Lafayette, Moraga or Orinda.' },
    { provider_name: 'Mobility Matters', eligibility_requirement: 'Age 60+ or veteran.' },
  ]);

  const result = executeAssessEligibility({
    assessments: [{
      provider_name: 'Lamorinda Spirit',
      verdict: 'ineligible',
      reason: 'The rider resides in Walnut Creek.',
    }],
  }, turn);

  assert.equal(result.success, false);
  assert.match(String(result.error), /Mobility Matters/);
});

test('keeps the LLM verdict structured so residence exclusions cannot become cards', () => {
  const turn = turnWithCandidates([
    { provider_name: 'Lamorinda Spirit', eligibility_requirement: 'Resident of Lafayette, Moraga or Orinda.' },
    { provider_name: 'Walnut Creek Mini Bus', eligibility_requirement: 'Walnut Creek resident age 60+ or disabled.' },
  ], {
    age: 65,
    disabled: true,
    residence_city: 'Walnut Creek',
  });

  const result = executeAssessEligibility({
    assessments: [
      {
        provider_name: 'Lamorinda Spirit',
        verdict: 'ineligible',
        reason: 'The rider lives in Walnut Creek, not Lafayette, Moraga, or Orinda.',
      },
      {
        provider_name: 'Walnut Creek Mini Bus',
        verdict: 'eligible',
        reason: 'The rider is 65 and lives in Walnut Creek.',
      },
    ],
  }, turn);

  assert.equal(result.success, true);
  const data = result.data as Record<string, any>;
  assert.deepEqual(data.data.map((provider: any) => provider.provider_name), ['Walnut Creek Mini Bus']);
  assert.deepEqual(data.excluded_providers.map((provider: any) => provider.provider_name), ['Lamorinda Spirit']);
});

test('asks only for an unknown fact that can resolve a candidate', () => {
  const turn = turnWithCandidates([
    { provider_name: 'Mobility Matters', eligibility_requirement: 'Age 60+ or veteran.' },
  ], { age: 55, residence_city: 'Walnut Creek' });

  const result = executeAssessEligibility({
    assessments: [{
      provider_name: 'Mobility Matters',
      verdict: 'verification_required',
      reason: 'The rider is under 60; veteran status is not known.',
      missing_fact: 'veteran',
    }],
  }, turn);

  assert.equal(result.success, true);
  assert.equal((result.data as Record<string, any>).next_question.field, 'veteran');
});

test('a rider who declined is not asked another eligibility question', () => {
  const turn = turnWithCandidates([
    { provider_name: 'Mobility Matters', eligibility_requirement: 'Age 60+ or veteran.' },
  ], { age: 55, declined: true });

  const result = executeAssessEligibility({
    assessments: [{
      provider_name: 'Mobility Matters',
      verdict: 'verification_required',
      reason: 'Veteran status is unknown.',
      missing_fact: 'veteran',
    }],
  }, turn);

  assert.equal((result.data as Record<string, any>).next_question, null);
});

test('outbound and return legs may use different service intervals', () => {
  const provider = {
    service_hours: {
      hours: [
        { day: '1111100', start: '0900', end: '1200' },
        { day: '1111100', start: '1300', end: '1600' },
      ],
    },
  } as any;

  assert.equal(isTimeWithinServiceHours(provider, '10:00 AM', '3:00 PM', '2026-08-28'), true);
  assert.equal(isTimeWithinServiceHours(provider, '8:00 AM', '3:00 PM', '2026-08-28'), false);
});

test('missing service hours remain a candidate for explicit schedule verification', () => {
  assert.equal(isTimeWithinServiceHours({ service_hours: null } as any, '10:00 AM', '3:00 PM', '2026-08-28'), true);
});
