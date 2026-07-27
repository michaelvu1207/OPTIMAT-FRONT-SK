#!/usr/bin/env node
/**
 * Write validated provider service hours to the database, with provenance.
 *
 * Input is the output of scripts/validate-service-hours.mjs, which has already checked the shape,
 * the day bitmask, the time format, and that every row carries a source URL and a quote. This
 * script only writes; it does not decide what is trustworthy.
 *
 * Usage:
 *   node scripts/apply-service-hours.mjs /tmp/hours/accepted.json --dry-run
 *   node scripts/apply-service-hours.mjs /tmp/hours/accepted.json
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inputPath = args.find((arg) => !arg.startsWith('--'));
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'htjohidcoyfuwfjecazu';

if (!inputPath) {
  console.error('Usage: node scripts/apply-service-hours.mjs <accepted.json> [--dry-run]');
  process.exit(2);
}

function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  // The Supabase CLI stores its token in the macOS keychain via go-keyring.
  const raw = execSync('security find-generic-password -s "Supabase CLI" -a supabase -w', { encoding: 'utf8' }).trim();
  const encoded = raw.replace(/^go-keyring-base64:/, '');
  return Buffer.from(encoded, 'base64').toString('utf8').trim();
}

async function runSql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await response.json();
  if (!response.ok || body?.message) throw new Error(body?.message || `HTTP ${response.status}`);
  return body;
}

const quote = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);

const rows = JSON.parse(readFileSync(inputPath, 'utf8'));
console.log(`${rows.length} provider(s) to update on project ${PROJECT_REF}${dryRun ? ' (dry run)' : ''}\n`);

const statements = rows.map((row) => {
  const serviceHours = JSON.stringify({ hours: row.hours });
  return `UPDATE optimat.providers SET
  service_hours = ${quote(serviceHours)}::jsonb,
  service_hours_source = ${quote(row.source_url)},
  service_hours_quote = ${quote(String(row.evidence_quote || '').slice(0, 500))},
  service_hours_confidence = ${quote(row.confidence)},
  service_hours_notes = ${quote(row.notes ? String(row.notes).slice(0, 400) : null)},
  service_hours_verified_at = NOW()
WHERE provider_id = ${Number(row.provider_id)};`;
});

for (const [index, row] of rows.entries()) {
  console.log(`  ${row.provider_id} ${row.provider_name}: ${row.hours.map((h) => `${h.day} ${h.start}-${h.end}`).join(' | ')}`);
  if (dryRun) console.log(`      ${statements[index].split('\n')[1].trim()}`);
}

if (dryRun) {
  console.log('\nDry run — nothing written.');
  process.exit(0);
}

await runSql(statements.join('\n'));

const check = await runSql(
  `SELECT provider_id, provider_name, service_hours, service_hours_confidence
     FROM optimat.providers
    WHERE service_hours IS NOT NULL
    ORDER BY provider_id;`,
);
console.log(`\nWrote hours. ${check.length} provider(s) now have service_hours set:`);
for (const row of check) {
  const entries = (row.service_hours?.hours || []).map((h) => `${h.day} ${h.start}-${h.end}`).join(' | ');
  console.log(`  ${row.provider_id} ${row.provider_name} [${row.service_hours_confidence}] ${entries}`);
}
