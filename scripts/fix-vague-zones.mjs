#!/usr/bin/env node
/**
 * Fill in service zones for providers with vague/missing areas.
 * Uses best-judgment city lists based on known service descriptions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { fetchMultiCityBoundary } from './fetch-city-boundaries.mjs';

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

// Best-judgment city lists for providers with vague service area descriptions
const VAGUE_PROVIDERS = {
  'TDT ADA Paratransit': {
    // "All nine Bay Area Counties" — the 9 counties
    cities: [
      'Alameda County', 'Contra Costa County', 'Marin County',
      'Napa County', 'San Francisco', 'San Mateo County',
      'Santa Clara County', 'Solano County', 'Sonoma County'
    ],
    qualifier: 'California, USA',
  },
  'TDT Senior Paratransit': {
    // "Eastern Contra Costa County" — eastern CCC cities
    cities: [
      'Antioch', 'Brentwood', 'Oakley', 'Pittsburg',
      'Bay Point', 'Discovery Bay', 'Knightsen', 'Byron'
    ],
    qualifier: 'Contra Costa County, California, USA',
  },
  'Tri Delta Transit': {
    // Fixed route serving Eastern Contra Costa
    cities: [
      'Antioch', 'Brentwood', 'Oakley', 'Pittsburg',
      'Bay Point', 'Hercules', 'Concord'
    ],
    qualifier: 'California, USA',
  },
  'Richmond Moves': {
    // Richmond on-demand shuttle
    cities: ['Richmond'],
    qualifier: 'California, USA',
  },
  'WestCAT': {
    // Fixed route serving West Contra Costa County corridor
    cities: [
      'Pinole', 'Hercules', 'El Cerrito', 'Richmond',
      'San Pablo', 'El Sobrante'
    ],
    qualifier: 'California, USA',
  },
  'Walnut Creek Lyft Self Access Pass': {
    // Walnut Creek Lyft pass service area from updated provider validation sheet
    cities: ['Walnut Creek', 'Concord', 'Clayton', 'Pleasant Hill', 'Martinez'],
    qualifier: 'Contra Costa County, California, USA',
  },
  'Walnut Creek Lyft Concierge Pass': {
    // Walnut Creek Lyft concierge service area from updated provider validation sheet
    cities: ['Walnut Creek', 'Concord', 'Clayton', 'Pleasant Hill', 'Martinez'],
    qualifier: 'Contra Costa County, California, USA',
  },
};

async function main() {
  console.log('=== Fixing vague service zones ===\n');

  // Get current providers from DB
  const current = invokeLambda({
    action: 'run-sql',
    sql: 'SELECT provider_id, provider_name, service_zone IS NOT NULL as has_zone FROM optimat.providers ORDER BY provider_id',
  });

  if (!current.success) {
    console.error('Failed to query providers:', current.error);
    process.exit(1);
  }

  const providerMap = new Map();
  for (const row of current.rows) {
    providerMap.set(row.provider_name, row);
  }

  for (const [name, config] of Object.entries(VAGUE_PROVIDERS)) {
    const provider = providerMap.get(name);
    if (!provider) {
      console.log(`  ⚠ Provider "${name}" not found in DB — skipping`);
      continue;
    }

    if (provider.has_zone) {
      console.log(`  ✓ "${name}" already has a service zone — skipping`);
      continue;
    }

    console.log(`  Fetching boundaries for "${name}": ${config.cities.join(', ')}`);
    const zone = await fetchMultiCityBoundary(config.cities, config.qualifier);

    if (!zone) {
      console.log(`    ✗ No boundaries returned — skipping`);
      continue;
    }

    console.log(`    Got FeatureCollection with ${zone.features.length} features`);

    // Update in DB
    const updateResult = invokeLambda({
      action: 'run-sql',
      sql: `UPDATE optimat.providers SET service_zone = $1::jsonb WHERE provider_id = ${provider.provider_id}`,
    });

    // run-sql doesn't support parameterized queries, use load approach instead
    // Actually let's just use a raw SQL with the JSON embedded
    const zoneJson = JSON.stringify(zone).replace(/'/g, "''");
    const result = invokeLambda({
      action: 'run-sql',
      sql: `UPDATE optimat.providers SET service_zone = '${zoneJson}'::jsonb WHERE provider_id = ${provider.provider_id}`,
    });

    if (result.success) {
      console.log(`    ✓ Updated "${name}" (provider_id=${provider.provider_id})`);
    } else {
      console.log(`    ✗ Failed to update: ${result.error}`);
    }
  }

  // Final count
  const final = invokeLambda({
    action: 'run-sql',
    sql: 'SELECT count(*) as total, count(service_zone) as with_zone FROM optimat.providers',
  });

  if (final.success) {
    const r = final.rows[0];
    console.log(`\n=== Done ===`);
    console.log(`  Total providers: ${r.total}`);
    console.log(`  With service zone: ${r.with_zone}`);
    console.log(`  Without service zone: ${r.total - r.with_zone}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
