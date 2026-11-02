import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBookingValue, providerTimeline, processingTimeFromForm, formatProcessingTime } from '../../src/lib/providers/providerTimeline';

test('LINK application instructions do not turn its 1–7 day booking window into processing time', () => {
  const result = providerTimeline({
    provider_name: 'LINK Paratransit',
    eligibility_reqs: 'Eligibility: Disabled (18+). Proof: Complete County Connection LINK ADA application.',
    schedule_type: JSON.stringify({ type: 'in-advance-book', advance_notice: '1-7 days' }),
    booking: JSON.stringify({ method: 'call', details: '(925)938-7433' }),
  });
  assert.equal(result.required, true);
  assert.equal(result.processingTime, null);
  assert.equal(result.bookingNotice, '1-7 days');
});

test('Mobility Matters booking notice and lack of proof do not establish an application requirement', () => {
  const result = providerTimeline({
    eligibility_reqs: 'Eligibility: Senior (60+) or veteran. Proof: No proof mentioned on website.',
    schedule_type: { type: 'in-advance-book', advance_notice: '7 days' },
  });
  assert.equal(result.required, null);
  assert.equal(result.processingTime, null);
  assert.equal(result.bookingNotice, '7 days');
});

test('curated application information remains separate from local and regional booking windows', () => {
  const result = providerTimeline({
    booking: { application: { required: true, processing_time: 'Provider-confirmed processing period', instructions: 'Contact the application office.', source_url: 'https://provider.example/apply', verified_at: '2026-11-02' } },
    schedule_type: { advance_notice: '2-14 days', regional_advance_notice: 'up to 14 days' },
  });
  assert.equal(result.processingTime, 'Provider-confirmed processing period');
  assert.equal(result.regionalNotice, 'up to 14 days');
  assert.equal(result.sourceUrl, 'https://provider.example/apply');
  assert.equal(result.verifiedAt, '2026-11-02');
});

test('no advance booking is independent of first-time enrollment', () => {
  const result = providerTimeline({ booking: { method: 'none', application: { required: true } } });
  assert.equal(result.required, true);
  assert.equal(result.bookingNotice, 'No advance booking required.');
});

test('explicit no-application status hides old processing times and unsafe sources are not links', () => {
  const result = providerTimeline({ booking: { application: { required: false, processing_time: 'Old time', source_url: 'javascript:alert(1)' } } });
  assert.equal(result.required, false);
  assert.equal(result.processingTime, null);
  assert.equal(result.sourceUrl, null);
  assert.equal(providerTimeline({ eligibility_reqs: 'No application required.' }).required, false);
});

test('missing records remain unknown and fixed-route data is identified', () => {
  assert.equal(providerTimeline({}).required, null);
  assert.equal(providerTimeline({}).processingTime, null);
  assert.equal(providerTimeline({ provider_type: 'Fixed Route' }).fixedRoute, true);
});

test('optional or conditional application notes are not turned into first-time enrollment rules', () => {
  for (const eligibility_reqs of [
    'Application optional. You may complete an application online.',
    'Do not submit an application until you contact the office.',
    'No application required for already approved riders.',
    'Complete an application if you need the special program.',
  ]) assert.equal(providerTimeline({ eligibility_reqs }).required, null, eligibility_reqs);
});

test('editing booking application details preserves other contact and application metadata', () => {
  const original = { method: 'call', details: 'Existing contact', phone: '925-555-0100', custom: 'Keep this', application: { required: true, processing_time: 'Old value', source_note: 'Preserve this source note' } };
  const updated = buildBookingValue(original, 'app', 'Booking app', { required: true, processing_time: 'Updated confirmed value', source_url: 'https://provider.example/apply', verified_at: '2026-11-02' });
  assert.equal(updated!.phone, original.phone);
  assert.equal(updated!.custom, original.custom);
  assert.equal((updated!.application as any).source_note, original.application.source_note);
  assert.equal((updated!.application as any).processing_time, 'Updated confirmed value');
  assert.equal(updated!.method, 'app');
  assert.equal(updated!.details, 'Booking app');
  assert.equal(original.application.processing_time, 'Old value', 'Do not mutate the source record');
  const cleared = buildBookingValue(updated, 'none', '', {});
  assert.equal((cleared!.application as any).required, undefined, 'Unknown is not false');
  assert.equal((cleared!.application as any).processing_time, undefined);
  assert.equal((cleared!.application as any).source_note, original.application.source_note);
});

test('application metadata can be stored before a booking method is known', () => {
  assert.deepEqual(buildBookingValue(null, '', '', { required: true }), { application: { required: true } });
  assert.equal(buildBookingValue(null, '', '', {}), null);
});

test('numeric form choices produce structured processing times with the original units and qualifiers', () => {
  const upTo = processingTimeFromForm({ kind: 'up_to', value: 30, unit: 'calendar_days' });
  assert.deepEqual(upTo.data, { kind: 'up_to', value: 30, unit: 'calendar_days' });
  assert.equal(formatProcessingTime(upTo.data), 'Up to 30 calendar days');
  const range = processingTimeFromForm({ kind: 'range', minimum: 5, maximum: 10, unit: 'business_days' });
  assert.deepEqual(range.data, { kind: 'range', minimum: 5, maximum: 10, unit: 'business_days' });
  assert.equal(formatProcessingTime(range.data), '5–10 business days');
  assert.equal(formatProcessingTime({ kind: 'estimate', value: 1, unit: 'weeks' }), 'About 1 week');
  assert.equal(formatProcessingTime({ kind: 'at_least', value: 2, unit: 'months' }), 'At least 2 months');
  assert.equal(formatProcessingTime({ kind: 'same_day' }), 'Same day');
});

test('unknown stays unknown and malformed durations never become zero-day processing', () => {
  assert.deepEqual(processingTimeFromForm({ kind: 'unknown' }), { error: null });
  for (const value of ['', undefined, null, 0, -1, 2.5, NaN, Infinity, 'not a number']) {
    assert(processingTimeFromForm({ kind: 'estimate', value, unit: 'calendar_days' }).error, String(value));
  }
  assert(processingTimeFromForm({ kind: 'range', minimum: 10, maximum: 5, unit: 'business_days' }).error);
  assert.equal(formatProcessingTime({ kind: 'estimate', value: -1, unit: 'calendar_days' }), null);
  assert.equal(formatProcessingTime({ kind: 'estimate', value: 10, unit: 'unrecognized' }), null);
});

test('structured processing times and confirmation source survive storage and rider formatting', () => {
  const record = buildBookingValue({ method: 'call', details: 'Existing number', custom: 'Keep' }, 'call', 'Existing number', {
    required: true, processing_time: { kind: 'range', minimum: 5, maximum: 10, unit: 'business_days' }, source_type: 'phone', source_notes: 'Confirmed with application office',
  });
  const result = providerTimeline({ booking: JSON.stringify(record), schedule_type: { advance_notice: '2 days' } });
  assert.equal(result.processingTime, '5–10 business days');
  assert.equal(result.bookingNotice, '2 days');
  assert.equal(result.sourceType, 'phone');
  assert.equal(result.sourceNotes, 'Confirmed with application office');
  assert.equal(record!.custom, 'Keep');
});
