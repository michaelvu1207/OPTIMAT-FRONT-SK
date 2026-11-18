import assert from 'node:assert/strict';
import test from 'node:test';
import { dateFromMessage, resolveTravelDate, invalidDateResponse } from './travel-date.js';
const monday = new Date('2026-11-16T20:00:00Z');

test('reported next Friday is November 20, using the Pacific date and next occurrence', () => {
  for (const now of [monday, new Date('2026-11-16T06:00:00Z'), new Date('2026-11-20T07:59:00Z')]) {
    const resolved = resolveTravelDate('next Friday', now);
    assert.equal(resolved.iso, '2026-11-20');
    assert.equal(resolved.display, 'Friday, November 20, 2026');
  }
  assert.equal(resolveTravelDate('next Friday', new Date('2026-11-20T08:01:00Z')).iso, '2026-11-27');
});

test('calendar advancement survives DST, leap day, and year boundaries', () => {
  for (const [now, expected] of [['2026-03-08T07:30:00Z', '2026-03-08'], ['2026-11-01T07:30:00Z', '2026-11-02'], ['2027-01-01T07:30:00Z', '2027-01-01'], ['2028-02-29T07:30:00Z', '2028-02-29']]) {
    assert.equal(resolveTravelDate('tomorrow', new Date(now)).iso, expected);
  }
});

test('date extraction ignores address numbers and preserves explicit dates', () => {
  const message = 'Hi, I am planning a trip from 3815 Lakeside Dr Building F in Richmond to 365 Lennon Ln in Walnut Creek for next Friday. I am leaving at 12pm and returning at 3pm. San Pablo resident. Age 65+.';
  assert.equal(dateFromMessage(message, monday)?.iso, '2026-11-20');
  assert.equal(dateFromMessage('Use 2026-11-20. Same 12pm departure and 3pm return.', monday)?.iso, '2026-11-20');
  assert.equal(dateFromMessage('Today I want to book for November 20, 2026.', monday)?.iso, '2026-11-20');
  assert.equal(dateFromMessage('I live at 3815 Lakeside Dr. I am 65 and leaving at 12pm.', monday), undefined);
  assert.equal(dateFromMessage('Please keep the same date.', monday), undefined);
});

test('real weekday conflicts, impossible dates, and multiple dates require clarification', () => {
  assert.equal(resolveTravelDate('Friday, November 20, 2026', monday).error, null);
  assert.match(resolveTravelDate('Friday, November 21, 2026', monday).error!, /Saturday/);
  for (const phrase of ['2026-02-29', 'Friday, February 30, 2026', '11/31/2026']) assert.equal(resolveTravelDate(phrase, monday).iso, null);
  assert.match(dateFromMessage('November 20, 2026 or November 27, 2026', monday)?.error || '', /more than one/);
});

test('response validation catches both reported model errors without rejecting correct dates', () => {
  const date = resolveTravelDate('2026-11-20', monday);
  for (const response of ['Date: Friday, November 21, 2026', 'November 20, 2026 is a Thursday.', 'Date: Saturday, November 21, 2026']) assert.equal(invalidDateResponse(response, date), true, response);
  assert.equal(invalidDateResponse('Date: Friday, November 20, 2026', date), false);
});
