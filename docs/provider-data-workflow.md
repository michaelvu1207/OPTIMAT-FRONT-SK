# Provider Data Workflow

This workflow keeps Supabase as the source of truth for the current service-area milestone. AWS/Aurora parity is out of scope unless provider traffic is moved back there.

## Inputs

- Provider workbook: `/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx`
- Workbook sheet: `Updated providers`
- Service-area files: `/Users/maikyon/Downloads/Geojson Files for Service Areas`
- Master city boundary file: `/Users/maikyon/Downloads/Geojson Files for Service Areas/contra_costa_cities.geojson`

## Import Steps

1. Export or snapshot the current dev provider table before applying changes.
2. Run the dry-run payload builder:

   ```bash
   cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
   node build-provider-update-payload.mjs \
     --xlsx "/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx" \
     --sheet "Updated providers" \
     --geojson-dir "/Users/maikyon/Downloads/Geojson Files for Service Areas"
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
- City-list-generated areas use `contra_costa_cities.geojson`.
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

- `scripts/backup/provider-update-report-2026-05-18T19-08-20-607Z.md`

Current source counts:

- `custom_geojson`: 9 providers
- `city_list`: 6 providers
- `existing_preserved`: 13 providers
- `unresolved`: 1 provider

## Remaining Data Issues

These rows still need Sofia/Michael review because the attached GeoJSON folder does not include enough boundaries to regenerate them confidently:

- Mobility Matters: Contra Costa County
- Pleasant Hill Van Service: Walnut Creek Service Area Depends On The Day Of The Week
- R-Transit (Richmond): North Richmond, El Sobrante, Kensington
- Richmond Moves: no service-area source available
- Rossmoor Dial-A-Bus: Rossmoor
- San Pablo Senior & Disabled Transportation: Unincorporated
- Senior Express Van (San Ramon): Dublin
- TDT ADA Paratransit: nine Bay Area counties
- TDT Senior Paratransit: Bay Point, Discovery Bay, Byron, Knightsen
- Walnut Creek Mini Bus: unincorporated areas
- WestCAT Senior Dial-A-Ride: Montalvin Manor, Tara Hills, Bayview, Rodeo, Crockett, Port Costa
- WestCAT Paratransit: Montalvin Manor, Tara Hills, Bayview, Rodeo, Crockett, Port Costa
- Wheels Dial-a-Ride: Livermore, Dublin, Pleasanton
- Wheels Go Tri-Valley: Dublin, Pleasanton, Livermore

Existing zones are preserved for all unresolved rows except Richmond Moves, which remains `service_area_source = unresolved` until a real boundary source is supplied.

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
