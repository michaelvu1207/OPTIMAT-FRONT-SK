# Continuous demand heatmap: local review

Status: implemented and verified locally; not deployed. No paid geocoding API was used.

## Changes

The previous map grouped operational endpoints at Census city reference points. Changing marker colors could not reveal demand within cities. The new heatmap uses free Census address matching, aggregates locations into fixed 1 km cells on the server, and draws a continuous Gaussian surface. City event counts remain available as a separate display.

The heatmap also overlays numbered city clusters by default. Clicking a combined circle zooms to the next split level; clicking a city recenters and opens its count details. The existing city list can also focus the heatmap. A checkbox temporarily hides counts. White circles show city totals, including events that lack spatial coverage; they do not represent the rounded weights of individual heat cells. The heat canvas uses a Leaflet pane below markers and popups so counts remain readable and clickable.

The smoothing standard deviation is 1 km, truncated at 3 km. Intensity is additive by endpoint count and square-root compressed for color visibility. The scale is fixed across panning and zooming for a selection but recalculated when filters change. Colors describe relative recorded service activity, not unmet demand, unique riders, or verified completed trips. A kernel can extend across geographic boundaries; its colored footprint is not a service-area boundary.

The supplied LINK addresses predominantly represent 100-number ranges. The pipeline resolves both range boundaries, accepts only matches to the same returned street/locality within 1.5 km, and uses their geographic midpoint as an explicitly approximate range location. It does not claim a passenger's precise house location. Unmatched or ambiguous ranges and street-only entries remain excluded. WestCAT and Tri Delta use Census street interpolation, which is also not rooftop accuracy. Mobility Matters supplies city/ZIP fields without street addresses and is excluded from address-based heat.

## Privacy and data handling

- Census receives address, city, state, ZIP, and an opaque address-derived request key only. No client IDs, service dates, rider information, or trip counts are sent.
- Raw source files, geocoding cache, precise coordinates, generated imports, and local verification output remain under ignored local paths.
- The public spatial payload contains only 1 km cell centers and rounded counts. No address, address key, source-row identifier, or precise geocode is included.
- Each displayed cell requires at least 20 events and five distinct occupied 100 m subcells after the provider/date/status/hour/direction filters. Counts round down to multiples of ten.
- Suppression and coarse aggregation reduce disclosure risk; they are not a formal differential-privacy or anonymity guarantee. Repeated overlapping filters remain a residual disclosure consideration.

## Coverage from the reviewed exports

| Provider | Source records | Endpoint slots | Geocoded endpoints | Published cells, full-day both |
| --- | ---: | ---: | ---: | ---: |
| LINK | 48,832 | 97,664 | 61,904 | 51 |
| WestCAT | 9,906 | 19,812 | 17,985 | 23 |
| Tri Delta Transit | 71,870 | 143,740 | 131,996 | 114 |
| Mobility Matters | 1,673 | 3,346 | 0 | 0 |
| Combined | 132,281 | 264,562 | 211,885 | 189 |

Combined cells are recomputed across providers, so their count need not equal the sum of provider-specific cells. Published rounded weights total 171,090 in the combined view after suppression and rounding; this is distinct from geocoding coverage.

## Valid provider charts

All providers now have daily source-record counts, origin/destination city counts, and source-status statistics. Daily charts include zero-count dates between the first and last selected service date.

Tri Delta has 56,610 actual departure observations and 54,971 non-reversed actual travel durations in the unfiltered snapshot. These are single-record distributions, with no invented outbound/return labels. Mobility Matters has no actual leg timestamps; it receives daily/city/status charts and a concise explanation instead of empty duration charts. Unavailable paired analysis no longer occupies five empty histogram cards. Existing validated LINK and WestCAT paired analysis remains available.

## Verification

- Ran the production dashboard SQL in local PGlite/PostgreSQL against all 132,281 normalized source records and 211,885 geocoded endpoint assignments.
- Reconciled daily and status totals to source-record totals for all four providers and the combined view.
- Verified empty date selections and missing-time exclusion in narrow hourly selections.
- Tested privacy boundaries with synthetic records: 19 events are withheld; 20 events across only four locations are withheld; 20 across five locations are shown; a status-filtered subset below the threshold is withheld.
- Verified spatial API objects contain no private identifier/address fields and counts are rounded.
- Confirmed LINK source dates, addresses, cities, actual departure/arrival times, and city reference coordinates match the existing reviewed import exactly.
- Four Python normalization/grid tests and the JavaScript density/palette tests passed.
- Five existing operations API tests passed.
- `npm run check`: zero errors and zero warnings. Production build passed.
- Browser preview confirmed the blended Tri Delta heat surface, its two populated single-trip histograms, and Mobility Matters daily/city/status charts with 1,673 records. No empty paired histogram cards are rendered for either provider.

## Local preview and deployment sequence

The preview server binds to `127.0.0.1:43112`, loads private data into memory, and exposes the production aggregate query only. The frontend enables it only with `VITE_OPERATIONS_PREVIEW=1` in development; this branch is eliminated from production builds. The preview is at `http://127.0.0.1:43111/#/provider-portal/universal-service-dashboard` while both local processes are running.

After the user reviews and approves deployment:

1. Back up the current production functions and frontend revision.
2. Apply migration `0007_operation_spatial_cells.sql` before publishing the new API.
3. Apply the private generated spatial import. Its transaction reconciles every endpoint to an active source import using source, row number, date, and original address; any count mismatch aborts it.
4. Deploy the operations API, verify provider/filter totals and spatial suppression, then deploy the frontend.
5. Verify public payloads and the rendered map. Roll back the API/frontend revisions together if needed; the additive spatial table can remain unused.

No source files, address caches, or generated spatial SQL should be committed or uploaded as public assets. AWS login and production deployment have not been attempted in this implementation pass.
