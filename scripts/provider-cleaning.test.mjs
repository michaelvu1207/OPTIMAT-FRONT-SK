#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import {
  MANUAL_NAME_MAP,
  PROVIDER_ID_NAME_ALIASES,
  parseCityNames,
  parseEligibility,
  parseFare,
  resolveCanonicalProviderName,
} from './provider-cleaning.mjs';

const CSV_PATHS = [
  '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers (2).csv',
  '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers.csv',
];
const CSV_PATH = CSV_PATHS.find((path) => fs.existsSync(path));
assert.ok(CSV_PATH, 'Provider validation CSV was not found');
const rows = parse(fs.readFileSync(CSV_PATH, 'utf-8'), {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  trim: true,
});

const byName = new Map(rows.map((row) => [row['Provider Name'], row]));

assert.ok(rows.length >= 29);
assert.ok(byName.has('Walnut Creek Lyft Self Access Pass'));
assert.ok(byName.has('Walnut Creek Lyft Concierge Pass'));

const selfAccess = byName.get('Walnut Creek Lyft Self Access Pass');
const concierge = byName.get('Walnut Creek Lyft Concierge Pass');

const selfAccessEligibility = parseEligibility(selfAccess['Eligibility (provider website)']);
assert.ok(selfAccessEligibility.eligibility.includes('Senior'));
assert.ok(selfAccessEligibility.eligibility.includes('Disabled'));
assert.ok(selfAccessEligibility.eligibility.includes('Resident'));
assert.deepEqual(selfAccessEligibility.eligibility_reqs, [
  { type: 'Senior' },
  { type: 'Disabled' },
  { type: 'Resident' },
]);

const conciergeEligibility = parseEligibility(concierge['Eligibility (provider website)']);
assert.ok(conciergeEligibility.eligibility.includes('Senior'));
assert.ok(conciergeEligibility.eligibility.includes('Disabled'));
assert.ok(conciergeEligibility.eligibility.includes('Resident'));
assert.deepEqual(conciergeEligibility.eligibility_reqs, [
  { type: 'Senior' },
  { type: 'Disabled' },
  { type: 'Resident' },
]);

const serviceAreaColumn = selfAccess['Service Area Cities (provider website)'] ?? selfAccess['Service Area (provider website)'];
assert.deepEqual(parseCityNames(serviceAreaColumn), [
  'Walnut Creek',
  'Concord',
  'Clayton',
  'Pleasant Hill',
  'Martinez',
]);

assert.deepEqual(parseFare(selfAccess['Cost (provider website)']), {
  type: 'fixed',
  cost: '$60 membership fee. Rider pays first $5 , the City of Walnut Creek will cover up to $10 per ride, rider pays additional charges for rides over $15.',
});

assert.deepEqual(parseFare(concierge['Cost (provider website)']), {
  type: 'fixed',
  cost: '$60 membership fee. 10 free trips per month',
});

assert.equal(parseFare('missing website'), null);
assert.deepEqual(parseFare('free?'), { type: 'free' });

assert.equal(
  resolveCanonicalProviderName('Walnut Creek Mini Bus'),
  'Walnut Creek Mini Bus',
);
assert.equal(
  resolveCanonicalProviderName('WestCAT Senior Dial-A-Ride'),
  'WestCAT Senior Dial-A-Ride',
);
assert.equal(
  PROVIDER_ID_NAME_ALIASES['WestCAT Senior Dial-A-Ride'],
  'WestCAT Dial-A-Ride',
);
assert.equal(MANUAL_NAME_MAP['Walnut Creek Lyft Self Access Pass'], null);

console.log('provider-cleaning tests passed');
