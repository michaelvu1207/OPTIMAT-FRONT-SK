import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATIONS_SQL } from '../trip-records/operations.js';

// These files must be included in the reviewed deployment archive. No SQL,
// storage keys, credentials, or record payloads are accepted from the event.
export async function runLinkOperations(client: pg.Client, apply: boolean) {
  const report = JSON.parse(await readFile(join(__dirname, 'link-quality-report.json'), 'utf8'));
  if (apply) {
    await client.query(await readFile(join(__dirname, 'link-schema.sql'), 'utf8'));
    await client.query(await readFile(join(__dirname, 'link-import.sql'), 'utf8'));
  }
  const actual = await client.query(`SELECT count(*)::integer AS records,
    count(DISTINCT client_id)::integer AS riders,
    count(origin_lat)::integer AS origins, count(destination_lat)::integer AS destinations,
    min(service_date)::text AS date_from, max(service_date)::text AS date_to
    FROM optimat.operation_trips WHERE import_id=$1`, [report.import_id]);
  const row = actual.rows[0];
  if (row.records !== report.row_count || row.riders !== report.unique_clients ||
      row.origins !== report.origin_mapped || row.destinations !== report.destination_mapped ||
      row.date_from !== report.date_from || row.date_to !== report.date_to) {
    throw new Error('Imported LINK data does not reconcile with the prepared workbook report');
  }
  const statuses = await client.query('SELECT status,count(*)::integer AS count FROM optimat.operation_trips WHERE import_id=$1 GROUP BY status', [report.import_id]);
  if (statuses.rows.length !== Object.keys(report.status_counts).length || statuses.rows.some(item => report.status_counts[item.status] !== item.count)) {
    throw new Error('LINK status counts do not reconcile');
  }
  const parameters = [true, '00000000-0000-0000-0000-000000000000', report.provider_id, null, null, 0, 24, null, 'combined', 50, 0];
  const dashboard = (await client.query(OPERATIONS_SQL, parameters)).rows[0].payload;
  if (dashboard.summary.records !== report.row_count || dashboard.event_summary.total !== report.row_count * 2 ||
      dashboard.event_summary.mapped !== report.origin_mapped + report.destination_mapped) {
    throw new Error('Dashboard aggregation does not reconcile');
  }
  const unauthorized = (await client.query(OPERATIONS_SQL, [false, ...parameters.slice(1)])).rows[0].payload;
  if (unauthorized.summary.records !== 0 || unauthorized.imports.length !== 0 || unauthorized.trips.length !== 0) {
    throw new Error('Operations provider scope verification failed');
  }
  const cases = [
    { from: '2025-12-31', to: '2025-12-31', status: null, mode: 'origins', start: 0, end: 24 },
    { from: '2025-07-01', to: '2025-07-31', status: 'P', mode: 'origins', start: 8, end: 10 },
    { from: '2025-07-01', to: '2025-12-31', status: 'NS', mode: 'destinations', start: 14, end: 16 },
    { from: '2026-01-01', to: '2026-01-02', status: null, mode: 'origins', start: 0, end: 24 },
  ];
  const filterChecks = [];
  for (const test of cases) {
    const timeColumn = test.mode === 'origins' ? 'pickup_depart_time' : 'dropoff_arrive_time';
    const expected = (await client.query(`SELECT count(*)::integer AS count FROM optimat.operation_trips
      WHERE import_id=$1 AND service_date BETWEEN $2::date AND $3::date
      AND ($4::text IS NULL OR status=$4)
      AND (($5=0 AND $6=24) OR (extract(hour FROM ${timeColumn}) >= $5 AND extract(hour FROM ${timeColumn}) < $6))`,
      [report.import_id, test.from, test.to, test.status, test.start, test.end])).rows[0].count;
    const actual = (await client.query(OPERATIONS_SQL, [true, parameters[1], report.provider_id,
      test.from, test.to, test.start, test.end, test.status, test.mode, 50, 0])).rows[0].payload;
    if (actual.summary.records !== expected || actual.event_summary.total !== expected) {
      throw new Error('Operations date/status/hour filter verification failed');
    }
    filterChecks.push({ ...test, records: expected });
  }
  const nextPage = (await client.query(OPERATIONS_SQL, [...parameters.slice(0, 10), 50])).rows[0].payload;
  const firstIds = new Set(dashboard.trips.map((trip: { id: string }) => trip.id));
  if (nextPage.trips.some((trip: { id: string }) => firstIds.has(trip.id))) throw new Error('Operations pagination overlaps');
  if (dashboard.trips.some((trip: object) => 'client_id' in trip || 'origin_address' in trip)) throw new Error('Private raw fields leaked into dashboard records');
  return { import_id: report.import_id, source: report.filename, ...row,
    event_summary: dashboard.event_summary, scoped_access_verified: true, pagination_verified: true, filter_checks: filterChecks };
}
