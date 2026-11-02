import assert from 'node:assert/strict';
import test from 'node:test';
import { AGE_RANGES, ageBounds, ageRangeFromMessage, exactAgeFromMessage, compareMinimumAge, mergeAgeFacts, providerAgeCheck } from './age.js';

test('six bands cover every supplied eligibility cutoff without straddling it', () => {
  for (const range of AGE_RANGES) {
    for (const minimum of [18, 50, 55, 60, 65]) {
      assert.equal(compareMinimumAge({ age_range: range.id }, minimum), range.min >= minimum ? 'meets' : 'below');
    }
  }
  assert.deepEqual(ageBounds({ age_range: '65_plus' }), { min: 65, max: Infinity });
  assert.equal(compareMinimumAge({ age_range: '60_64' }, 62), 'overlaps');
});

test('volunteered exact ages can correct a previous band without parsing ranges or trip numbers as exact ages', () => {
  assert.equal(exactAgeFromMessage("I'm 70 and live in Concord."), 70);
  assert.equal(exactAgeFromMessage('I am 64 years old.'), 64);
  for (const text of ["I'm 60–64.", "I'm 65+.", "I'm not 65.", 'I need a ride at 65 Main St.', 'I am 18 miles away.', 'I am 60 and older.', 'I am 121.']) assert.equal(exactAgeFromMessage(text), null, text);
});

test('switching age facts never leaves a fabricated or stale exact age alongside a range', () => {
  assert.deepEqual(mergeAgeFacts({ age: 67, residence_city: 'Concord' }, { age_range: '60_64' as const }), { age_range: '60_64', residence_city: 'Concord' });
  assert.deepEqual(mergeAgeFacts({ age_range: '60_64' as const }, { age: 70 }), { age: 70 });
});

test('typed explicit bands work without interpreting dates, negations, or provider rules as rider ages', () => {
  assert.equal(ageRangeFromMessage('My age range is 50–54.'), '50_54');
  assert.equal(ageRangeFromMessage('60–64'), '60_64');
  assert.equal(ageRangeFromMessage("I'm 65+ and live in Richmond."), '65_plus');
  assert.equal(ageRangeFromMessage('I am under 18.'), 'under_18');
  for (const text of ["I'm not 65+.", 'What age range is 60–64?', 'My pickup is at 55-59 Main St.', 'I am in my 60s.', 'Does senior mean age 65+?']) assert.equal(ageRangeFromMessage(text), null, text);
});

test('provider age checks preserve disability and veteran alternatives and unknown senior rules', () => {
  assert.equal(providerAgeCheck('Eligibility: Senior (65+). Proof: ID.', { age_range: '60_64' }), 'below');
  assert.equal(providerAgeCheck('Eligibility: Senior (50+) or disabled (18+). And must be a San Pablo resident.', { age_range: '50_54', disabled: false }), 'possible');
  assert.equal(providerAgeCheck('Eligibility: Senior (65+) or disabled (18+).', { age_range: '18_49', disabled: true }), 'possible');
  assert.equal(providerAgeCheck('Eligibility: Senior (65+) or disabled (18+).', { age_range: 'under_18', disabled: true }), 'below');
  assert.equal(providerAgeCheck('Eligibility: Senior (60+) or veteran. And must be a Contra Costa County resident.', { age_range: '18_49', veteran: true }), 'possible');
  assert.equal(providerAgeCheck('Eligibility: Senior (60+) or veteran.', { age_range: '18_49', veteran: false }), 'below');
  assert.equal(providerAgeCheck('Eligibility: Senior. Proof: No proof required.', { age_range: '60_64' }), 'unspecified');
  assert.equal(providerAgeCheck('Eligibility: Senior (62+).', { age_range: '60_64' }), 'overlaps');
});
