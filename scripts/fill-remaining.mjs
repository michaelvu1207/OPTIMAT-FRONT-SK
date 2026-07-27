#!/usr/bin/env node
/**
 * Fill remaining null fields with best-judgment values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AWS_PROFILE = 'path';
const AWS_REGION = 'us-west-1';
const LAMBDA_FUNCTION = 'optimat-api-DbSetupFunction-5xHdMWRWSxQT';

function invokeLambda(payload) {
  const tmpIn = path.join(__dirname, '.lambda-payload.json');
  const tmpOut = path.join(__dirname, '.lambda-response.json');
  fs.writeFileSync(tmpIn, JSON.stringify(payload), 'utf-8');
  try {
    execSync(
      `aws lambda invoke --function-name "${LAMBDA_FUNCTION}" --payload fileb://${tmpIn} --cli-binary-format raw-in-base64-out --profile ${AWS_PROFILE} --region ${AWS_REGION} ${tmpOut}`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 },
    );
    return JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

function runSql(sql) {
  const r = invokeLambda({ action: 'run-sql', sql });
  if (!r.success) console.error('  SQL error:', r.error);
  return r;
}

// Best-judgment fills for remaining gaps
const FILLS = [
  {
    name: 'Walnut Creek Lyft Self Access Pass',
    // Lyft rideshare — use app
    booking: '{"method":"app","details":"Lyft app"}',
  },
  {
    name: 'Walnut Creek Lyft Concierge Pass',
    // Concierge pass — City schedules Lyft rides for the rider
    booking: '{"method":"call","details":"Walnut Creek Lyft concierge scheduling"}',
  },
  {
    name: 'Richmond Moves',
    // On-demand shuttle — use app
    booking: '{"method":"app"}',
  },
  {
    name: 'Wheels Go Tri-Valley',
    // LAVTA rideshare program via Uber/Lyft — discount program
    provider_type: "'Volunteer Driver or TNC'",
    routing_type: "'door-to-door'",
    schedule_type: '{"type":"real-time-book"}',
    booking: '{"method":"app","details":"Uber or Lyft app"}',
    contacts: '[]',
  },
];

async function main() {
  console.log('=== Filling remaining gaps ===\n');

  for (const fill of FILLS) {
    const updates = [];
    for (const [key, val] of Object.entries(fill)) {
      if (key === 'name') continue;
      if (['schedule_type', 'booking', 'contacts'].includes(key)) {
        const escaped = val.replace(/'/g, "''");
        updates.push(`${key} = '${escaped}'::jsonb`);
      } else {
        updates.push(`${key} = ${val}`);
      }
    }

    const escaped = fill.name.replace(/'/g, "''");
    const sql = `UPDATE optimat.providers SET ${updates.join(', ')} WHERE provider_name = '${escaped}' AND (${updates.map(u => u.split(' = ')[0] + ' IS NULL').join(' OR ')})`;
    const result = runSql(sql);
    if (result.success) {
      console.log(`  ✓ ${fill.name}: filled ${updates.length} fields`);
    } else {
      console.log(`  ✗ ${fill.name}: failed`);
    }
  }

  // Final check
  const verify = invokeLambda({
    action: 'run-sql',
    sql: `SELECT provider_name,
            provider_type IS NOT NULL as has_type,
            routing_type IS NOT NULL as has_routing,
            schedule_type IS NOT NULL as has_schedule,
            booking IS NOT NULL as has_booking,
            contacts IS NOT NULL as has_contacts,
            provider_org IS NOT NULL as has_org
          FROM optimat.providers ORDER BY provider_id`,
  });

  if (verify.success) {
    let complete = 0;
    let incomplete = [];
    for (const r of verify.rows) {
      const missing = Object.entries(r)
        .filter(([k, v]) => k.startsWith('has_') && !v)
        .map(([k]) => k.replace('has_', ''));
      if (missing.length === 0) complete++;
      else incomplete.push({ name: r.provider_name, missing });
    }
    console.log(`\n=== ${complete}/${verify.rows.length} providers fully populated ===`);
    for (const i of incomplete) {
      console.log(`  ${i.name}: still missing [${i.missing.join(', ')}]`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
