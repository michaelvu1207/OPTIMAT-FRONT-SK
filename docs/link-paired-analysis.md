# LINK paired journey analysis

## Confirmed scope

Sources: the October 26, 2026 meeting transcript, `Paratransit Trip Data
Analysis.pdf`, and `[New]_LINK-070125.xlsx - in.csv`. The PDF's first two pages
define the five requested distributions. Its May 15, 2023 East Contra Costa
statistics are examples, not LINK counts or performance targets.

| Deliverable | Definition | Meeting reference |
| --- | --- | --- |
| Outbound departure time | First leg's PickupDepartTime; one-hour bins | 15:50–18:08, 21:13–22:02 |
| Return departure time | Second leg's PickupDepartTime; one-hour bins | 21:13–22:02 |
| Travel time, going out | First DropOffArriveTime minus first PickupDepartTime; ten-minute bins | 22:06–22:19 |
| Travel time, back home | Second DropOffArriveTime minus second PickupDepartTime; ten-minute bins | 22:06–22:19 |
| Going-out activity duration | Second PickupDepartTime minus first DropOffArriveTime; one-hour bins | 22:28–23:17 |
| Home and activity map | Separate inferred home and activity endpoint colors | 31:03–32:39 |
| Numbered zoom clusters | Split and merge counts as map zoom changes; retain city precision | 32:40–35:03; previously implemented |

Return time means departure for home, not arrival home. Activity duration is
an observed interval that can include waiting and boarding. It is not a
verified duration of a particular activity, nor total time away from home.
All five charts report sample count, mean, minimum and maximum. Counts use
records, not the Passengers field. Histogram bins include their lower bound
and exclude their upper bound. Empty bins are shown; long durations remain
in range rather than being clipped. Times are source local wall times in
America/Los_Angeles; no UTC conversion or overnight rollover is inferred.

Fleet on/off-service time and mileage (23:24–24:58), appointment punctuality
(25:05–26:40), and driving/transit routing comparisons (26:45–30:59) are
research or future work. Additional providers mentioned at 35:36–45:43 need
their own supplied data and import mappings. They are outside this LINK change.

## Source reconciliation

The supplied CSV has 48,832 records, 974 client identifiers, and dates from
July 1 through December 31, 2025. Comparing the multiset of all 18 normalized
columns against the already imported workbook found 48,832 identical records,
zero additions and zero deletions. The CSV changes ordering. No database
schema migration or data reimport is needed for these charts. Existing source
row identifiers continue to refer to the original workbook, not the new CSV.

Adjacent rows are useful examples but not a reliable pairing key. Only 8,823
of 24,416 fixed two-row blocks share both client and date. Among two-record
client days, 706 have the return earlier in file order. CSV rows 4 and 5 are
reversed chronologically; row 6's corresponding return is at row 241.

## Pairing policy

1. Group by active import, client identifier and service date, before applying
   status or hour filters. Imports are provider-scoped.
2. Initially accept only groups with exactly two records and a nonmissing
   client identifier. Retain single-trip and multi-trip days in raw records;
   report their exclusion from paired analysis.
3. Sort by actual PickupDepartTime, independently of source order. Use the
   first leg as outbound and the second as return. No fixed morning/afternoon
   cutoff is imposed.
4. Require all four departure/arrival anchors and the order
   `outbound departure <= outbound arrival <= return departure <= return arrival`.
   Do not substitute SchTime, clamp negative values to zero, or add 24 hours.
5. Require the first pickup and final drop-off addresses and ZIP codes to
   match. Normalize address case and whitespace, and require nonempty keys.
   This infers a home location; it does not establish residence. Block-level
   source addresses cannot support exact household identification.
6. Do not require the first drop-off to match the return pickup. The meeting
   explicitly allows different daytime activity locations (19:29–21:11).

The full source yields 20,409 validated pairs: 20,273 reverse-address pairs
and 136 with a different or unresolved activity address. These observed pairs
all have P/P status; P is not relabeled as a verified completion category.
Excluded records total 8,014. Quality categories before status/hour filtering:

| Category | Count | Unit |
| --- | ---: | --- |
| Single-trip days | 4,618 | Client days |
| More than two trips | 507 | Client days, containing 1,592 records |
| Missing time anchors | 581 | Two-record client days |
| Invalid time sequence | 5 | Two-record client days |
| No matching home endpoints | 316 | Two-record client days |
| Missing client identifier | 0 | Records |

All five charts use the same validated cohort, including the travel-time
charts. They do not describe all one-way trips. One source overnight duration
does not agree with same-day wall-time subtraction and is not repaired by
assuming an end date.

The first CSV pair gives a concrete calculation: outbound 08:58:34–09:16:12
= 17 min 38 sec; return 16:28:26–16:52:59 = 24 min 33 sec; activity interval
09:16:12–16:28:26 = 7 hr 12 min 14 sec. No private identifiers or street
addresses are needed to explain or publish these calculations.

## Filters and map counts

Provider and inclusive date filters define the pairing source. A status filter
requires both legs to match. An hour filter retains the whole pair when either
pickup departure is in the start-inclusive, end-exclusive interval. It does
not drop the counterpart or rebuild pairs. Map origin/destination layers and
trip-list pagination do not change the five charts. Quality counts are labeled
as applying before hour/status filtering.

The original all-endpoint map and raw trip list retain their original filter
semantics. The additional `Paired home & activity` map uses the chart cohort:
outbound pickup and return drop-off are blue home events; outbound drop-off
and return pickup are orange activity events. Each pair contributes four
endpoint events, two of each role. These are not unique homes, people, or
activity sites. Mixed circles show both colors and sum counts at each zoom.
Unmapped endpoints are counted separately. Existing city reference points
are preserved; the feature does not publish exact addresses or client IDs.

## Validation and deployment

The independent local CSV audit is reconciled against production PostgreSQL
through the IAM-only `verify-link-operations` migrator action. Its synthetic
fixtures run inside a transaction with a temporary table and unconditional
rollback. They exercise reversed/nonadjacent rows, address normalization,
different activity sites, missing times, overlapping and overnight legs,
unmatched or empty homes, single/multiple-trip days, date separation,
pair-preserving hour/status filters, empty results and private-field exclusion.
The fixture uses the same SQL fragments as the production endpoint.

Production reconciliation requires each histogram to sum to 20,409 and the
cohort to exclude 8,014 records. Full-cohort mean outbound travel is 36.781387
minutes; mean return travel is 40.365705 minutes; mean activity interval is
4.974630 hours. These are descriptive results for the validated cohort.

Run `node scripts/verify-paired-operations.mjs` for anonymous API checks after
deployment. It checks chart/map totals, date/hour/status filters, empty results,
the public provider boundary, and independence from raw-record pagination.

Deploy the verified API before the frontend. Back up both Lambda bundles and
use RevisionId guards when updating. The existing public allowlist, database
permissions, source provenance, and anonymous access remain in effect.
No raw source file belongs in the frontend build or version control.
