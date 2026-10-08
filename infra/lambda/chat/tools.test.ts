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

test('unknown ADA approval remains provider verification without a rider question', () => {
  for (const rider of [{}, { disabled: true }]) {
    const turn = turnWithCandidates([
      { provider_name: 'ADA Provider', eligibility_requirement: 'ADA paratransit approval required.' },
    ], rider);

    const result = executeAssessEligibility({ assessments: [{
      provider_name: 'ADA Provider',
      verdict: 'verification_required',
      reason: 'The provider must confirm ADA approval.',
      // Be defensive even if an older model output supplies this field.
      missing_fact: 'ada_paratransit_eligible',
    }] }, turn);

    assert.equal(result.success, true);
    const data = result.data as Record<string, any>;
    assert.equal(data.next_question, null);
    assert.equal(data.data.length, 0);
    assert.equal(data.verification_required[0].provider_name, 'ADA Provider');
    assert.equal(turn.riderEligibility.ada_paratransit_eligible, undefined);
  }
});

test('ADA requirements cannot outrank an allowed rider question', () => {
  const turn = turnWithCandidates([
    { provider_name: 'ADA Provider A' },
    { provider_name: 'ADA Provider B' },
    { provider_name: 'Local Provider' },
  ], { disabled: true });

  const result = executeAssessEligibility({ assessments: [
    ...['ADA Provider A', 'ADA Provider B'].map((provider_name) => ({
      provider_name,
      verdict: 'verification_required' as const,
      reason: 'The provider must confirm ADA approval.',
      missing_fact: 'ada_paratransit_eligible' as const,
    })),
    {
      provider_name: 'Local Provider',
      verdict: 'verification_required',
      reason: 'Residence is unknown.',
      missing_fact: 'residence_city',
    },
  ] }, turn);

  const data = result.data as Record<string, any>;
  assert.equal(data.next_question.field, 'residence_city');
  assert.deepEqual(data.next_question.provider_names, ['Local Provider']);
  assert.equal(data.verification_required.length, 3);
});

test('volunteered ADA status is preserved for eligibility assessment', () => {
  for (const approved of [true, false]) {
    const turn = turnWithCandidates([
      { provider_name: 'ADA Provider', eligibility_requirement: 'ADA paratransit approval required.' },
    ], { disabled: true, ada_paratransit_eligible: approved });

    const result = executeAssessEligibility({ assessments: [{
      provider_name: 'ADA Provider',
      verdict: approved ? 'eligible' : 'ineligible',
      reason: approved ? 'The rider volunteered that approval was granted.' : 'The rider volunteered that approval was denied.',
    }] }, turn);

    const data = result.data as Record<string, any>;
    assert.equal(data.next_question, null);
    assert.equal(data.data.length, approved ? 1 : 0);
    assert.equal(data.excluded_providers.length, approved ? 0 : 1);
    assert.equal(turn.riderEligibility.ada_paratransit_eligible, approved);
  }
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
