#!/usr/bin/env node
/**
 * OPTIMAT Provider Migration Script
 * Overwrites the optimat.providers table with data from the CSV.
 * Uses the db-setup Lambda (inside VPC) for all database operations.
 *
 * Usage:
 *   node scripts/migrate-providers.mjs                        # dry-run (validate only)
 *   node scripts/migrate-providers.mjs --execute              # write to DB via Lambda
 *   node scripts/migrate-providers.mjs --execute --force      # skip orphan check abort
 *   node scripts/migrate-providers.mjs --skip-boundaries      # skip Nominatim fetching
 *
 * Requires:
 *   AWS CLI configured with the "path" profile
 *   db-setup Lambda deployed with "migrate-providers" action
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { parse } from 'csv-parse/sync';
import { fetchMultiCityBoundary } from './fetch-city-boundaries.mjs';
import {
  DEFAULT_UPDATED_PROVIDERS_CSV,
  applyManualProviderDefaults,
  getArgValue,
  getDbLookupName,
  parseCityNames,
  parseEligibility,
  parseFare,
  resolveCanonicalProviderName,
  shouldSkipProvider,
} from './provider-cleaning.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FLAGS = {
  execute: process.argv.includes('--execute'),
  force: process.argv.includes('--force'),
  skipBoundaries: process.argv.includes('--skip-boundaries'),
};

const CSV_PATH = getArgValue(process.argv, '--csv') || DEFAULT_UPDATED_PROVIDERS_CSV;
const BACKUP_DIR = path.join(__dirname, 'backup');

const AWS_PROFILE = 'path';
const AWS_REGION = 'us-west-1';
const LAMBDA_FUNCTION = 'optimat-api-DbSetupFunction-5xHdMWRWSxQT';

// ---------------------------------------------------------------------------
// Lambda invocation helper
// ---------------------------------------------------------------------------

function invokeLambda(payload) {
  const tmpIn = path.join(__dirname, '.lambda-payload.json');
  const tmpOut = path.join(__dirname, '.lambda-response.json');

  fs.writeFileSync(tmpIn, JSON.stringify(payload), 'utf-8');

  try {
    execSync(
      `aws lambda invoke --function-name "${LAMBDA_FUNCTION}" --payload fileb://${tmpIn} --cli-binary-format raw-in-base64-out --profile ${AWS_PROFILE} --region ${AWS_REGION} ${tmpOut}`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 },
    );

    const response = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
    return response;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Service zone resolution
// ---------------------------------------------------------------------------

async function resolveServiceZone(providerName, col4, col11, existingRow) {
  // Always fetch boundaries from scratch for any provider with city names
  if (!FLAGS.skipBoundaries) {
    const cities = parseCityNames(col4);
    if (cities.length > 0) {
      const preview = cities.slice(0, 5).join(', ') + (cities.length > 5 ? '…' : '');
      console.log(`  [service-zone] Fetching Nominatim boundaries for "${providerName}": ${preview}`);
      try {
        const zone = await fetchMultiCityBoundary(cities);
        if (zone) return zone;
        console.warn(`  [WARN] Nominatim returned no results for "${providerName}" — preserving existing`);
      } catch (e) {
        console.warn(`  [WARN] Nominatim error for "${providerName}": ${e.message} — preserving existing`);
      }
    }
  }

  return existingRow?.service_zone ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== OPTIMAT Provider Migration ===');
  console.log(`Mode: ${FLAGS.execute ? 'EXECUTE (via Lambda)' : 'DRY RUN'}`);
  if (FLAGS.force) console.log('Flag: --force  (orphan-check abort disabled)');
  if (FLAGS.skipBoundaries) console.log('Flag: --skip-boundaries  (Nominatim skipped)');
  console.log(`Lambda: ${LAMBDA_FUNCTION}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log();

  // ------------------------------------------------------------------
  // Step 1: Fetch existing providers from DB via Lambda
  // ------------------------------------------------------------------
  console.log('--- Step 1: Fetch existing providers from Aurora ---');
  const checkResult = invokeLambda({
    action: 'run-sql',
    sql: 'SELECT * FROM optimat.providers ORDER BY provider_id',
  });

  if (!checkResult.success) {
    console.error('ERROR: Could not query existing providers:', checkResult.error);
    process.exit(1);
  }

  const existingRows = checkResult.rows || [];
  console.log(`  Found ${existingRows.length} existing providers in Aurora`);

  // Save backup locally
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `providers-backup-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existingRows, null, 2), 'utf-8');
  console.log(`  Backup saved → ${path.relative(process.cwd(), backupPath)}`);

  // ------------------------------------------------------------------
  // Step 2: Build provider_id mapping
  // ------------------------------------------------------------------
  console.log('\n--- Step 2: Build provider_id map ---');

  const dbByName = new Map();
  let maxExistingId = 0;
  for (const row of existingRows) {
    dbByName.set(row.provider_name, row);
    if ((row.provider_id ?? 0) > maxExistingId) maxExistingId = row.provider_id;
  }

  const mapWarnings = [];
  const seenMapWarnings = new Set();
  let nextNewId = maxExistingId + 1;

  function addMapWarning(message) {
    if (seenMapWarnings.has(message)) return;
    seenMapWarnings.add(message);
    mapWarnings.push(message);
  }

  function resolveProvider(csvName) {
    if (shouldSkipProvider(csvName)) return { skip: true };

    const providerName = resolveCanonicalProviderName(csvName);
    const lookupName = getDbLookupName(csvName, providerName);
    const dbRow = dbByName.get(lookupName) ?? null;
    if (!dbRow) {
      addMapWarning(`No DB match for CSV provider: "${csvName}" using lookup "${lookupName}" — treating as new`);
      return { skip: false, providerName, dbRow: null, isNew: true };
    }
    return { skip: false, providerName, dbRow, isNew: false };
  }

  // ------------------------------------------------------------------
  // Step 3: Parse CSV
  // ------------------------------------------------------------------
  console.log('\n--- Step 3: Parse CSV ---');
  const rawCsv = fs.readFileSync(CSV_PATH, 'utf-8');
  const allRows = parse(rawCsv, {
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  });
  const csvRows = allRows.slice(1);
  console.log(`  Parsed ${csvRows.length} CSV rows (excluding header)`);

  // ------------------------------------------------------------------
  // Step 4: Map fields
  // ------------------------------------------------------------------
  console.log('\n--- Step 4: Map fields ---');

  // Pass 1: assign provider_ids
  const providerIdForCsvName = new Map();
  for (const row of csvRows) {
    const csvName = row[0]?.trim();
    if (!csvName) continue;
    const { skip, dbRow, isNew } = resolveProvider(csvName);
    if (skip) continue;
    if (!providerIdForCsvName.has(csvName)) {
      providerIdForCsvName.set(csvName, isNew || !dbRow ? nextNewId++ : dbRow.provider_id);
    }
  }

  // Pass 2: build full provider records
  const providers = [];
  const idMapping = [];

  for (const row of csvRows) {
    const csvName = row[0]?.trim();
    if (!csvName) continue;

    const { skip, providerName, dbRow, isNew } = resolveProvider(csvName);
    if (skip) {
      console.log(`  Skipping retired or merged provider "${csvName}"`);
      continue;
    }

    const providerId = providerIdForCsvName.get(csvName);
    if (providerId === undefined) continue;

    const col1  = row[1]  ?? '';  // Eligibility (provider website)
    const col3  = row[3]  ?? '';  // Service Area Cities (provider website)
    const col4  = row[4]  ?? '';  // Cost (provider website)
    const col5  = row[5]  ?? '';  // Website
    const col9  = row[9]  ?? '';  // To tool developers

    const eligibilityReqs = parseEligibility(col1);
    const fare            = parseFare(col4, dbRow?.fare);
    const website = /^https?:\/\//i.test(col5) ? col5 : (dbRow?.website ?? null);
    const serviceZone = await resolveServiceZone(providerName, col3, col9, dbRow);

    providers.push(applyManualProviderDefaults({
      provider_id:       providerId,
      provider_name:     providerName,
      provider_type:     dbRow?.provider_type     ?? null,
      routing_type:      dbRow?.routing_type      ?? null,
      schedule_type:     dbRow?.schedule_type     ?? null,
      planning_type:     dbRow?.planning_type     ?? null,
      eligibility_reqs:  eligibilityReqs,
      booking:           dbRow?.booking           ?? null,
      fare,
      service_hours:     dbRow?.service_hours     ?? null,
      service_zone:      serviceZone,
      website,
      provider_org:      dbRow?.provider_org      ?? null,
      contacts:          dbRow?.contacts          ?? null,
      round_trip_booking: dbRow?.round_trip_booking ?? null,
      investigated:      dbRow?.investigated      ?? null,
    }));

    idMapping.push({
      csvName,
      providerName,
      oldId: dbRow?.provider_id ?? null,
      newId: providerId,
      isNew,
    });
  }

  for (const w of mapWarnings) {
    console.warn(`  [WARN] ${w}`);
  }
  console.log(`  Mapped ${providers.length} providers`);

  // ------------------------------------------------------------------
  // Dry-run output
  // ------------------------------------------------------------------
  console.log('\n=== PROVIDER SUMMARY ===');
  console.log(`Total providers to write: ${providers.length}`);

  console.log('\nProvider ID mapping (csv name → canonical name → id):');
  const maxCsv = Math.max(...idMapping.map(m => m.csvName.length));
  for (const m of idMapping) {
    const wasStr = m.oldId !== null ? `was ${m.oldId}` : 'NEW';
    const nameCol = m.csvName === m.providerName
      ? m.csvName.padEnd(maxCsv)
      : `${m.csvName.padEnd(maxCsv)} → ${m.providerName}`;
    console.log(`  ${nameCol}  id=${m.newId}  (${wasStr})`);
  }

  if (mapWarnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of mapWarnings) console.log(`  ⚠  ${w}`);
  }

  console.log('\nProvider details (name · eligibility · fare · service_zone · website):');
  for (const p of providers) {
    const szDesc = !p.service_zone
      ? 'null'
      : p.service_zone.type === 'FeatureCollection'
        ? `FeatureCollection (${p.service_zone.features?.length ?? '?'} features)`
        : p.service_zone.type;

    console.log(`\n  [${p.provider_id}] ${p.provider_name}`);
    console.log(`       eligibility_reqs : ${JSON.stringify(p.eligibility_reqs)}`);
    console.log(`       fare             : ${JSON.stringify(p.fare)}`);
    console.log(`       service_zone     : ${szDesc}`);
    console.log(`       website          : ${p.website ?? 'null'}`);
  }

  if (!FLAGS.execute) {
    console.log('\n[DRY RUN] No data written. Re-run with --execute to apply changes.');
    return;
  }

  // ------------------------------------------------------------------
  // Step 5: Write to DB via Lambda
  // ------------------------------------------------------------------
  console.log('\n--- Step 5: Write to DB via Lambda ---');
  console.log('  Invoking db-setup Lambda with migrate-providers action…');
  console.log(`  Sending ${providers.length} providers (payload may take a moment)…`);

  const migrateResult = invokeLambda({
    action: 'migrate-providers',
    providers,
    force: FLAGS.force,
  });

  if (!migrateResult.success) {
    console.error('\n  ERROR:', migrateResult.error);
    if (migrateResult.orphans?.length > 0) {
      console.error('  Orphaned provider_id references:');
      for (const o of migrateResult.orphans) {
        console.error(`    ${o.table}: ids [${o.ids.join(', ')}]`);
      }
      console.error('  Re-run with --force to proceed despite orphans.');
    }
    process.exit(1);
  }

  console.log(`\n  ✓ Deleted ${migrateResult.deleted} existing providers`);
  console.log(`  ✓ Inserted ${migrateResult.inserted} new providers`);

  if (migrateResult.orphans?.length > 0) {
    console.warn('  ⚠ Orphaned references (--force used):');
    for (const o of migrateResult.orphans) {
      console.warn(`    ${o.table}: ids [${o.ids.join(', ')}]`);
    }
  } else {
    console.log('  ✓ Orphan check: OK');
  }

  console.log('\n=== Migration Complete ===');
  console.log(`  Providers written : ${migrateResult.inserted}`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
