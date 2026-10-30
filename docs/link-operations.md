# LINK operations dashboard

The Universal Service Dashboard reads public operational records from
`GET /trip-records/operations`. It no longer generates random trips, provider
assignments, coordinates, dates, or distances. The existing Trip Upload intake
does not automatically perform this import.

## Source and interpretation

- Workbook: `LINK-070125.xlsx`, worksheet `in`.
- Provider: `2006`, `LINK Paratransit`. The import verifies both ID and name.
- Coverage: July 1–December 31, 2025; 48,832 records and 974 anonymous clients.
- Preserve raw status codes: P 47,291; CD 932; NS 556; NM 11; S 42.
  These codes are not presented as verified completion categories.
- Pickup time means PickupDepartTime; destination time means DropOffArriveTime.
  Both are local America/Los_Angeles wall times. The source cannot distinguish
  ambiguous DST wall times, so the dashboard does not fabricate UTC timestamps.
- Coordinates are Census place reference points from the supplied
  `tl_2025_06_place.dbf`. Circles represent city activity, not actual addresses,
  routes, or precise passenger locations. Numbered circles sum endpoint events
  in nearby cities. Zooming in splits groups into smaller groups and eventually
  individual city totals; zooming out merges them. Counts remain exact across
  zoom levels. Select a group to zoom into its breakdown, or an individual city
  marker to see its count and location precision. The map stops at city-level
  detail because the workbook has no street-level coordinates. Group membership
  is independent of panning; map totals describe all filtered mapped events.
- Destination cities are inferred only where the normalized destination address
  and ZIP have exactly one observed pickup city in the same workbook.
  No ZIP-only matching, fuzzy city correction, or external geocoding is performed.
- Mapped origins: 48,806; mapped destinations: 46,566. Both mode has 97,664
  endpoint records, of which 95,372 map to a city and 2,292 remain unmapped.
- Full-day views retain 1,604 endpoint records with missing event times. Narrower
  hour windows exclude unknown times. Date bounds are inclusive; hour bounds are
  start-inclusive and end-exclusive. Split overnight windows into two selections.
- Combined mode includes a trip when either endpoint falls in the selected hour
  window, but counts only matching endpoint events in the map/hour histogram.
- The source distance unit has not been verified, so no distance KPI is displayed.

## Prepare the import

Run from the repository root with Python 3 and the packages in
`scripts/operations/requirements.txt` installed:

```powershell
python scripts/operations/prepare_link.py --workbook "../Operations Data-20261023T214618Z-1-001/Operations Data/LINK-070125.xlsx" --places-dbf "../tl_2025_06_place/tl_2025_06_place.dbf"
```

Review `scripts/operations/output/quality-report.json`. The ignored output folder
also contains private `link-records.ndjson` and `import-link.sql`. Do not commit
them, place them in `static/`, or upload them to frontend hosting. A validation
failure stops preparation and writes row numbers and error categories without
copying the offending private values into the report.

Import identity depends on workbook checksum, parser version, Census reference
checksum, and provider ID. The SQL uses a transaction, an advisory lock, and
conflict-safe keys. It preserves prior batches but activates only one snapshot
per source/provider, avoiding duplicate counting across snapshots. Different
files are treated as replacement snapshots, not append-only monthly increments.
The original workbook is never modified.

## Database import options

### Existing AWS migrator

From `infra/`, build the reviewed code and data bundle:

```powershell
node scripts/build-link-operations.mjs
```

Package the contents of `.aws-sam/link-operations/migrator/` at the root of a ZIP.
It must contain `index.js`, `link-schema.sql`, `link-import.sql`, and
`link-quality-report.json`. Deploy it to the existing IAM-only migrator Lambda,
preserving its `index.handler`, VPC, environment, role, and timeout. Back up the
current deployment and use its RevisionId to avoid concurrent overwrites.

Invoke with a JSON file containing:

```json
{"action":"apply-link-operations"}
```

This action applies migration 0005, imports the bundled snapshot, and reconciles
counts, dates, statuses, mapping coverage, SQL filters, pagination, and the published provider
scope. It accepts no SQL, storage keys, or record payloads from invocation input.
Invoke `{"action":"verify-link-operations"}` for read-only reconciliation.
Keep private import bundles out of version control and public storage.

### Database client or direct connection

As the schema owner, run `infra/migrations/0005_link_operations.sql` first and
then the generated `scripts/operations/output/import-link.sql` as complete SQL
scripts. Both are safe to rerun. Do not run isolated INSERT fragments.

Alternatively, configure standard PGHOST, PGPORT, PGDATABASE, PGUSER, and
PGPASSWORD environment variables and run from `infra/`:

```powershell
node scripts/import-link.mjs --execute
```

TLS verification is enabled by default. Use PGSSLROOTCERT for the database CA.
PGSSLMODE=disable is intended only for a local database. Never put credentials
in source control or paste them into command arguments.

Migration 0005 creates `optimat.operation_imports` and
`optimat.operation_trips`. It grants the existing `optimat_app` role SELECT
access when present and grants nothing to PUBLIC. It does not modify providers,
accounts, existing trip-pair data, or account assignments.

## Deployment and access

Deploy the built trip-records bundle to the existing TripRecords Lambda; the
existing `/trip-records/{proxy+}` route already covers the new endpoint.
Deploy the frontend with VITE_API_BACKEND=aws and the existing VITE_AWS_API_URL.
The repository-connected Amplify app releases from its configured Git branch.

Open Universal Dashboard directly; no sign-in is required. The public endpoint
serves only active LINK imports for provider 2006, regardless of whether the
visitor is signed in. Publishing another provider requires an explicit code
change. Account management, uploads, and other portal endpoints retain their
existing authorization. Database roles and grants are unchanged.
Responses use Cache-Control: no-store.

The API returns aggregated points and at most 100 sanitized records per page
(50 in the UI), without client IDs, street addresses, ZIP codes, or space types. SQL parameters are
validated and bound, not interpolated. All panels derive from one SQL snapshot.
API errors produce a visible error; they never restore mock records.

## Validation and rollback

```powershell
python -m unittest discover -s scripts/operations -p "test_*.py"
npm run check
npm run build
node --test scripts/operation-clusters.test.mjs
npm --prefix infra run check
npm --prefix infra run test:operations
npm --prefix infra run test:portal
```

The migrator's real-database checks complement unit tests. Verify July and
December date boundaries, a source-status selection, distinct pickup/drop-off
hour windows, an empty period, and no overlap between consecutive pages.
Reapply the same import and confirm the row count remains 48,832.

To roll back the UI/API, restore the saved deployment versions. To hide the LINK
snapshot while retaining its records, set its `active` flag to false as the
schema owner. Do not drop source records merely to roll back a display change.
