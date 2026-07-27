#!/usr/bin/env node
/**
 * Fill in blank provider fields from the Supabase snapshot.
 * Only updates NULL columns — never overwrites existing data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AWS_PROFILE = 'path';
const AWS_REGION = 'us-west-1';
const LAMBDA_FUNCTION = 'optimat-api-DbSetupFunction-5xHdMWRWSxQT';
const SNAPSHOT_PATH = path.join(__dirname, '..', 'tests', 'snapshots', 'snapshot-supabase-2026-03-30T22-53-05-352Z.json');

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

// Name mapping: Supabase name → Aurora name (for mismatches)
const SUPABASE_TO_AURORA_NAME = {
  'Arc Contra Costa (Vistability)': 'Arc Contra Costa (Visitability)',
  // Rest should match via the MANUAL_NAME_MAP used during migration
};

// Fields to merge (only fill NULLs)
const MERGE_FIELDS = [
  'provider_type',
  'routing_type',
  'schedule_type',
  'planning_type',
  'booking',
  'service_hours',
  'contacts',
  'provider_org',
  'round_trip_booking',
  'investigated',
];

const JSONB_FIELDS = new Set(['schedule_type', 'booking', 'service_hours', 'contacts']);

async function main() {
  console.log('=== Fill blank fields from Supabase snapshot ===\n');

  // Load Supabase snapshot
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  const supabaseProviders = snapshot.providers['GET /providers'].json.data;
  console.log(`Supabase snapshot: ${supabaseProviders.length} providers`);

  // Build lookup by name
  const supabaseByName = new Map();
  for (const p of supabaseProviders) {
    const name = SUPABASE_TO_AURORA_NAME[p.provider_name] || p.provider_name;
    supabaseByName.set(name, p);
  }

  // Get current Aurora providers
  const current = invokeLambda({
    action: 'run-sql',
    sql: 'SELECT * FROM optimat.providers ORDER BY provider_id',
  });

  if (!current.success) {
    console.error('Failed to query Aurora:', current.error);
    process.exit(1);
  }

  console.log(`Aurora DB: ${current.rows.length} providers\n`);

  let totalUpdates = 0;

  for (const aurora of current.rows) {
    const supa = supabaseByName.get(aurora.provider_name);
    if (!supa) {
      console.log(`  ⚠ No Supabase match for "${aurora.provider_name}" — skipping`);
      continue;
    }

    // Build SET clause for null fields only
    const updates = [];
    const values = [];

    for (const field of MERGE_FIELDS) {
      // Only fill if Aurora value is null and Supabase has data
      if (aurora[field] != null) continue;

      let supaVal = supa[field];
      if (supaVal == null) continue;

      // Parse JSON strings from snapshot
      if (typeof supaVal === 'string' && JSONB_FIELDS.has(field)) {
        try {
          supaVal = JSON.parse(supaVal);
        } catch {
          // keep as-is
        }
      }

      // Skip invalid/junk values
      if (supaVal === 'k' || supaVal === '') continue;

      if (JSONB_FIELDS.has(field)) {
        const jsonStr = JSON.stringify(supaVal).replace(/'/g, "''");
        updates.push(`${field} = '${jsonStr}'::jsonb`);
      } else if (typeof supaVal === 'boolean') {
        updates.push(`${field} = ${supaVal}`);
      } else {
        const escaped = String(supaVal).replace(/'/g, "''");
        updates.push(`${field} = '${escaped}'`);
      }
    }

    if (updates.length === 0) {
      continue;
    }

    const sql = `UPDATE optimat.providers SET ${updates.join(', ')} WHERE provider_id = ${aurora.provider_id}`;
    const result = invokeLambda({ action: 'run-sql', sql });

    if (result.success) {
      console.log(`  ✓ ${aurora.provider_name}: filled ${updates.length} fields`);
      totalUpdates++;
    } else {
      console.log(`  ✗ ${aurora.provider_name}: ${result.error}`);
    }
  }

  console.log(`\n=== Done: updated ${totalUpdates} providers ===`);

  // Final verification
  const verify = invokeLambda({
    action: 'run-sql',
    sql: `SELECT provider_name,
            provider_type IS NOT NULL as has_type,
            routing_type IS NOT NULL as has_routing,
            schedule_type IS NOT NULL as has_schedule,
            booking IS NOT NULL as has_booking,
            contacts IS NOT NULL as has_contacts
          FROM optimat.providers ORDER BY provider_id`,
  });

  if (verify.success) {
    console.log('\nFinal field coverage:');
    let complete = 0;
    for (const r of verify.rows) {
      const missing = Object.entries(r)
        .filter(([k, v]) => k.startsWith('has_') && !v)
        .map(([k]) => k.replace('has_', ''));
      if (missing.length === 0) {
        complete++;
      } else {
        console.log(`  ${r.provider_name}: still missing [${missing.join(', ')}]`);
      }
    }
    console.log(`\n  ${complete}/${verify.rows.length} providers fully populated`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
