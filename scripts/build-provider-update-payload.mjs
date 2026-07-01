#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_UPDATED_PROVIDERS_SHEET,
  DEFAULT_UPDATED_PROVIDERS_XLSX,
  readProviderWorkbookRows,
} from './provider-workbook.mjs';
import {
  DEFAULT_COMMUNITY_PLACE_GEOJSON_PATH,
  DEFAULT_SERVICE_AREA_GEOJSON_DIR,
  DEFAULT_ZIP_GEOJSON_PATH,
  loadContraCostaCityIndex,
  loadCommunityPlaceIndex,
  loadZipCodeIndex,
  mergeBoundaryIndexes,
  resolveProviderServiceArea,
} from './service-area-resolver.mjs';
import {
  applyManualProviderDefaults,
  getArgValue,
  getDbLookupName,
  parseEligibility,
  parseFare,
  resolveCanonicalProviderName,
  shouldSkipProvider,
} from './provider-cleaning.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = 'https://htjohidcoyfuwfjecazu.supabase.co/functions/v1/providers';
const BACKUP_DIR = path.join(__dirname, 'backup');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_UNRESOLVED = args.includes('--allow-unresolved');
const SKIP_FETCH_EXISTING = args.includes('--skip-fetch-existing');

const XLSX_PATH = getArgValue(process.argv, '--xlsx') || DEFAULT_UPDATED_PROVIDERS_XLSX;
const SHEET_NAME = getArgValue(process.argv, '--sheet') || DEFAULT_UPDATED_PROVIDERS_SHEET;
const GEOJSON_DIR = getArgValue(process.argv, '--geojson-dir') || DEFAULT_SERVICE_AREA_GEOJSON_DIR;
const COMMUNITY_GEOJSON_PATH = getArgValue(process.argv, '--community-geojson') || DEFAULT_COMMUNITY_PLACE_GEOJSON_PATH;
const ZIP_GEOJSON_PATH = getArgValue(process.argv, '--zip-geojson') || DEFAULT_ZIP_GEOJSON_PATH;
const OUTPUT_PATH = getArgValue(process.argv, '--output') || path.join(BACKUP_DIR, 'provider-update-payload-latest.json');

const NEW_PROVIDER_IDS = {
  'Concord Senior Center Shuttle': 5033,
  'Walnut Creek Lyft Self Access Pass': 5031,
  'Walnut Creek Lyft Concierge Pass': 5032,
};

const NEW_PROVIDER_BASE_NAMES = {
  'Walnut Creek Lyft Self Access Pass': 'Walnut Creek Lyft Rideshare',
  'Walnut Creek Lyft Concierge Pass': 'Walnut Creek Lyft Rideshare',
};

const DELETE_PROVIDER_IDS = [5029];

const MANUAL_SERVICE_AREA_CITIES = {
  'Concord Senior Center Shuttle': 'Concord',
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

function cleanProvider(row) {
  const out = { ...row };
  delete out.contacts;
  for (const key of [
    'schedule_type',
    'eligibility_reqs',
    'booking',
    'fare',
    'service_hours',
    'service_zone',
    'service_area_geojson',
  ]) {
    out[key] = parseMaybeJson(out[key]);
  }
  return out;
}

async function fetchExistingProviders() {
  if (SKIP_FETCH_EXISTING) return [];
  const response = await fetch(API_BASE);
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

function sqlString(value) {
  if (value === null || value === undefined || value === '') return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  if (value === null || value === undefined) return 'null';
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function sqlTextArray(values) {
  if (!Array.isArray(values)) return 'null';
  if (values.length === 0) return "'{}'::text[]";
  return `array[${values.map(sqlString).join(', ')}]::text[]`;
}

function providerUpsertSql(providers) {
  if (providers.length === 0) return '-- no providers to upsert';

  const columns = [
    'provider_id',
    'provider_name',
    'provider_type',
    'routing_type',
    'schedule_type',
    'planning_type',
    'eligibility_reqs',
    'booking',
    'fare',
    'service_hours',
    'service_zone',
    'service_area_geojson',
    'service_area_cities',
    'service_area_source',
    'service_area_notes',
    'website',
    'provider_org',
    'provider_software',
    'round_trip_booking',
    'investigated',
    'updated_at',
  ];

  const rows = providers.map((provider) => `(${[
    provider.provider_id,
    sqlString(provider.provider_name),
    sqlString(provider.provider_type),
    sqlString(provider.routing_type),
    sqlJson(provider.schedule_type),
    sqlString(provider.planning_type),
    sqlJson(provider.eligibility_reqs),
    sqlJson(provider.booking),
    sqlJson(provider.fare),
    sqlJson(provider.service_hours),
    sqlJson(provider.service_zone),
    sqlJson(provider.service_area_geojson),
    sqlTextArray(provider.service_area_cities),
    sqlString(provider.service_area_source),
    sqlString(provider.service_area_notes),
    sqlString(provider.website),
    sqlString(provider.provider_org),
    sqlString(provider.provider_software),
    provider.round_trip_booking === null || provider.round_trip_booking === undefined ? 'null' : provider.round_trip_booking,
    provider.investigated === null || provider.investigated === undefined ? 'null' : provider.investigated,
    'now()',
  ].join(', ')})`);

  const updateColumns = columns.filter((column) => column !== 'provider_id' && column !== 'updated_at');
  return `insert into optimat.providers (${columns.join(', ')}) values\n${rows.join(',\n')}\non conflict (provider_id) do update set\n${updateColumns.map((column) => `  ${column} = excluded.${column}`).join(',\n')},\n  updated_at = now();`;
}

function providerDeleteSql(providerIds) {
  if (providerIds.length === 0) return '-- no providers to delete';
  return `delete from optimat.providers\nwhere provider_id in (${providerIds.map((id) => Number(id)).join(', ')});`;
}

function markdownReport({
  xlsxPath,
  sheetName,
  geojsonDir,
  communityGeoJsonPath,
  zipGeoJsonPath,
  providers,
  mapping,
  missingFromWorkbook,
  deletedProviders,
  unresolved,
}) {
  const customCount = mapping.filter((item) => item.serviceAreaSource === 'custom_geojson').length;
  const cityListCount = mapping.filter((item) => item.serviceAreaSource === 'city_list').length;
  const preservedCount = mapping.filter((item) => item.serviceAreaSource === 'existing_preserved').length;
  const insertCount = mapping.filter((item) => item.newRow).length;
  const updateCount = mapping.filter((item) => !item.newRow).length;

  return [
    '# Provider Update Dry Run',
    '',
    `- Workbook: \`${xlsxPath}\``,
    `- Sheet: \`${sheetName}\``,
    `- GeoJSON directory: \`${geojsonDir}\``,
    `- Community GeoJSON: \`${communityGeoJsonPath}\``,
    `- ZIP GeoJSON: \`${zipGeoJsonPath}\``,
    `- Providers in payload: ${providers.length}`,
    `- Providers to update: ${updateCount}`,
    `- Providers to insert: ${insertCount}`,
    `- Providers to delete: ${deletedProviders.length}`,
    `- Custom GeoJSON providers: ${customCount}`,
    `- City-list-generated providers: ${cityListCount}`,
    `- Existing zones preserved: ${preservedCount}`,
    `- Unresolved providers: ${unresolved.length}`,
    `- Providers missing from workbook: ${missingFromWorkbook.length}`,
    '',
    '## Provider Mapping',
    '',
    '| Provider ID | Workbook name | Canonical name | Service area source | Features | Cities | Unresolved | Provider software |',
    '|---:|---|---|---|---:|---:|---|---|',
    ...mapping.map((item) => [
      `| ${item.providerId ?? ''}`,
      item.csvName,
      item.providerName,
      item.serviceAreaSource,
      item.featureCount,
      item.cityCount,
      item.unresolvedCities.join(', '),
      item.providerSoftware || '',
    ].join(' | ') + ' |'),
    '',
    '## Providers Missing From Workbook',
    '',
    ...(missingFromWorkbook.length
      ? missingFromWorkbook.map((provider) => `- [${provider.provider_id}] ${provider.provider_name}`)
      : ['- None']),
    '',
    '## Provider Inserts',
    '',
    ...(insertCount
      ? mapping.filter((item) => item.newRow).map((item) => `- [${item.providerId}] ${item.providerName}`)
      : ['- None']),
    '',
    '## Provider Deletes',
    '',
    ...(deletedProviders.length
      ? deletedProviders.map((provider) => `- [${provider.provider_id}] ${provider.provider_name}`)
      : ['- None']),
    '',
    '## Provider Updates',
    '',
    ...(updateCount
      ? mapping.filter((item) => !item.newRow).map((item) => `- [${item.providerId}] ${item.providerName}`)
      : ['- None']),
    '',
    '## Unresolved Service Areas',
    '',
    ...(unresolved.length
      ? unresolved.map((item) => `- ${item.providerName}: ${item.unresolvedCities.join(', ') || item.notes}`)
      : ['- None']),
    '',
  ].join('\n');
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const workbookRows = readProviderWorkbookRows(XLSX_PATH, SHEET_NAME);
  const cityIndex = mergeBoundaryIndexes(
    mergeBoundaryIndexes(
      loadContraCostaCityIndex(path.join(GEOJSON_DIR, 'contra_costa_cities.geojson')),
      loadCommunityPlaceIndex(COMMUNITY_GEOJSON_PATH),
    ),
    loadZipCodeIndex(ZIP_GEOJSON_PATH),
  );
  const existingRows = await fetchExistingProviders();
  const existingByName = new Map(existingRows.map((row) => [row.provider_name, row]));
  const existingById = new Map(existingRows.map((row) => [String(row.provider_id), row]));

  const providers = [];
  const mapping = [];

  for (const row of workbookRows) {
    const csvName = row['Provider Name']?.trim();
    if (!csvName || shouldSkipProvider(csvName)) continue;

    const providerName = resolveCanonicalProviderName(csvName);
    const lookupName = getDbLookupName(csvName, providerName);
    const baseName = NEW_PROVIDER_BASE_NAMES[csvName] ?? lookupName;
    const existingRow = existingByName.get(baseName) ?? existingByName.get(providerName) ?? null;
    const providerId = NEW_PROVIDER_IDS[csvName] ?? existingRow?.provider_id;

    if (!providerId) {
      throw new Error(`No provider_id mapping for ${csvName} (lookup ${lookupName})`);
    }

    if (DELETE_PROVIDER_IDS.includes(Number(providerId))) {
      continue;
    }

    const serviceArea = await resolveProviderServiceArea({
      providerName,
      serviceAreaGeoJson: row['Service Area GeoJSON'] ?? '',
      serviceAreaCitiesText: row['Service Area Cities (provider website)'] || MANUAL_SERVICE_AREA_CITIES[providerName] || '',
      geojsonDir: GEOJSON_DIR,
      cityIndex,
      existingServiceZone: existingRow?.service_zone ?? null,
    });

    const eligibilityReqs = parseEligibility(row['Eligibility (provider website)'] ?? '');
    const fare = parseFare(row['Cost (provider website)'] ?? '', existingRow?.fare);
    const website = /^https?:\/\//i.test(row['Service Area Website'] ?? '')
      ? row['Service Area Website']
      : existingRow?.website ?? null;
    const providerSoftware = row['Provider Software ']?.trim() || null;

    const provider = applyManualProviderDefaults({
      provider_id: providerId,
      provider_name: providerName,
      provider_type: existingRow?.provider_type ?? null,
      routing_type: existingRow?.routing_type ?? null,
      schedule_type: existingRow?.schedule_type ?? null,
      planning_type: existingRow?.planning_type ?? null,
      eligibility_reqs: eligibilityReqs,
      booking: existingRow?.booking ?? null,
      fare,
      service_hours: existingRow?.service_hours ?? null,
      service_zone: serviceArea.geojson,
      service_area_geojson: serviceArea.serviceAreaGeoJson,
      service_area_cities: serviceArea.cities,
      service_area_source: serviceArea.source,
      service_area_notes: serviceArea.notes,
      website,
      provider_org: existingRow?.provider_org ?? null,
      provider_software: providerSoftware,
      round_trip_booking: existingRow?.round_trip_booking ?? null,
      investigated: existingRow?.investigated ?? null,
    });

    providers.push(provider);
    mapping.push({
      csvName,
      providerName,
      providerId,
      existingName: existingRow?.provider_name ?? null,
      newRow: !existingById.has(String(providerId)),
      serviceAreaSource: provider.service_area_source,
      featureCount: Array.isArray(provider.service_zone?.features) ? provider.service_zone.features.length : 0,
      cityCount: provider.service_area_cities.length,
      unresolvedCities: serviceArea.unresolvedCities,
      notes: provider.service_area_notes ?? '',
      providerSoftware,
    });
  }

  const mappedProviderIds = new Set(mapping.map((item) => String(item.providerId)));
  const unresolved = mapping.filter((item) => item.serviceAreaSource === 'unresolved' || item.unresolvedCities.length > 0);
  const deletedProviders = existingRows.filter((row) => DELETE_PROVIDER_IDS.includes(Number(row.provider_id)));
  const deletedProviderIds = new Set(deletedProviders.map((row) => String(row.provider_id)));
  const missingFromWorkbook = existingRows.filter((row) =>
    !mappedProviderIds.has(String(row.provider_id)) && !deletedProviderIds.has(String(row.provider_id))
  );
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    generated_at: new Date().toISOString(),
    xlsxPath: XLSX_PATH,
    sheetName: SHEET_NAME,
    geojsonDir: GEOJSON_DIR,
    communityGeoJsonPath: COMMUNITY_GEOJSON_PATH,
    zipGeoJsonPath: ZIP_GEOJSON_PATH,
    providers,
    mapping,
    missingFromWorkbook,
    deletedProviders,
    unresolved,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));

  const timestampedPayloadPath = path.join(BACKUP_DIR, `provider-update-payload-${ts}.json`);
  fs.writeFileSync(timestampedPayloadPath, JSON.stringify(payload, null, 2));

  const reportPath = path.join(BACKUP_DIR, `provider-update-report-${ts}.md`);
  fs.writeFileSync(reportPath, markdownReport({
    xlsxPath: XLSX_PATH,
    sheetName: SHEET_NAME,
    geojsonDir: GEOJSON_DIR,
    communityGeoJsonPath: COMMUNITY_GEOJSON_PATH,
    zipGeoJsonPath: ZIP_GEOJSON_PATH,
    providers,
    mapping,
    missingFromWorkbook,
    deletedProviders,
    unresolved,
  }));

  const unresolvedPath = path.join(BACKUP_DIR, `provider-update-unresolved-${ts}.json`);
  fs.writeFileSync(unresolvedPath, JSON.stringify(unresolved, null, 2));

  const sqlPath = path.join(BACKUP_DIR, `provider-update-upsert-${ts}.sql`);
  fs.writeFileSync(sqlPath, `${providerUpsertSql(providers)}\n\n${providerDeleteSql(deletedProviders.map((provider) => provider.provider_id))}\n`);

  console.log(`Provider rows read: ${workbookRows.length}`);
  console.log(`Providers in payload: ${providers.length}`);
  console.log(`Providers to delete: ${deletedProviders.length}`);
  console.log(`Unresolved service areas: ${unresolved.length}`);
  console.log(`Payload: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  console.log(`Unresolved: ${path.relative(process.cwd(), unresolvedPath)}`);
  console.log(`SQL: ${path.relative(process.cwd(), sqlPath)}`);

  if (APPLY) {
    if (unresolved.length > 0 && !ALLOW_UNRESOLVED) {
      throw new Error('Refusing to apply provider update with unresolved service areas. Re-run with --allow-unresolved to override.');
    }
    throw new Error('Direct Supabase apply is not implemented in this script. Review the generated SQL and apply it through the approved Supabase migration/deployment path.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
