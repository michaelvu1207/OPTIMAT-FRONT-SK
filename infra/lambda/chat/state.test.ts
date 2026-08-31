import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRiderFactsBlock } from './state.js';

test('rider facts block preserves residence and false eligibility answers', () => {
  const block = buildRiderFactsBlock({
    age: 55,
    disabled: false,
    ada_paratransit_eligible: false,
    veteran: false,
    residence_city: 'Walnut Creek',
  });

  assert.match(block, /age=55/);
  assert.match(block, /disabled=false/);
  assert.match(block, /ada_paratransit_eligible=false/);
  assert.match(block, /veteran=false/);
  assert.match(block, /residence_city=Walnut Creek/);
});

test('empty state explicitly prevents residence inference from pickup', () => {
  assert.match(buildRiderFactsBlock({}), /Do not infer residence/);
});
