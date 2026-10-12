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

test('September 3 tomorrow is Friday September 4, including after UTC midnight', () => {
  const block = buildCurrentTimeBlock(new Date('2026-09-04T06:30:00.000Z'));
  assert.ok(block.includes('today = 2026-09-03 (Thursday, September 3, 2026)'));
  assert.ok(block.includes('tomorrow = 2026-09-04 (Friday, September 4, 2026)'));
});

test('October 11 tomorrow is Monday October 12 as in the reported conversation', () => {
  const block = buildCurrentTimeBlock(new Date('2026-10-12T06:27:00.000Z'));
  assert.ok(block.includes('today = 2026-10-11 (Sunday, October 11, 2026)'));
  assert.ok(block.includes('tomorrow = 2026-10-12 (Monday, October 12, 2026)'));
});

test('verified tomorrow follows the local calendar across month, year and DST boundaries', () => {
  const cases = [
    ['2026-09-01T06:30:00Z', '2026-09-01 (Tuesday, September 1, 2026)'],
    ['2027-01-01T07:30:00Z', '2027-01-01 (Friday, January 1, 2027)'],
    ['2028-02-29T07:30:00Z', '2028-02-29 (Tuesday, February 29, 2028)'],
    // Adding 24 hours to these instants would skip or repeat a Pacific date.
    ['2026-03-08T07:30:00Z', '2026-03-08 (Sunday, March 8, 2026)'],
    ['2026-11-01T07:30:00Z', '2026-11-02 (Monday, November 2, 2026)'],
  ];
  for (const [instant, expected] of cases) {
    assert.ok(buildCurrentTimeBlock(new Date(instant)).includes(`tomorrow = ${expected}`), instant);
  }
});
