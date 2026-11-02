# Agency operational imports

The Universal Service Dashboard supports the three supplied July–December 2025
CSV exports alongside the existing LINK snapshot. Each agency has the same date,
hour, status, endpoint layer, numbered city cluster and record pagination controls.
The source/provider allowlist is explicit; publishing these snapshots does not
publish other provider data or expose addresses, ZIPs or client identifiers.

| Export | Source / provider | Input rows | Dashboard records | Unit |
| --- | --- | ---: | ---: | --- |
| `[New]_WestCat_Trip Dump 2025_v1.csv` | WESTCAT / 1003 WestCAT | 23,079 | 9,906 | booking |
| `[New]_TDT-Trip Repot.xlsx - Trapeze.csv` | TDT / 1002 Tri Delta Transit | 71,870 | 71,870 | booking |
| `[New]_MM_7.1.25-12.31.25 Rides.xlsx - Page1.csv` | MM / 4021 Mobility Matters | 1,673 | 1,673 | ride |

Agency-wide files are assigned to agency records, not guessed paratransit
products. Import SQL verifies both provider ID and name before writing.

## Source meanings and limitations

- **WestCAT:** Join Pick and Drop rows by service date and booking ID, checking
  client identity. Do not assume file adjacency. Garage, break, lunch and blank
  activities are excluded and counted in the quality report. All 502 pickup-only
  bookings remain, with an unknown destination. Four bookings have differing
  endpoint statuses; both statuses are retained as `pickup / dropoff`. Actual
  arrival/departure times are used. Raw status labels are preserved.
- **Tri Delta:** Each date/BookingId is unique in this export. Preserve all
  71,870 records, including cancellations and no-shows. Actual origin/destination
  arrival/departure columns are used; scheduled and estimated times never stand
  in for missing actual times. The repeated `Est` column is unused. Six actual
  or scheduled fields contain service-day hours beyond 23 (including 29:00);
  they become missing clock times without guessing date rollover. Disposition
  strings such as `CA,UG` remain filterable. Booking IDs are not client IDs.
- **Mobility Matters:** One record per Ride ID, without expanding `# of Trips`
  into fabricated legs. The source reports 3,478 trip legs, with one missing trip
  count; these are not the displayed record total. Cancelled/Confirmed flags
  determine the displayed status. There are no client IDs, street addresses or
  actual per-leg times. Pickup and appointment times lack AM/PM; neither is used
  as an actual departure/arrival time. These records appear in full-day views
  but not narrower actual-time windows. Actual Hrs is not treated as activity
  duration or per-leg travel time.
- **Map:** Use supplied cities with the same Census 2025 California place
  reference as LINK. Normalize case and whitespace only. Misspellings and
  ambiguous Census place names remain unmapped; no fuzzy matching or invented
  coordinates. Full-day both mode includes two endpoint slots per service
  record, with missing endpoints counted as unmapped.
- **Home/activity:** WestCAT uses LINK's conservative pairing rules: exactly
  two bookings for the same client/import/date, complete ordered actual times,
  and matching outbound origin/return destination address plus ZIP. Home is
  inferred, not verified residence. Blue means home; orange means activity.
  Tri Delta and Mobility Matters lack required fields and contribute no inferred
  pairs. Their endpoints remain available in the ordinary map. The dashboard
  explains these exclusions instead of guessing home from morning trips.
- **Riders:** Only sources with client IDs contribute to the rider count; the UI
  displays how many selected records have an identifier. No IDs are synthesized
  from addresses, booking IDs or ride IDs.

## Prepare and deploy

Use Python 3. The CSV parser uses the standard library; `openpyxl` is only
needed for the separate LINK workbook parser. Obtain `tl_2025_06_place.dbf` from
the official [Census TIGER 2025 California places archive](https://www2.census.gov/geo/tiger/TIGER2025/PLACE/tl_2025_06_place.zip).
The parser includes its SHA-256 in import identity, along with the source file,
parser version and provider ID.

```sh
python3 scripts/operations/prepare_agencies.py \
  --westcat '/path/[New]_WestCat_Trip Dump 2025_v1.csv' \
  --tdt '/path/[New]_TDT-Trip Repot.xlsx - Trapeze.csv' \
  --mm '/path/[New]_MM_7.1.25-12.31.25 Rides.xlsx - Page1.csv' \
  --places-dbf '/path/tl_2025_06_place.dbf'
node infra/scripts/build-agency-operations.mjs
```

Review the three reports under the ignored directory
`scripts/operations/output/agencies/`. Raw NDJSON, SQL and deployment bundles
are private and must not be committed or included in frontend hosting.

Deploy `infra/.aws-sam/agency-operations/migrator/` to the existing IAM-only
migrator Lambda, preserving configuration and using the deployed RevisionId.
Include `index.js`, `agency-schema.sql`, `agency-import.sql`, and
`agency-quality-reports.json` at ZIP root. Migration 0005 must already be
installed (as on the existing LINK dashboard). Invoke:

```json
{"action":"apply-agency-operations"}
```

The fixed bundle applies migration 0006 and the three imports. Each snapshot is
transactional, conflict-safe and row-count checked; repeat imports do not add
duplicates. A newer file replaces only the active snapshot of the same
source/provider; LINK is untouched. The migrator reconciles source counts,
statuses, mapping coverage, pairing counts, pagination and public field scope.
Use `verify-agency-operations` for a read-only reconciliation.

Deploy the bundled `trip-records/index.js` to the existing TripRecords Lambda,
then release the frontend using the existing AWS API environment configuration.
The existing proxy route needs no change. Update the backend before the frontend
so the added provider metadata and identified-record counts are available.

For a direct database alternative, run migration 0006 and each prepared
`import.sql` as complete scripts with the schema-owner connection; do not run
isolated inserts. Raw SQL must never be sent through a public endpoint.

## Checks and rollback

```sh
python3 -m unittest discover -s scripts/operations -p 'test_*.py'
npm run check
npm run build
npm --prefix infra run check
npm --prefix infra run test:operations
node scripts/verify-agency-operations.mjs
```

Use a supported Node version (the project builds with Node 24).
The existing LINK live smoke check explicitly selects provider 2006 so its
historical expectations remain valid with additional published providers.

To hide a newly published snapshot, set only that source/provider's active
import to false as schema owner. Preserve source records and LINK. Restore saved
frontend/backend deployments if rolling back application changes. The migrator
bundle is scoped to agency actions; use the separate LINK bundle for LINK
apply/verify actions because their fixed data files are not interchangeable.

## Production import reconciliation · November 2, 2026

The IAM-only migrator reconciled all three snapshots in the existing production
database: 9,906 WestCAT bookings (3,635 validated round trips), 71,870 Tri Delta
bookings, and 1,673 Mobility Matters rides. WestCAT has 303 identified anonymous
clients; the other two exports have no client IDs. Source status totals,
pagination, mapped endpoints, pair totals and public field scope passed.
The deployment package retained the previous LINK schema/import/report assets
so its existing verification actions remain available.
