import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATIONS_SQL } from '../trip-records/operations.js';

// Fixed, locally reviewed bundle files only. Invocation input never supplies SQL.
export async function runAgencyOperations(client: pg.Client, apply: boolean) {
  const reports = JSON.parse(await readFile(join(__dirname, 'agency-quality-reports.json'), 'utf8'));
  if (apply) {
    await client.query(await readFile(join(__dirname, 'agency-schema.sql'), 'utf8'));
    await client.query(await readFile(join(__dirname, 'agency-import.sql'), 'utf8'));
  }
  const results = [];
  for (const report of reports) {
    const counts = (await client.query(`SELECT count(*)::integer AS records,
      count(DISTINCT client_id)::integer AS riders, count(origin_lat)::integer AS origins,
      count(destination_lat)::integer AS destinations, min(service_date)::text AS date_from,
      max(service_date)::text AS date_to FROM optimat.operation_trips WHERE import_id=$1`, [report.import_id])).rows[0];
    if (counts.records !== report.row_count || counts.riders !== report.unique_clients ||
        counts.origins !== report.origin_mapped || counts.destinations !== report.destination_mapped ||
        counts.date_from !== report.date_from || counts.date_to !== report.date_to) {
      throw new Error(`${report.source}: imported records do not reconcile`);
    }
    const parameters = [report.provider_id, null, null, 0, 24, null, 'combined', 50, 0];
    const data = (await client.query(OPERATIONS_SQL, parameters)).rows[0].payload;
    if (data.imports.length !== 1 || data.imports[0].id !== report.import_id ||
        data.summary.records !== report.row_count || data.event_summary.total !== report.row_count * 2 ||
        data.event_summary.mapped !== report.origin_mapped + report.destination_mapped ||
        data.heat_points.reduce((sum: number, p: any) => sum + p.count, 0) !== data.event_summary.mapped) {
      throw new Error(`${report.source}: dashboard aggregation does not reconcile`);
    }
    for (const [status, expected] of Object.entries(report.status_counts)) {
      const filtered = (await client.query(OPERATIONS_SQL, [...parameters.slice(0, 5), status, ...parameters.slice(6)])).rows[0].payload;
      if (filtered.summary.records !== expected) throw new Error(`${report.source}: status totals differ`);
    }
    const paired = data.paired_analysis;
    if (paired.events.total !== paired.selected_pairs * 4 ||
        paired.points.reduce((sum: number, p: any) => sum + p.home_count + p.activity_count, 0) !== paired.events.mapped ||
        paired.charts.some((chart: any) => chart.n !== paired.selected_pairs || chart.bins.reduce((sum: number, b: any) => sum + b.count, 0) !== chart.n)) {
      throw new Error(`${report.source}: paired analysis does not reconcile`);
    }
    if (report.source !== 'WESTCAT' && paired.selected_pairs !== 0) throw new Error('Unsupported home inference');
    if (data.trips.some((trip: object) => ['client_id','origin_address','destination_address','origin_zip','destination_zip'].some(key => key in trip))) {
      throw new Error('Private fields leaked');
    }
    const next = (await client.query(OPERATIONS_SQL, [...parameters.slice(0, 8), 50])).rows[0].payload;
    const ids = new Set(data.trips.map((trip: any) => trip.id));
    if (next.trips.some((trip: any) => ids.has(trip.id))) throw new Error('Pagination overlaps');
    results.push({ source: report.source, ...counts, pairs: paired.selected_pairs, events: data.event_summary });
  }
  const unpublished = (await client.query(OPERATIONS_SQL, [2147483647, null, null, 0, 24, null, 'combined', 50, 0])).rows[0].payload;
  if (unpublished.summary.records || unpublished.imports.length || unpublished.trips.length) throw new Error('Unpublished provider exposed');
  return { agencies: results, public_scope_verified: true };
}
