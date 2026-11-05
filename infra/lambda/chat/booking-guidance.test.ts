import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingGuidance, timelineProviderQuestion } from './booking-guidance.js';

const question = 'I am 75 and live in Danville. I have never used Mobility Matters. Can I get a ride tomorrow, or do I need to apply and book in advance?';
const provider = { provider_name: 'Mobility Matters', schedule_type: { advance_notice: '7 days' }, booking: { method: 'call', details: '(925) 284-6161', application: { required: null, instructions: 'Submit a form. A coordinator will contact you.' } } };
test('a new rider and an enrolled rider receive the same reservation warning', () => {
  for (const message of [question, 'I am already enrolled with Mobility Matters. Can I book tomorrow, or does advance booking still apply?']) {
    const response = bookingGuidance(message, provider)!;
    assert.match(response, /Do not expect a ride tomorrow, even if you are already enrolled/);
    assert.match(response, /Confirm first-ride application or enrollment requirements/);
    assert.match(response, /processing time is not recorded/);
    assert.doesNotMatch(response, /application is required|without prior enrollment|30 days|you qualify/);
    assert.equal(response.split('(925) 284-6161').length - 1, 1);
    assert.equal(response.split('\n').length, 3);
  }
});
test('confirmed application timing stays separate from booking timing', () => {
  const response = bookingGuidance(question, { ...provider, booking: { ...provider.booking, application: { required: true, processing_time: { kind: 'up_to', value: 21, unit: 'calendar_days' } } } })!;
  assert.match(response, /application is required/);
  assert.match(response, /up to 21 calendar days; this is separate from booking notice/);
  assert.match(response, /notice: 7 days/);
});
test('unknown or short booking notice never becomes a refusal or guarantee', () => {
  for (const notice of [undefined, '1–7 days', 'Call to confirm']) {
    const response = bookingGuidance(question, { ...provider, schedule_type: { advance_notice: notice } })!;
    assert.match(response, /confirm whether a ride tomorrow is possible/);
    assert.doesNotMatch(response, /Do not expect|application is required/);
  }
});
test('no-application flag does not waive booking notice', () => {
  const response = bookingGuidance(question, { ...provider, booking: { application: { required: false, processing_time: '30 days' } } })!;
  assert.match(response, /No initial application is required/);
  assert.match(response, /Do not expect a ride tomorrow/);
  assert.doesNotMatch(response, /30 days/);
});
test('unrelated, multi-provider and actual route searches keep the existing flow', () => {
  assert.equal(timelineProviderQuestion('How much is Mobility Matters?'), null);
  assert.equal(timelineProviderQuestion('Compare Mobility Matters and LINK Paratransit application times'), null);
  assert.equal(timelineProviderQuestion('Find me a ride from Concord to Walnut Creek with Mobility Matters; do I apply first?'), null);
  assert.equal(bookingGuidance(question, [provider]), null);
  assert.equal(bookingGuidance(question, { provider_name: 'Other provider' }), null);
});
