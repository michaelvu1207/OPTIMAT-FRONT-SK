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
