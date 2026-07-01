#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  EXPECTED_UPDATED_PROVIDER_COLUMNS,
  LEGACY_UPDATED_PROVIDER_COLUMNS,
  readProviderWorkbookRows,
} from './provider-workbook.mjs';

const workbookPath = '/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx';

const rows = readProviderWorkbookRows(workbookPath, 'Updated providers');
const byName = new Map(rows.map((row) => [row['Provider Name'], row]));

assert.equal(rows.length, 29);

const expectedColumns = EXPECTED_UPDATED_PROVIDER_COLUMNS.every((column) => column in rows[0])
  ? EXPECTED_UPDATED_PROVIDER_COLUMNS
  : LEGACY_UPDATED_PROVIDER_COLUMNS;

for (const column of expectedColumns) {
  assert.ok(column in rows[0], `missing workbook column: ${column}`);
}

assert.ok(byName.has('AC Transit'));
assert.ok(byName.has('East Bay Paratransit'));
assert.ok(byName.has('County Connection LINK'));
assert.ok(byName.has('Walnut Creek Lyft Self Access Pass'));
assert.ok(byName.has('Walnut Creek Lyft Concierge Pass'));

assert.equal(
  byName.get('AC Transit')['Service Area GeoJSON'],
  'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/ac.geojson',
);
assert.match(
  byName.get('East Bay Paratransit')['Service Area GeoJSON'],
  /drive\.google\.com\/file\/d\//,
);
assert.equal(byName.get('County Connection LINK')['Service Area GeoJSON'], 'Geojson');
assert.equal(byName.get('AC Transit')['Provider Software '], '');
assert.equal(byName.get('Walnut Creek Lyft Self Access Pass')['Service Area GeoJSON'], '');
assert.match(
  byName.get('Walnut Creek Lyft Self Access Pass')['Service Area Cities (provider website)'],
  /Walnut Creek/i,
);
assert.equal(
  byName.get('Walnut Creek Lyft Self Access Pass')['Service Area Website'],
  'https://www.walnutcreekartsrec.org/programs-activities/transportation-program',
);

console.log('provider workbook tests passed');
