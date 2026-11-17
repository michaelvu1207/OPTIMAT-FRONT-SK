import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerQuestion, applyBinaryAnswer, questionsFromText, applyTypedBinaryAnswer, YES_NO_OPTIONS } from './yes-no.js';
import type { TurnContext } from './tools.js';
const context = (): TurnContext => ({ riderEligibility: {}, lastSearch: null, latestAssessment: null });

test('all binary groups offer three answers including adjacent confirmations', () => {
  const turn = context();
  const questions = questionsFromText(turn, 'Do you have a disability? Are you a veteran?\nIs this your destination?');
  assert.equal(questions.length, 3);
  assert.deepEqual(YES_NO_OPTIONS.map(option => option.label), ['Yes', 'No', 'Would rather not say']);
  assert.equal(new Set(questions.map(question => question.id)).size, 3);
  assert.equal(registerQuestion(turn, 'What is your pickup address?'), null);
  assert.equal(registerQuestion(turn, 'Can you tell me your pickup address?'), null);
});
test('refusal remains unknown across persistence and permits other questions and corrections', () => {
  const turn = context();
  const question = registerQuestion(turn, 'Do you have a disability?')!;
  applyBinaryAnswer(turn, { question_id: question.id, answer: 'declined' });
  assert.equal(turn.riderEligibility.disabled, null);
  assert.deepEqual(turn.riderEligibility.declined_facts, ['disabled']);
  assert.equal(turn.riderEligibility.declined, undefined);
  assert.equal(registerQuestion(turn, question.question), null);
  assert.ok(registerQuestion(turn, 'Are you a veteran?'));
  const restored = JSON.parse(JSON.stringify(turn));
  assert.equal(registerQuestion(restored, question.question), null);
  applyBinaryAnswer(restored, { question_id: question.id, answer: 'no' });
  assert.equal(restored.riderEligibility.disabled, false);
  assert.deepEqual(restored.riderEligibility.declined_facts, []);
});
test('unknown question IDs and invalid values cannot change rider facts', () => {
  const turn = context();
  const question = registerQuestion(turn, 'Are you a veteran?')!;
  assert.equal(applyBinaryAnswer(turn, { question_id: 'another-conversation', answer: 'yes' }), null);
  assert.equal(applyBinaryAnswer(turn, { question_id: question.id, answer: 'maybe' }), null);
  assert.deepEqual(turn.riderEligibility, {});
});
test('declining a destination confirmation never sets eligibility false', () => {
  const turn = context();
  const question = registerQuestion(turn, 'Is this your destination?')!;
  applyBinaryAnswer(turn, { question_id: question.id, answer: 'declined' });
  assert.deepEqual(turn.riderEligibility, {});
  assert.equal(question.answer, 'declined');
});
test('typed answers and corrections work without binding ambiguous short replies', () => {
  const turn = context();
  const question = registerQuestion(turn, 'Are you a veteran?')!;
  applyTypedBinaryAnswer(turn, 'No.');
  assert.equal(turn.riderEligibility.veteran, false);
  applyTypedBinaryAnswer(turn, 'Actually I am a veteran.');
  assert.equal(turn.riderEligibility.veteran, true);
  assert.equal(question.answer, 'yes');
  registerQuestion(turn, 'Do you have a disability?');
  registerQuestion(turn, 'Will someone travel with you?');
  applyTypedBinaryAnswer(turn, 'Yes');
  assert.equal(turn.riderEligibility.disabled, undefined);
});

test('compound follow-ups cannot become a single yes/no choice', () => {
  const turn = context();
  const question = "Is there a different transportation provider or service you'd like help finding, or do you have a specific trip you need assistance with?";
  assert.equal(registerQuestion(turn, question), null);
  assert.deepEqual(questionsFromText(turn, question), []);
  assert.equal(registerQuestion(turn, 'Are you a veteran and do you have a disability?'), null);
  assert.ok(registerQuestion(turn, 'Is this your destination?'));
});

test('explicit statements correct saved facts even without a stored question', () => {
  const turn = context();
  turn.riderEligibility = { veteran: false, disabled: false };
  applyTypedBinaryAnswer(turn, 'Actually I am a veteran and I have a disability.');
  assert.equal(turn.riderEligibility.veteran, true);
  assert.equal(turn.riderEligibility.disabled, true);
  assert.equal(turn.binaryQuestions?.length, 2);
  assert.equal(registerQuestion(turn, 'Are you a veteran?'), null);
  applyTypedBinaryAnswer(turn, 'I am not a veteran and I am not disabled.');
  assert.equal(turn.riderEligibility.veteran, false);
  assert.equal(turn.riderEligibility.disabled, false);
});

test('corrections update supported question variants and synchronize prior answers', () => {
  const turn = context();
  const variants = [registerQuestion(turn, 'Do you have any disabilities?')!, registerQuestion(turn, 'Do you have a disability?')!];
  applyBinaryAnswer(turn, { question_id: variants[0].id, answer: 'no' });
  applyTypedBinaryAnswer(turn, 'Actually I have a disability.');
  assert.equal(turn.riderEligibility.disabled, true);
  assert.deepEqual(variants.map(question => question.answer), ['yes', 'yes']);
  applyBinaryAnswer(turn, { question_id: variants[1].id, answer: 'declined' });
  assert.deepEqual(variants.map(question => question.answer), ['declined', 'declined']);
  assert.equal(turn.riderEligibility.disabled, null);
  applyTypedBinaryAnswer(turn, 'I am not disabled.');
  assert.deepEqual(variants.map(question => question.answer), ['no', 'no']);
  assert.deepEqual(turn.riderEligibility.declined_facts, []);
});
