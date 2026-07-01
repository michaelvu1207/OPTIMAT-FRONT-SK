#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const CSV_PATH = getArgValue(process.argv, '--csv') || DEFAULT_UPDATED_PROVIDERS_CSV;
const API_BASE = 'https://htjohidcoyfuwfjecazu.supabase.co/functions/v1/providers';
const BACKUP_DIR = path.join(__dirname, 'backup');
const APPLY = process.argv.includes('--apply');
const SKIP_BOUNDARIES = process.argv.includes('--skip-boundaries');

const NEW_PROVIDER_IDS = {
  'Richmond Moves': 5029,
  'Walnut Creek Lyft Self Access Pass': 5031,
  'Walnut Creek Lyft Concierge Pass': 5032,
};

const NEW_PROVIDER_BASE_NAMES = {
  'Walnut Creek Lyft Self Access Pass': 'Walnut Creek Lyft Rideshare',
  'Walnut Creek Lyft Concierge Pass': 'Walnut Creek Lyft Rideshare',
};

const DELETE_PROVIDER_IDS = [3018, 3019, 3020, 5030];

const MANUAL_SERVICE_AREA_NAMES = {
  'All nine Bay Area Counties': [
    'Alameda County',
    'Contra Costa County',
    'Marin County',
    'Napa County',
    'San Francisco County',
    'San Mateo County',
    'Santa Clara County',
    'Solano County',
    'Sonoma County',
  ],
};

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function loadEnvValue(name) {
  if (process.env[name]) return process.env[name];

  for (const envPath of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || match[1] !== name) continue;
      return match[2].replace(/^['"]|['"]$/g, '');
    }
  }

  return null;
}

function authHeaders(extra = {}) {
  const anonKey = loadEnvValue('VITE_SUPABASE_ANON_KEY') || loadEnvValue('SUPABASE_ANON_KEY');
  if (!anonKey) return extra;
  return {
    ...extra,
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

function cleanProvider(row) {
  const out = { ...row };
  for (const key of ['schedule_type', 'eligibility_reqs', 'booking', 'fare', 'contacts', 'service_zone']) {
    out[key] = parseMaybeJson(out[key]);
  }
  return out;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  if (value === null || value === undefined) return 'null';
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

async function fetchExistingProviders() {
  const response = await fetch(API_BASE, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GET /providers failed: HTTP ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const data = Array.isArray(payload) ? payload : payload.data;
  if (!Array.isArray(data)) {
    throw new Error('GET /providers returned an unexpected payload shape');
  }
  return data.map(cleanProvider);
}

async function resolveServiceZone(providerName, serviceAreaText, existingRow) {
  if (SKIP_BOUNDARIES) return existingRow?.service_zone ?? null;

  const trimmedServiceArea = serviceAreaText.trim().replace(/\.$/, '');
  const areaNames = MANUAL_SERVICE_AREA_NAMES[trimmedServiceArea] ?? parseCityNames(serviceAreaText);
  if (areaNames.length === 0) return existingRow?.service_zone ?? null;

  try {
    const zone = await fetchMultiCityBoundary(areaNames);
    return zone ?? existingRow?.service_zone ?? null;
  } catch (error) {
    console.warn(`[service-zone] ${providerName}: ${error.message}; preserving existing zone`);
    return existingRow?.service_zone ?? null;
  }
}

function updatePayload(provider) {
  return {
    provider_id: provider.provider_id,
    provider_name: provider.provider_name,
    provider_type: provider.provider_type,
    routing_type: provider.routing_type,
    schedule_type: provider.schedule_type,
    eligibility_reqs: provider.eligibility_reqs,
    booking: provider.booking,
    fare: provider.fare,
    contacts: provider.contacts,
    website: provider.website,
    round_trip_booking: provider.round_trip_booking,
    investigated: provider.investigated,
    service_zone: provider.service_zone,
  };
}

async function postProvider(provider) {
  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(updatePayload(provider)),
  });

  if (!response.ok) {
    throw new Error(`POST ${provider.provider_id} ${provider.provider_name} failed: HTTP ${response.status} ${await response.text()}`);
  }
}

async function putProvider(provider) {
  const response = await fetch(`${API_BASE}/${provider.provider_id}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(updatePayload(provider)),
  });

  if (!response.ok) {
    throw new Error(`PUT ${provider.provider_id} ${provider.provider_name} failed: HTTP ${response.status} ${await response.text()}`);
  }
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  const existingRows = await fetchExistingProviders();
  const backupPath = path.join(BACKUP_DIR, `supabase-providers-backup-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existingRows, null, 2));

  const existingByName = new Map(existingRows.map((row) => [row.provider_name, row]));
  const existingById = new Map(existingRows.map((row) => [String(row.provider_id), row]));

  const rows = parse(fs.readFileSync(CSV_PATH, 'utf-8'), {
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }).slice(1);

  const providers = [];
  const mapping = [];

  for (const row of rows) {
    const csvName = row[0]?.trim();
    if (!csvName || shouldSkipProvider(csvName)) continue;

    const providerName = resolveCanonicalProviderName(csvName);
    const lookupName = getDbLookupName(csvName, providerName);
    const baseName = NEW_PROVIDER_BASE_NAMES[csvName] ?? lookupName;
    const existingRow = existingByName.get(baseName) ?? existingByName.get(providerName) ?? null;
    const providerId = NEW_PROVIDER_IDS[csvName] ?? existingRow?.provider_id;

    if (!providerId) {
      throw new Error(`No provider_id mapping for ${csvName} (lookup ${lookupName})`);
    }

    const eligibilityReqs = parseEligibility(row[1] ?? '');
    const fare = parseFare(row[4] ?? '', existingRow?.fare);
    const website = /^https?:\/\//i.test(row[5] ?? '') ? row[5] : (existingRow?.website ?? null);
    const serviceZone = await resolveServiceZone(providerName, row[3] ?? '', existingRow);

    const provider = applyManualProviderDefaults({
      provider_id: providerId,
      provider_name: providerName,
      provider_type: existingRow?.provider_type ?? null,
      routing_type: existingRow?.routing_type ?? null,
      schedule_type: existingRow?.schedule_type ?? null,
      planning_type: existingRow?.planning_type ?? null,
      eligibility_reqs: eligibilityReqs,
      provider_org: existingRow?.provider_org ?? null,
      contacts: existingRow?.contacts ?? null,
      booking: existingRow?.booking ?? null,
      fare,
      service_hours: existingRow?.service_hours ?? null,
      service_zone: serviceZone,
      website,
      round_trip_booking: existingRow?.round_trip_booking ?? null,
      investigated: existingRow?.investigated ?? null,
      is_operating: existingRow?.is_operating ?? null,
    });

    providers.push(provider);
    mapping.push({
      csvName,
      providerName,
      providerId,
      existingName: existingRow?.provider_name ?? null,
      newRow: !existingById.has(String(providerId)),
      zoneFeatures: Array.isArray(provider.service_zone?.features) ? provider.service_zone.features.length : 0,
    });
  }

  const payloadPath = path.join(BACKUP_DIR, `supabase-provider-updates-${ts}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ providers, mapping, deleteProviderIds: DELETE_PROVIDER_IDS }, null, 2));
  fs.writeFileSync(path.join(BACKUP_DIR, 'supabase-provider-updates-latest.json'), JSON.stringify({ providers, mapping, deleteProviderIds: DELETE_PROVIDER_IDS }, null, 2));

  const newProviders = providers.filter((provider) => !existingById.has(String(provider.provider_id)));
  const insertRows = newProviders.map((provider) => `(${[
    provider.provider_id,
    sqlString(provider.provider_name),
    sqlString(provider.provider_type),
    sqlString(provider.routing_type),
    sqlJson(provider.schedule_type),
    sqlString(provider.planning_type),
    sqlJson(provider.eligibility_reqs),
    sqlString(provider.provider_org),
    sqlJson(provider.contacts),
    sqlJson(provider.booking),
    sqlJson(provider.fare),
    sqlString(provider.service_hours),
    sqlJson(provider.service_zone),
    sqlString(provider.website),
    provider.round_trip_booking === null || provider.round_trip_booking === undefined ? 'null' : provider.round_trip_booking,
    provider.investigated === null || provider.investigated === undefined ? 'null' : provider.investigated,
    provider.is_operating === null || provider.is_operating === undefined ? 'null' : provider.is_operating,
  ].join(', ')})`);

  const insertSql = insertRows.length
    ? `insert into optimat.providers (provider_id, provider_name, provider_type, routing_type, schedule_type, planning_type, eligibility_reqs, provider_org, contacts, booking, fare, service_hours, service_zone, website, round_trip_booking, investigated, is_operating) values\n${insertRows.join(',\n')}\non conflict (provider_id) do nothing;`
    : '-- no new providers to insert';

  const sqlPath = path.join(BACKUP_DIR, `supabase-provider-insert-delete-${ts}.sql`);
  fs.writeFileSync(sqlPath, `${insertSql}\n\ndelete from optimat.providers where provider_id = any(array[${DELETE_PROVIDER_IDS.join(', ')}]);\n`);

  console.log(`Existing rows backed up: ${path.relative(process.cwd(), backupPath)}`);
  console.log(`Update payload written: ${path.relative(process.cwd(), payloadPath)}`);
  console.log(`Insert/delete SQL written: ${path.relative(process.cwd(), sqlPath)}`);
  console.log(`Mapped providers: ${providers.length}`);
  for (const item of mapping) {
    console.log(`${item.providerId} ${item.csvName}${item.csvName === item.providerName ? '' : ` -> ${item.providerName}`} zone_features=${item.zoneFeatures}${item.newRow ? ' NEW' : ''}`);
  }

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to create missing rows and update mapped providers.');
    return;
  }

  for (const provider of newProviders) {
    await postProvider(provider);
    console.log(`Created ${provider.provider_id} ${provider.provider_name}`);
  }

  for (const provider of providers) {
    await putProvider(provider);
    console.log(`Updated ${provider.provider_id} ${provider.provider_name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
