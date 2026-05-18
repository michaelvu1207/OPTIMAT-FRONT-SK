# Service Area Management Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` before implementing this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OSM/Nominatim-derived provider service areas with curated GeoJSON/city-boundary inputs, lock down public provider editing, improve public provider detail display, add provider software metadata, and define the dashboard heat-map implementation.

**Architecture:** Treat the workbook's `Updated providers` sheet plus `/Users/maikyon/Downloads/Geojson Files for Service Areas` as the new provider-data import inputs. Preserve `optimat.providers.service_zone` as the compatibility field used by the chat, filter, and map code, but add explicit source columns so the database can distinguish custom GeoJSON from city-list-generated service areas. Make public APIs read-only and contact-free, then move all provider modifications into scripts or a future authenticated admin/provider workflow.

**Tech Stack:** Svelte/SvelteKit frontend, Supabase Edge Functions, optional AWS Lambda/Aurora dev deployment parity where the repo already has matching code, PostgreSQL JSONB/TEXT[] columns, Node.js import/validation scripts, GeoJSON FeatureCollections, Leaflet/Sveaflet map rendering.

---

## Current Findings

- The repo's mainline branch is `master`, not `main`.
- The current frontend provider API client uses Supabase Edge Functions in `src/lib/api.ts`.
- Public provider reads and writes are currently exposed through `supabase/functions/providers/index.ts`.
- `PUT /providers/:id` accepts unauthenticated updates because the Edge Function uses a service-role database client internally.
- `src/routes/ProvidersInfo.svelte` still has public edit controls and a `Show JSON` toggle. It also imports editor components for schedule, eligibility, booking, fare, contacts, and service zones.
- `src/routes/ProviderPortalInfo.svelte` has similar edit and JSON display controls behind an app-level provider session, but this appears to be app state rather than a hard backend authorization boundary.
- `src/lib/providers/providerFields.ts` already has display formatters for schedule, booking, fare, eligibility, contacts, and service zone summaries. These should become the only public display path.
- `scripts/apply-supabase-provider-updates.mjs`, `scripts/provider-cleaning.mjs`, and `scripts/fetch-city-boundaries.mjs` are the current provider data scripts.
- `scripts/fetch-city-boundaries.mjs` currently uses Nominatim/OSM and a cache directory. This is the path to replace.
- The attached workbook `/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx` has an `Updated providers` sheet with 29 provider rows and these important columns:
  - `Provider Name`
  - `Eligibility (provider website)`
  - `Eligibility (optimat)`
  - `Service Area GeoJSON`
  - `Service Area Cities (provider website)`
  - `Cost (provider website)`
  - `Cost (optimat)`
  - `Service Area Website`
  - `Provider Software `
- The attached GeoJSON folder contains:
  - `contra_costa_cities.geojson`: master city boundary file with 19 Contra Costa city features.
  - `contra_costa_county_boundary.geojson`: one county boundary feature.
  - `ebp_service_area_export_wgs84.geojson`: East Bay Paratransit custom service-area polygon.
  - `Copy of link-paratransit.geojson`: County Connection LINK weekday/weekend custom service-area polygons.
  - `Copy of one-seat-regional-ride.geojson`: One-Seat Regional Ride custom service area.
  - `Copy of go-san-ramon.geojson`: Go San Ramon custom zones.
  - `transit_bus_geojson_511.ccta.ca.gov.xlsx`: 511 GeoJSON URL index for fixed-route agencies.

## Assumptions

- `service_zone` remains the effective service-area GeoJSON for existing code paths until all consumers are migrated.
- New columns should record source data and import provenance without breaking existing frontend/chat/filter code.
- If both custom GeoJSON and city listings exist, custom GeoJSON wins for the effective service area.
- City-list-generated service areas should use `contra_costa_cities.geojson` only for cities present in that master file.
- For non-Contra Costa cities or vague labels not represented in `contra_costa_cities.geojson`, the importer should preserve an existing verified `service_zone` or fail validation with an explicit unresolved-boundary report. It should not silently fall back to OSM.
- The `Provider Software ` workbook column is currently blank in the inspected workbook. The schema and UI should support it, but data import will load blank/null values until that column is populated.
- Public contacts should be hidden from public API responses. Keeping them in the database is acceptable if they are needed internally later.

## Data Model Plan

### Provider Table Additions

Add a new idempotent migration under `supabase/migrations/` and mirror it in `scripts/ddl/tables.sql`.

Recommended columns:

```sql
alter table optimat.providers
  add column if not exists service_area_geojson jsonb,
  add column if not exists service_area_cities text[],
  add column if not exists service_area_source text,
  add column if not exists service_area_notes text,
  add column if not exists provider_software text,
  add column if not exists updated_at timestamptz default now();
```

Recommended comments:

```sql
comment on column optimat.providers.service_area_geojson is
  'Custom provider service-area GeoJSON imported from curated provider files or authoritative provider feeds.';
comment on column optimat.providers.service_area_cities is
  'Normalized city names used to generate a provider service area when no custom GeoJSON is available.';
comment on column optimat.providers.service_area_source is
  'How service_zone was derived: custom_geojson, city_list, existing_preserved, unresolved, or manual.';
comment on column optimat.providers.provider_software is
  'Provider scheduling/dispatch software noted in the provider validation workbook.';
```

Recommended indexes:

```sql
create index if not exists idx_providers_service_area_cities
  on optimat.providers using gin (service_area_cities);

create index if not exists idx_providers_provider_software
  on optimat.providers (provider_software)
  where provider_software is not null;
```

Keep `service_zone` as the effective GeoJSON used by:

- `supabase/functions/chat/tools.ts`
- `supabase/functions/providers/index.ts`
- `src/routes/ProvidersInfo.svelte`
- `src/components/TripRouteMap.svelte`

### Effective Service Area Rule

During import, set:

```text
service_zone = service_area_geojson if present
service_zone = generated FeatureCollection from service_area_cities if no custom GeoJSON exists
service_zone = previous verified service_zone only when city generation is unresolved and a previous zone exists
service_zone = null only when the provider truly has no service area or validation explicitly allows unresolved zones
```

Store source metadata:

```text
custom GeoJSON used       -> service_area_source = custom_geojson
city boundary generated   -> service_area_source = city_list
existing zone preserved   -> service_area_source = existing_preserved
missing/unresolved        -> service_area_source = unresolved
manual special case       -> service_area_source = manual
```

## Service Area Import Plan

### Source Manifest

Create `scripts/service-area-sources.mjs` with provider-specific source mappings. This keeps file/URL decisions out of the general importer.

Initial mappings:

```js
export const SERVICE_AREA_SOURCES = {
  'AC Transit': {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/ac.geojson',
  },
  BART: {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/bart.geojson',
  },
  'County Connection': {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/countyconnection.geojson',
  },
  'East Bay Paratransit': {
    type: 'local_geojson',
    path: '/Users/maikyon/Downloads/Geojson Files for Service Areas/ebp_service_area_export_wgs84.geojson',
  },
  'County Connection LINK': {
    type: 'local_geojson',
    path: '/Users/maikyon/Downloads/Geojson Files for Service Areas/Copy of link-paratransit.geojson',
  },
  'LINK Paratransit': {
    type: 'local_geojson',
    path: '/Users/maikyon/Downloads/Geojson Files for Service Areas/Copy of link-paratransit.geojson',
  },
  'One-Seat Regional Ride': {
    type: 'local_geojson',
    path: '/Users/maikyon/Downloads/Geojson Files for Service Areas/Copy of one-seat-regional-ride.geojson',
  },
  'San Ramon Go San Ramon': {
    type: 'local_geojson',
    path: '/Users/maikyon/Downloads/Geojson Files for Service Areas/Copy of go-san-ramon.geojson',
  },
  'Tri Delta Transit': {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/tdt.geojson',
  },
  WestCAT: {
    type: 'remote_geojson',
    url: 'https://511.ccta.ca.gov/wp-content/themes/five11/js/data/westcat.geojson',
  },
};
```

The workbook's `Service Area GeoJSON` column should also be read. Manifest entries override ambiguous workbook values such as `Geojson` for County Connection LINK.

### Boundary Resolver

Replace `scripts/fetch-city-boundaries.mjs` with a local resolver, or create `scripts/resolve-service-areas.mjs` and retire the Nominatim path.

Resolver responsibilities:

- Load `/Users/maikyon/Downloads/Geojson Files for Service Areas/contra_costa_cities.geojson`.
- Normalize city names from workbook text:
  - remove `fixed route`, `fixed`, parentheses, trailing periods, and line breaks.
  - split on commas and `and`.
  - map aliases like `Walnut Creek.` -> `Walnut Creek`.
  - map `Eastern Contra Costa County` to `Antioch`, `Brentwood`, `Oakley`, `Pittsburg`, `Bay Point`, `Discovery Bay`, `Byron`, and `Knightsen` only if those boundaries are available or manually provided.
  - map `All nine Bay Area Counties` to a non-city unresolved group unless a verified Bay Area counties file is supplied.
- For each normalized city:
  - if present in `contra_costa_cities.geojson`, copy that feature into the output FeatureCollection.
  - if absent, record it in `unresolvedCities`.
- Normalize all local/remote GeoJSON inputs to `FeatureCollection`.
- Validate every output:
  - type is `FeatureCollection`.
  - features array is non-empty when source is custom or city-list.
  - every geometry is `Polygon`, `MultiPolygon`, `LineString`, `MultiLineString`, or another expected GeoJSON geometry.
  - coordinates are likely WGS84 lon/lat.
- Emit a dry-run report before writes:
  - provider name.
  - source selected.
  - feature count.
  - city count.
  - unresolved cities.

### Provider-Specific Rules

1. East Bay Paratransit
   - Use `/Users/maikyon/Downloads/Geojson Files for Service Areas/ebp_service_area_export_wgs84.geojson`.
   - Set `service_area_source = custom_geojson`.
   - Keep workbook city list in `service_area_cities` for search/display metadata, but do not use it to generate `service_zone`.

2. County Connection LINK / LINK Paratransit
   - Use `/Users/maikyon/Downloads/Geojson Files for Service Areas/Copy of link-paratransit.geojson`.
   - Set `service_area_source = custom_geojson`.
   - This restores the original GeoJSON and prevents the importer from replacing it with a city-generated polygon.

3. AC Transit
   - Fetch/cache `https://511.ccta.ca.gov/wp-content/themes/five11/js/data/ac.geojson`.
   - Normalize its single `Feature` response to a one-feature `FeatureCollection`.
   - Set `service_area_source = custom_geojson`.

4. Fixed-route agencies with 511 GeoJSON
   - Apply the same remote GeoJSON normalization for BART, County Connection, Tri Delta Transit, and WestCAT.
   - Cache fetched files under `scripts/cache/provider-geojson/` or a new untracked `exports/service-areas/` path.

5. City-list providers
   - Generate FeatureCollections from `contra_costa_cities.geojson` only where all listed cities are in the master file.
   - Preserve prior `service_zone` when the workbook city text references non-master places and no custom file exists.
   - Mark unresolved values in `service_area_notes`.

## Workbook Import Plan

### Use XLSX as the New Input

Update `scripts/provider-cleaning.mjs` and `scripts/apply-supabase-provider-updates.mjs` so they can read either:

- `/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx`, sheet `Updated providers`, or
- an exported CSV for backwards compatibility.

Recommended new script:

```text
scripts/build-provider-update-payload.mjs
```

Inputs:

```text
--xlsx "/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx"
--sheet "Updated providers"
--geojson-dir "/Users/maikyon/Downloads/Geojson Files for Service Areas"
--output scripts/backup/provider-update-payload-latest.json
--apply false by default
```

Outputs:

```text
scripts/backup/provider-update-payload-<timestamp>.json
scripts/backup/provider-update-report-<timestamp>.md
scripts/backup/provider-update-unresolved-<timestamp>.json
```

The report should become the review artifact before database writes.

### Field Mapping

Map workbook fields to database fields:

```text
Provider Name                         -> provider_name after canonical name mapping
Eligibility (provider website)         -> eligibility_reqs preferred
Eligibility (optimat)                  -> eligibility_reqs fallback
Service Area GeoJSON                   -> service_area_geojson source hint
Service Area Cities (provider website) -> service_area_cities and city-generated service_zone fallback
Cost (provider website)                -> fare preferred
Cost (optimat)                         -> fare fallback
Service Area Website                   -> website
Provider Software                      -> provider_software
```

Continue to preserve current stable provider IDs through `PROVIDER_ID_NAME_ALIASES` and manual mappings.

## API And Security Plan

### Public Provider API

Modify `supabase/functions/providers/index.ts`:

- Remove `contacts` from `PROVIDER_SELECT_FIELDS` for public list/search/get/filter/map responses.
- Add `service_area_geojson`, `service_area_cities`, `service_area_source`, `service_area_notes`, and `provider_software` to read responses only if public display needs them.
- Keep `service_zone` in service-zone/map responses because the map still needs effective polygons.
- Return `405 Method Not Allowed` or `401 Unauthorized` for `PUT /providers/:id` unless an explicit admin/provider auth gate is introduced.

Recommended first version:

```text
PUT /providers/:id -> 405 for public Edge Function
```

This is simpler and directly satisfies "disable JSON editing capabilities on front end" and "remove edit functionality from service map providers in general".

If provider/admin editing is needed later, add a separate endpoint:

```text
PUT /admin/providers/:id
```

or require a verified JWT role before allowing updates.

### AWS Lambda Parity

Supabase is the implementation target for this first pass. Do not block Supabase delivery on AWS/Aurora parity.

If dev deployment still routes provider traffic through AWS/Aurora, mirror the same changes in:

- `infra/lambda/providers/index.ts`
- `infra/lambda/_shared/db.ts`
- `infra/lambda/db-setup/index.ts`
- `scripts/ddl/tables.sql`

Because `infra/` is currently untracked in this worktree, first decide whether it should be committed as part of this repo. If it is part of the active dev deployment, promote it into the tracked source tree before depending on it for release.

For this Supabase-first milestone, AWS parity is explicitly out of scope unless a Supabase endpoint cannot satisfy a required feature.

## Frontend Plan

### Providers Info / Service Map

Modify `src/routes/ProvidersInfo.svelte`:

- Remove edit mode state and save/update functions.
- Remove `Edit` button.
- Remove `Show JSON` toggle.
- Remove imports for provider editor components.
- Remove contact display from public details.
- Display only friendly text using `src/lib/providers/providerFields.ts`:
  - `formatScheduleType`
  - `formatBooking`
  - `formatEligibilityReqs`
  - `formatFare`
  - `formatServiceZone`
- Add `Provider Software` display if the field is non-empty.
- Rename technical labels:
  - `Schedule Type` -> `Schedule`
  - `Routing Type` -> `Service style`
  - `Service Zone (GeoJSON)` -> `Service area`
  - `Eligibility Requirements` -> `Eligibility`
- Keep map service-zone visualization.

### Provider Portal

Modify `src/routes/ProviderPortalInfo.svelte`:

- Remove JSON toggle.
- Remove raw JSON display.
- Disable or hide edit controls until backend authorization is defined.
- If provider self-service editing remains a product goal, plan a second phase with real auth, provider ownership, and per-field validation.

### API Types And Formatters

Modify `src/lib/api.ts`:

- Add provider fields:
  - `service_area_geojson?: object | string`
  - `service_area_cities?: string[]`
  - `service_area_source?: string`
  - `service_area_notes?: string`
  - `provider_software?: string`
- Stop assuming `contacts` is returned publicly.

Modify `src/lib/providers/providerFields.ts`:

- Change `formatScheduleType` labels:
  - `fixed-schedules` -> `Fixed schedule`
  - `in-advance-book` -> `Book in advance`
  - `real-time-book` -> `Book on demand`
- Change proof labels:
  - `ada-approved` -> `ADA eligibility required`
  - `id-certified` -> `ID or residency proof required`
- Add `formatServiceAreaSummary(provider)`:
  - custom GeoJSON -> `Mapped service area`
  - city list -> `Serves: Concord, Walnut Creek, ...`
  - unresolved -> `Service area pending review`

## Heat Map Plan

### Product Intent

Replace visually noisy route-line overlays with demand visualization focused on where trips start and end, not which route line is most common.

### First Implementation

Use the current dashboard data shape first. `src/routes/UniversalServiceDashboard.svelte` already generates mock trips with:

```text
origin: [lat, lng]
destination: [lat, lng]
providerId
date
```

Implement heat rendering over that data without waiting for real trip-record ingestion.

### Visualization Approach

Use binned weighted points rather than drawing every route:

- Create `src/lib/utils/heatmap.ts`.
- Inputs: trips, mode, bin size.
- Modes:
  - `origins`
  - `destinations`
  - `combined`
- Bin coordinates to about 0.01 degrees by default.
- Aggregate:
  - origin count
  - destination count
  - combined count
- Output:
  - center coordinate
  - count
  - radius
  - fill opacity
  - color

Render in `src/components/TripRouteMap.svelte` using `CircleMarker` initially. This avoids adding a new mapping dependency. If later we want smoother heat rendering, evaluate `leaflet.heat` after the binned marker version is verified.

Recommended controls in `src/routes/UniversalServiceDashboard.svelte`:

```text
Map mode: Origins | Destinations | Combined | Selected route
Bin size: Neighborhood | City-ish
```

Default to `Combined`.

### Real Data Follow-Up

After the mock heat map works, add an API endpoint for real trip-record heat data:

```text
GET /trip-records/heatmap?provider_id=&date_from=&date_to=&mode=
```

Back it with `optimat.trip_record_pairs_raw` or the cleaned trip-record tables once pickup/drop coordinates are available. If only addresses exist, add a batch geocode/cache process before rendering heat maps.

## Data Synchronization Plan

### Single Source Of Truth

Use this workflow going forward:

1. Michael exports the current provider DB as a CSV/JSON snapshot:
   - `exports/providers-current-<date>.csv`
   - `exports/providers-current-<date>.json`
2. Sofia edits one workbook sheet:
   - `OPTIMAT Provider Validation.xlsx`
   - sheet: `Updated providers`
3. The importer builds a normalized payload and review report.
4. The team reviews unresolved cities, changed GeoJSON source, changed provider IDs, and deleted providers.
5. Apply to dev database only.
6. Smoke test dev.
7. Promote to production only after review.

### Provider Update Report

Every dry run should show:

- providers to update.
- providers to insert.
- providers missing from workbook.
- providers that would be deleted or retired.
- custom GeoJSON providers.
- city-list-generated providers.
- unresolved city/provider rows.
- providers whose contacts exist in DB but are hidden from public API.
- provider software values imported.

No database write should happen if unresolved service-area rows exist unless `--allow-unresolved` is passed.

## Test Plan

### Supabase-First Completion Criteria

The plan is considered implemented for the Supabase-first milestone only when every criterion below is true.

#### Data Model

- [ ] A Supabase migration exists for provider service-area metadata:
  - `service_area_geojson jsonb`
  - `service_area_cities text[]`
  - `service_area_source text`
  - `service_area_notes text`
  - `provider_software text`
  - `updated_at timestamptz`
- [ ] The migration is idempotent and can run twice without error.
- [ ] `optimat.providers.service_zone` remains present and continues to hold the effective GeoJSON used by existing map/chat/filter paths.
- [ ] `scripts/ddl/tables.sql` mirrors the Supabase provider schema for local/dev rebuilds.
- [ ] Indexes exist for provider lookup/search fields that the new code filters on, including `service_area_cities` and non-null `provider_software`.

Validation commands/evidence:

```sql
select column_name, data_type, udt_name
from information_schema.columns
where table_schema = 'optimat'
  and table_name = 'providers'
  and column_name in (
    'service_zone',
    'service_area_geojson',
    'service_area_cities',
    'service_area_source',
    'service_area_notes',
    'provider_software',
    'updated_at'
  )
order by column_name;
```

#### Provider Data Import

- [ ] The importer reads `/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx`, sheet `Updated providers`.
- [ ] The importer validates that the workbook has 29 provider rows and the expected columns.
- [ ] The importer uses `/Users/maikyon/Downloads/Geojson Files for Service Areas/contra_costa_cities.geojson` for city-list-generated Contra Costa service areas.
- [ ] The importer no longer calls Nominatim/OpenStreetMap for city boundaries.
- [ ] The importer produces a dry-run report before writing to Supabase.
- [ ] The dry-run report lists:
  - providers updated.
  - providers inserted.
  - providers missing from the workbook.
  - providers that would be retired or deleted.
  - providers using custom GeoJSON.
  - providers using generated city-list GeoJSON.
  - providers with unresolved cities/service areas.
  - provider software values.
- [ ] A database write is blocked when unresolved service-area rows exist unless an explicit override flag is passed.
- [ ] After import, provider count and provider IDs match the reviewed report.

Validation commands/evidence:

```bash
cd /Users/maikyon/Documents/Programming/OPTIMAT-FRONT-SK/scripts
node provider-cleaning.test.mjs
node service-area-resolver.test.mjs
node build-provider-update-payload.mjs \
  --xlsx "/Users/maikyon/Downloads/OPTIMAT Provider Validation.xlsx" \
  --sheet "Updated providers" \
  --geojson-dir "/Users/maikyon/Downloads/Geojson Files for Service Areas"
```

#### Required Provider Service Areas

- [ ] East Bay Paratransit uses `/Users/maikyon/Downloads/Geojson Files for Service Areas/ebp_service_area_export_wgs84.geojson`.
- [ ] County Connection LINK / LINK Paratransit uses `/Users/maikyon/Downloads/Geojson Files for Service Areas/Copy of link-paratransit.geojson`.
- [ ] AC Transit uses the 511 CCTA AC Transit GeoJSON and stores it as an effective FeatureCollection.
- [ ] Custom GeoJSON takes priority over city listings for every provider with both.
- [ ] City-list-generated providers have `service_area_cities` populated with normalized city names.
- [ ] `service_area_source` accurately reflects `custom_geojson`, `city_list`, `existing_preserved`, `manual`, or `unresolved`.

Validation SQL/evidence:

```sql
select provider_name,
       service_area_source,
       cardinality(service_area_cities) as city_count,
       service_zone->>'type' as zone_type,
       jsonb_array_length(coalesce(service_zone->'features', '[]'::jsonb)) as feature_count
from optimat.providers
where provider_name in (
  'East Bay Paratransit',
  'County Connection LINK',
  'LINK Paratransit',
  'AC Transit'
)
order by provider_name;
```

Pass condition:

- East Bay Paratransit: `service_area_source = custom_geojson`, `feature_count >= 1`.
- County Connection LINK / LINK Paratransit: `service_area_source = custom_geojson`, `feature_count >= 1`.
- AC Transit: `service_area_source = custom_geojson`, `feature_count >= 1`.

#### Public API Security

- [ ] Public `GET /providers` responses do not include `contacts`.
- [ ] Public `GET /providers/:id` responses do not include `contacts`.
- [ ] Public `POST /providers/filter` provider objects do not include `contacts`.
- [ ] Public `PUT /providers/:id` returns `405 Method Not Allowed` or `401 Unauthorized`.
- [ ] No public endpoint accepts raw JSON provider edits.
- [ ] Service-zone read endpoints still return effective `service_zone` data.

Validation commands/evidence:

```bash
node tests/api-harness.mjs --only providers,data-integrity
```

Manual API checks:

```bash
curl -i "$SUPABASE_FUNCTIONS_URL/providers"
curl -i "$SUPABASE_FUNCTIONS_URL/providers/1"
curl -i -X PUT "$SUPABASE_FUNCTIONS_URL/providers/1" \
  -H "content-type: application/json" \
  --data '{"provider_name":"Should Not Save"}'
```

Pass condition:

- `contacts` is absent from public JSON.
- `PUT` is rejected.
- Provider records remain unchanged after rejected `PUT`.

#### Public Provider UI

- [ ] `src/routes/ProvidersInfo.svelte` has no Edit button.
- [ ] `src/routes/ProvidersInfo.svelte` has no `Show JSON` / `Hide JSON` toggle.
- [ ] Public provider details never render raw JSON blocks.
- [ ] Public provider details never show contacts.
- [ ] Provider details use friendly labels:
  - `Schedule`
  - `Eligibility`
  - `Booking`
  - `Fare`
  - `Service area`
  - `Provider software`
- [ ] Eligibility proof labels are user-friendly, for example `ADA eligibility required` instead of `proof: ada-approved`.
- [ ] Schedule labels are user-friendly, for example `Fixed schedule` instead of `type: fixed-schedules`.
- [ ] Selecting providers still updates the map service area overlay.

Validation evidence:

```bash
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
```

Manual UI checks:

- Load the Providers Info page.
- Select East Bay Paratransit.
- Select County Connection LINK / LINK Paratransit.
- Select AC Transit.
- Confirm no edit/json/contact UI appears.
- Confirm all service-area polygons render or a clear non-technical fallback is shown.

#### Provider Portal UI

- [ ] Provider Portal no longer exposes raw JSON editing.
- [ ] Provider Portal either:
  - has editing disabled until real auth/ownership is implemented, or
  - uses a Supabase-authenticated endpoint with role/ownership validation.
- [ ] Provider Portal does not use local app state alone as the authorization boundary.

Pass condition:

- A non-authenticated user cannot edit provider details through the UI or API.
- A provider/admin edit path, if kept, requires verified backend authorization.

#### Heat Map Dashboard

- [ ] `src/lib/utils/heatmap.ts` or equivalent exists and has tests.
- [ ] Heat map supports `origins`, `destinations`, and `combined` modes.
- [ ] Heat aggregation bins nearby points and weights markers by frequency.
- [ ] `UniversalServiceDashboard.svelte` defaults to heat-map visualization instead of drawing all route lines.
- [ ] A selected trip can still show a route line as drill-down.
- [ ] The dashboard focuses on origin/destination demand rather than route popularity.

Validation commands/evidence:

```bash
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" npm test -- --run heatmap
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
```

If the repo does not yet have a JS/TS test runner configured, pass condition is:

- heat-map utility has a runnable Node test script under `scripts/` or `tests/`.
- the test script exits `0`.
- `svelte-check` exits `0` errors.

#### Supabase Deployment

- [ ] Supabase migration has been applied to the dev Supabase database.
- [ ] Updated Supabase Edge Functions have been deployed to dev.
- [ ] Provider import has been applied to dev Supabase only after dry-run review.
- [ ] Dev API smoke tests pass.
- [ ] Dev frontend points at Supabase and exercises the deployed functions.
- [ ] AWS/Aurora deployment is not required for this milestone unless explicitly reintroduced.

Pass condition:

- Dev Supabase is the working backend for provider data, service areas, security changes, and frontend display.
- There is no required AWS/Aurora-only functionality for the completed milestone.

#### Documentation And Handoff

- [ ] Provider data workflow is documented in `scripts/README.md` or `docs/provider-data-workflow.md`.
- [ ] The dry-run review report is saved with the import backup artifacts.
- [ ] Remaining unresolved city/provider service areas are listed for Sofia/Michael.
- [ ] Known out-of-scope AWS parity work is documented separately.

### Overall Done Definition

This plan is complete when:

- Supabase schema, import, APIs, and frontend support the new provider service-area model.
- Public users cannot view contacts or edit provider details.
- Public users cannot access raw JSON editing/display flows.
- Required provider service areas render from the right sources.
- Heat-map dashboard behavior is implemented and verified.
- Automated checks pass with `0` errors.
- Manual UI/API checks confirm the release behavior on the dev Supabase deployment.

### Unit Tests

Add/extend Node tests:

- `scripts/provider-cleaning.test.mjs`
  - reads `Updated providers` sheet.
  - validates 29 rows.
  - validates new column names.
  - validates provider software column exists.
  - validates canonical name mapping.

- `scripts/service-area-resolver.test.mjs`
  - East Bay Paratransit uses local custom GeoJSON.
  - County Connection LINK uses `Copy of link-paratransit.geojson`.
  - AC Transit remote Feature normalizes to FeatureCollection.
  - Walnut Creek/Concord/Clayton/Pleasant Hill/Martinez city list generates 5 city features.
  - custom GeoJSON wins over city list.
  - unresolved non-master city names are reported, not fetched from OSM.

- `src/lib/utils/heatmap.test.ts`
  - bins origins separately from destinations.
  - combined mode adds both ends.
  - marker radius grows with count.

### API Tests

Add or update API harness tests:

- `GET /providers` does not include `contacts`.
- `GET /providers/:id` does not include `contacts`.
- `PUT /providers/:id` returns `405` or `401` publicly.
- providers include `provider_software` and service-area metadata fields.
- service-zone endpoint still returns effective `service_zone`.

### Frontend Verification

Run:

```bash
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/svelte-kit sync
PATH="/Users/maikyon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Applications/Codex.app/Contents/Resources:$PATH" ./node_modules/.bin/svelte-check --tsconfig ./tsconfig.json
```

Use browser/UI verification after implementation:

- Providers Info shows no Edit button.
- Providers Info shows no JSON toggle.
- Contacts are absent.
- Friendly labels render for schedule, eligibility, fare, booking, and service area.
- Selecting East Bay Paratransit, County Connection LINK, and AC Transit shows service-zone polygons.
- Universal Service Dashboard defaults to heat-map mode and no longer draws all route lines by default.

## Implementation Phases

### Phase 1: Schema And Import Foundations

- [ ] Add provider schema migration for new metadata columns.
- [ ] Mirror schema in `scripts/ddl/tables.sql`.
- [ ] Add source manifest for provider GeoJSON files/URLs.
- [ ] Build local service-area resolver that uses `contra_costa_cities.geojson`.
- [ ] Add service-area resolver unit tests.
- [ ] Update provider importer to read XLSX `Updated providers`.
- [ ] Generate dry-run payload/report from workbook and GeoJSON folder.
- [ ] Validate unresolved service-area report with the team.

### Phase 2: Provider Data Update

- [ ] Back up dev provider table.
- [ ] Apply schema migration to dev.
- [ ] Dry-run import against dev data.
- [ ] Confirm provider insert/delete policy.
- [ ] Apply provider updates to dev.
- [ ] Verify East Bay Paratransit, County Connection LINK, and AC Transit service areas.
- [ ] Export updated provider DB as the new single source snapshot.

### Phase 3: Public Access Lockdown

- [ ] Remove public `contacts` from provider API selects.
- [ ] Disable public provider `PUT`.
- [ ] Keep AWS Lambda parity out of scope for the Supabase-first milestone unless Supabase cannot satisfy a required feature.
- [ ] Update API tests.
- [ ] Confirm public frontend cannot modify provider details.

### Phase 4: Friendly Provider UI

- [ ] Remove edit controls from `ProvidersInfo.svelte`.
- [ ] Remove JSON toggle and raw JSON display from public provider views.
- [ ] Remove public contacts display.
- [ ] Add provider software display.
- [ ] Improve schedule/eligibility/fare/booking/service-area formatters.
- [ ] Decide whether Provider Portal editing is disabled or moved behind real auth.

### Phase 5: Heat Map Dashboard

- [ ] Add heat-map aggregation utility.
- [ ] Add heat-map tests.
- [ ] Update `TripRouteMap.svelte` to render weighted heat markers.
- [ ] Update `UniversalServiceDashboard.svelte` controls and default map mode.
- [ ] Keep selected route display as an optional drill-down, not the default.
- [ ] Later: connect to real trip-record data endpoint.

### Phase 6: Deployment And Documentation

- [ ] Update deployment scripts if dev deployment requires new migrations or Lambda rebuilds.
- [ ] Deploy to dev.
- [ ] Run API smoke tests.
- [ ] Run frontend checks.
- [ ] Document provider update workflow in `scripts/README.md` or `docs/provider-data-workflow.md`.
- [ ] Record unresolved data issues for Sofia/Michael.

## Open Decisions Before Implementation

1. Should `PUT /providers/:id` be fully removed for now, or kept only for authenticated admin/provider users?
2. Should provider contacts remain in the database but hidden publicly, or be moved into a separate private table?
3. What source should be used for city/county areas outside `contra_costa_cities.geojson`?
4. Should fixed-route agency GeoJSON from 511 represent route lines as service areas, or should fixed-route providers use a separate polygon/city coverage model?
5. Should blank `Provider Software ` values be imported as null for now, or should the release wait for Sofia/Michael to fill that column?
6. Should providers missing from the updated workbook be retired, preserved, or marked inactive?

## Main Risks

- The master city file only covers 19 Contra Costa cities. Several providers reference non-Contra Costa cities/counties.
- 511 fixed-route GeoJSON URLs return line geometry, not city polygons. That may be correct for route display but may not be correct for point-in-polygon eligibility filtering.
- Current chat provider filtering uses point-in-polygon logic against `service_zone`; fixed-route line GeoJSON will not work with that logic unless fixed-route agencies are excluded from point-in-polygon filtering or converted to buffered/polygon coverage.
- Public provider update security must be fixed before any new metadata is trusted.
- The workbook currently has blank provider software values, so the database column can be added now but may not show useful UI data yet.

## Recommended First Cut

Implement Phases 1 through 4 through Supabase first. That delivers the service-area data model, accurate provider-specific GeoJSON handling, no OSM dependency, public security lockdown, and friendly provider display without waiting on AWS/Aurora parity. Then implement Phase 5 heat maps as a separate, testable UI feature so map/dashboard changes do not block the provider data/security release.
