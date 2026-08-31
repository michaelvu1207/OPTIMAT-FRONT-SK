import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCurrentTimeBlock, buildRiderFactsBlock } from './state.js';

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

test('current time block resolves the Pacific date instead of relying on model knowledge', () => {
  const block = buildCurrentTimeBlock(new Date('2026-09-01T06:30:00.000Z'));
  assert.match(block, /2026-08-31/);
  assert.match(block, /11:30 PM PDT/);
  assert.match(block, /tomorrow/);
});
