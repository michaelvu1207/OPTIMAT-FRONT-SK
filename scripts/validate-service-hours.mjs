#!/usr/bin/env node
/**
 * Validate researched provider service hours before they reach the database.
 *
 * This data decides whether a rider is told a trip is possible at a given time, so nothing gets
 * written on trust. Every accepted entry must parse into the exact shape the chat function's
 * schedule filter reads, and must carry a source URL and a verbatim quote a human can spot-check.
 *
 * Usage:
 *   node scripts/validate-service-hours.mjs /tmp/hours/result-*.json          # report
 *   node scripts/validate-service-hours.mjs --out /tmp/hours/accepted.json ...
 */

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex === -1 ? null : args[outIndex + 1];
const files = args.filter((arg, i) => arg !== '--out' && args[i - 1] !== '--out');

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Mirrors parseTimeToMinutes in supabase/functions/chat/tools.ts for the "HHMM" form. */
function parseHHMM(value) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return null;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2));
  if (minutes > 59) return null;
  if (hours > 24) return null;
  if (hours === 24 && minutes !== 0) return null;
  return hours * 60 + minutes;
}

function describe(entry) {
  const days = entry.day.split('').map((bit, i) => (bit === '1' ? DAY_LABELS[i] : null)).filter(Boolean);
  return `${days.join(',') || 'no days'} ${entry.start}-${entry.end}`;
}

const accepted = [];
const rejected = [];
const skipped = [];
const seen = new Set();

for (const file of files) {
  let rows;
  try {
    const text = readFileSync(file, 'utf8').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    rows = JSON.parse(text);
  } catch (error) {
    console.error(`✗ ${file}: unreadable or invalid JSON — ${error.message}`);
    continue;
  }
  if (!Array.isArray(rows)) {
    console.error(`✗ ${file}: expected a JSON array`);
    continue;
  }

  for (const row of rows) {
    const label = `${row.provider_name || '?'} (${row.provider_id})`;
    const problems = [];

    if (!Number.isInteger(row.provider_id)) problems.push('provider_id is not an integer');
    if (seen.has(row.provider_id)) problems.push('duplicate provider_id across batches');

    if (row.hours === null || row.hours === undefined) {
      skipped.push({ label, kind: row.hours_kind || 'unknown', notes: row.notes || '', quote: row.evidence_quote || '' });
      seen.add(row.provider_id);
      continue;
    }

    if (!Array.isArray(row.hours) || row.hours.length === 0) {
      problems.push('hours must be a non-empty array or null');
    } else {
      for (const entry of row.hours) {
        if (!entry || typeof entry !== 'object') { problems.push('hours entry is not an object'); continue; }
        if (typeof entry.day !== 'string' || !/^[01]{7}$/.test(entry.day)) {
          problems.push(`day "${entry.day}" is not a 7-character 0/1 bitmask`);
          continue;
        }
        if (!entry.day.includes('1')) problems.push('day bitmask selects no days');
        const start = parseHHMM(entry.start);
        const end = parseHHMM(entry.end);
        if (start === null) problems.push(`start "${entry.start}" is not HHMM`);
        if (end === null) problems.push(`end "${entry.end}" is not HHMM`);
        // An end before start would silently be read as an overnight span by the filter, which is
        // usually a transcription error rather than a real overnight service.
        if (start !== null && end !== null && end <= start) {
          problems.push(`end ${entry.end} is not after start ${entry.start}`);
        }
      }
    }

    // Provenance is mandatory: an unsourced hour is indistinguishable from a guess.
    if (typeof row.source_url !== 'string' || !/^https?:\/\//.test(row.source_url)) {
      problems.push('source_url missing or not a URL');
    }
    if (typeof row.evidence_quote !== 'string' || row.evidence_quote.trim().length < 10) {
      problems.push('evidence_quote missing or too short to verify');
    }
    if (row.hours_kind === 'booking_only') {
      problems.push('hours_kind is booking_only — reservation-line hours must not be stored as service hours');
    }
    if (row.confidence === 'low') {
      problems.push('confidence is low — needs a human decision before it reaches riders');
    }

    // An hours claim has to be backed by a quote containing actual clock times. Marketing copy
    // ("gets seniors where they need to go, anytime, day or night") was otherwise being encoded
    // as a 24/7 span, which tells a rider a 3am pickup is confirmed.
    const quoteText = String(row.evidence_quote || '');
    const hasClockTime = /\d{1,2}\s*(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|\bmidnight\b|\bnoon\b/i.test(quoteText);
    if (!hasClockTime) {
      problems.push('evidence_quote contains no clock time — hours cannot be derived from prose like "day or night"');
    }

    // A discount or promotion window is not a service window. The underlying ride may run all day
    // while only the subsidy is time-limited, so storing it would hide a real option.
    if (/\b(promotion|promotional|discount(?:ed)?|coupon|subsid(?:y|ised|ized)|fare deal|off peak deal)\b/i.test(quoteText)) {
      problems.push('evidence_quote describes a promotion/discount window rather than when service operates');
    }

    if (problems.length > 0) {
      rejected.push({ label, problems, row });
    } else {
      accepted.push(row);
      seen.add(row.provider_id);
    }
  }
}

console.log(`\n${accepted.length} accepted · ${skipped.length} no hours found · ${rejected.length} rejected\n`);

if (accepted.length > 0) {
  console.log('Accepted:');
  for (const row of accepted) {
    console.log(`  ✓ ${row.provider_name} (${row.provider_id}) [${row.confidence}]`);
    for (const entry of row.hours) console.log(`      ${describe(entry)}`);
    console.log(`      source: ${row.source_url}`);
    console.log(`      quote:  "${String(row.evidence_quote).slice(0, 150).replace(/\s+/g, ' ')}"`);
    if (row.notes) console.log(`      notes:  ${row.notes}`);
  }
}

if (skipped.length > 0) {
  console.log('\nNo service hours established (left NULL):');
  for (const item of skipped) {
    console.log(`  · ${item.label} [${item.kind}] ${item.notes || item.quote || ''}`.slice(0, 200));
  }
}

if (rejected.length > 0) {
  console.log('\nRejected:');
  for (const item of rejected) {
    console.log(`  ✗ ${item.label}`);
    for (const problem of item.problems) console.log(`      - ${problem}`);
  }
}

if (outPath && accepted.length > 0) {
  writeFileSync(outPath, `${JSON.stringify(accepted, null, 2)}\n`);
  console.log(`\nWrote ${accepted.length} validated providers to ${outPath}`);
}

process.exitCode = rejected.length > 0 ? 1 : 0;
