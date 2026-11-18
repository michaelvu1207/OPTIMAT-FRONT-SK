import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { regionalTripProviders, filterByDisability, isTimeWithinServiceHours, executeAssessEligibility, type TurnContext } from './tools.js';
import { isOneSeat, normalizeOneSeat } from './one-seat.js';

// Synthetic polygons isolate the jurisdiction rule from geocoder availability.
const zone = (left: number, right: number) => ({ type: 'Polygon', coordinates: [[[left, 0], [right, 0], [right, 2], [left, 2], [left, 0]]] });
const row = (name: string, left: number, right: number) => ({ id: 1, name, provider_name: name, service_zone: zone(left, right) });
const west = { lat: 1, lng: 1, formatted_address: '3815 Lakeside Dr Building F, Richmond, CA' };
const central = { lat: 1, lng: 4, formatted_address: '365 Lennon Ln, Walnut Creek, CA' };
const oneSeat = { ...row('One-Seat Regional Ride', 0, 8), fare: { cost: '$3.00' } };
const providers = [row('R-Transit (Richmond)', 0, 2), row('LINK Paratransit', 3, 5), row('Mobility Matters', 0, 8), oneSeat];

test('Richmond to Walnut Creek returns One Seat alongside Mobility Matters with booking details', () => {
  const result = regionalTripProviders(providers, west, central);
  assert.equal(result.policy.reason_code, 'cross_agency_connection');
  assert.deepEqual(result.matches.map(p => p.provider_name), ['Mobility Matters', 'One-Seat Regional Ride']);
  const ride = result.matches.find(isOneSeat)!;
  assert.match(JSON.stringify(ride), /925.*680-2134/);
  assert.doesNotMatch(JSON.stringify(ride), /\$3\.00/);
  assert.equal(isTimeWithinServiceHours(ride, '12:00', '15:00', '2026-11-20'), true);
  assert.equal(isOneSeat(normalizeOneSeat(ride)), true);
});

test('return leg uses the same regional rule', () => {
  assert.equal(regionalTripProviders(providers, central, west).matches.some(isOneSeat), true);
});

test('cross-city within LINK is single agency, even with Mobility Matters available', () => {
  const lafayette = { ...central, lng: 3.5, formatted_address: 'Lafayette, CA' };
  const result = regionalTripProviders(providers, lafayette, central);
  assert.equal(result.policy.reason_code, 'single_agency_covers_trip');
  assert.equal(result.matches.some(isOneSeat), false);
  assert.equal(result.matches.some(p => p.provider_name === 'LINK Paratransit'), true);
});

test('overlapping jurisdiction suppresses One Seat even if another regional pairing exists', () => {
  assert.equal(regionalTripProviders([...providers, row('WestCAT Paratransit', 0, 6)], west, central).matches.some(isOneSeat), false);
});

test('unknown endpoint, inactive program, or absent program cannot create a One Seat card', () => {
  assert.equal(regionalTripProviders(providers, west, { ...central, lng: 7 }).matches.some(isOneSeat), false);
  assert.equal(regionalTripProviders(providers.map(p => isOneSeat(p) ? { ...p, is_operating: false } : p), west, central).matches.some(isOneSeat), false);
  assert.equal(regionalTripProviders(providers.filter(p => !isOneSeat(p)), west, central).matches.some(isOneSeat), false);
});

test('all four regions connect, while a volunteer provider alone cannot establish agency boundaries', () => {
  for (const name of ['WestCAT Paratransit', 'TDT ADA Paratransit', 'Wheels Dial-a-Ride']) {
    assert.equal(regionalTripProviders([row(name, 0, 2), row('LINK Paratransit', 3, 5), oneSeat], west, central).matches.some(isOneSeat), true);
  }
  assert.equal(regionalTripProviders([row('Mobility Matters', 0, 8), oneSeat], west, central).matches.some(isOneSeat), false);
});

test('65+ and San Pablo residence do not imply ADA eligibility; One Seat remains a conditional card', () => {
  const candidates = regionalTripProviders(providers, west, central).matches.filter(isOneSeat);
  const turn: TurnContext = {
    riderEligibility: { age_range: '65_plus', residence_city: 'San Pablo' },
    lastSearch: { candidates, result: { diagnostics: {} } }, latestAssessment: null,
  };
  const result = executeAssessEligibility({ assessments: [{ provider_name: oneSeat.provider_name,
    verdict: 'verification_required', reason: 'ADA paratransit eligibility has not been confirmed.', missing_fact: 'ada_paratransit_eligible' }] }, turn);
  assert.equal(result.success, true);
  assert.match(JSON.stringify(result.data), /One-Seat Regional Ride/);
  assert.equal(filterByDisability(candidates, { disabled: false }).length, 0);
  assert.equal(filterByDisability(candidates, {}).length, 1);
});

test('Edge and Lambda regional policies stay identical', () => {
  assert.equal(readFileSync(new URL('./one-seat.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../../../supabase/functions/chat/one-seat.ts', import.meta.url), 'utf8'));
});
