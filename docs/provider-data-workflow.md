# Provider Data Workflow

This workflow keeps Supabase as the source of truth for the current service-area milestone. AWS/Aurora parity is out of scope unless provider traffic is moved back there.

## Inputs

- Provider workbook: `/Users/maikyon/Downloads/OPTIMAT Provider Validation (1).xlsx`
- Workbook sheet: `Updated providers`
- Service-area files: `/Users/maikyon/Downloads/Geojson Files for Service Areas`
- Master city boundary file: `/Users/maikyon/Downloads/Geojson Files for Service Areas/contra_costa_cities.geojson`
- Supplemental community boundary file: `/Users/maikyon/Downloads/Census Place Disadvantaged Communities 2023.geojson`
- Supplemental ZIP boundary file: `/Users/maikyon/Downloads/Bay Area Zip GeoJSON.json`
- TDT ADA service-area file: `/Users/maikyon/Downloads/TDT ADA.geojson`

## Import Steps

1. Export or snapshot the current dev provider table before applying changes.
2. Run the dry-run payload builder:

   ```bash
   cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
   node build-provider-update-payload.mjs \
     --xlsx "/Users/maikyon/Downloads/OPTIMAT Provider Validation (1).xlsx" \
     --sheet "Updated providers" \
     --geojson-dir "/Users/maikyon/Downloads/Geojson Files for Service Areas" \
     --community-geojson "/Users/maikyon/Downloads/Census Place Disadvantaged Communities 2023.geojson" \
     --zip-geojson "/Users/maikyon/Downloads/Bay Area Zip GeoJSON.json"
   ```

3. Review the generated files in `scripts/backup/`:

   - `provider-update-payload-latest.json`
   - `provider-update-report-<timestamp>.md`
   - `provider-update-unresolved-<timestamp>.json`
   - `provider-update-upsert-<timestamp>.sql`

4. Confirm the report counts and unresolved service-area rows before writing to Supabase.
5. Apply to dev Supabase only.
6. Run API and frontend validation.
7. Promote later only after the dev report and smoke tests are accepted.

## Service-Area Source Rules

- Custom GeoJSON wins over city listings.
- City-list-generated areas use `contra_costa_cities.geojson`, supplemented by Census Place community boundaries for missing CDP/unincorporated community names such as `Kensington CDP`.
- ZIP-limited service areas use `Bay Area Zip GeoJSON.json` for explicit workbook entries such as `ZIP 94806`.
- The importer does not call OpenStreetMap/Nominatim.
- If a service area references a city, county, neighborhood, or vague description that is not in the provided boundary files, the importer either preserves the existing service zone or marks the provider as unresolved.

Required custom-source checks:

- AC Transit uses the 511 CCTA AC Transit GeoJSON.
- LINK Paratransit uses `Copy of link-paratransit.geojson`.
- East Bay Paratransit uses `ebp_service_area_export_wgs84.geojson`.

## Current Dev Import Status

The current dev Supabase import was applied after creating `optimat.providers_backup_service_area_20260518`.
A short-lived service-role import endpoint was used for the write and then redeployed as a disabled JWT-protected stub.

Latest dry-run review artifact:

- `scripts/backup/provider-update-report-2026-06-08T02-48-01-116Z.md`

Current source counts:

- `custom_geojson`: 11 providers
- `city_list`: 18 providers
- `existing_preserved`: 0 providers
- `unresolved`: 0 providers
- deleted providers: 1 (`Richmond Moves`, provider `5029`)

## Remaining Data Issues

The current workbook dry run has no unresolved service areas. `Richmond Moves` is intentionally removed from the generated SQL.

## Validation Commands

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
node provider-cleaning.test.mjs
node provider-workbook.test.mjs
node service-area-resolver.test.mjs
node heatmap.test.mjs
```

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK
node tests/api-harness.mjs --only providers,data-integrity --verbose
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/svelte-kit sync
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/vite build
```
