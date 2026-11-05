import assert from 'node:assert/strict';
import test from 'node:test';
import { namedMunicipalPass } from './named-provider.js';
test('municipal pass lookups keep the complete program identity', () => {
  assert.equal(namedMunicipalPass('How much does the Walnut Creek Lyft Concierge Pass cost?'), 'Walnut Creek Lyft Concierge Pass');
  assert.equal(namedMunicipalPass('Walnut Creek Lift Concierge fees?'), 'Walnut Creek Lyft Concierge Pass');
  assert.equal(namedMunicipalPass('Walnut Creek Lyft Self-Access Pass fees?'), 'Walnut Creek Lyft Self Access Pass');
  assert.equal(namedMunicipalPass('How much is Lyft Pink?'), null);
  assert.equal(namedMunicipalPass('A Lyft Concierge program in another county?'), null);
  assert.equal(namedMunicipalPass('How much is a Lyft from Concord?'), null);
});
