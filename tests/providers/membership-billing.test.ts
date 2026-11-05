import assert from 'node:assert/strict';
import test from 'node:test';
import { membershipBillingNotice } from '../../src/lib/providers/providerFields';
test('monthly trip allowance is not the membership billing period', () => {
  for (const value of ['$60 membership fee. 10 free trips per month', '$60 membership fee, 10 free trips per month', { type: 'fixed', cost: '$60 membership fee' }]) assert.ok(membershipBillingNotice(value));
  for (const value of ['$60 annual membership fee', '$60/year membership fee', 'Membership fee: $60 per year', 'One-time membership fee', '$2 per trip', { type: 'free' }]) assert.equal(membershipBillingNotice(value), null, JSON.stringify(value));
});
