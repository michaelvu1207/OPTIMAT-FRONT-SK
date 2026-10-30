import assert from 'node:assert/strict';
import type pg from 'pg';
import { PAIRED_CTES, PAIRED_PAYLOAD, PAIR_SOURCE_COLUMNS } from './paired-analysis.js';

// Exercise the production SQL in PostgreSQL with synthetic private fixtures.
// Temporary rows are always rolled back; no published data is modified.
export async function verifyPairedAnalysis(client: pg.Client) {
  await client.query('BEGIN');
  try {
    await client.query('CREATE TEMP TABLE pair_test_input (LIKE optimat.operation_trips) ON COMMIT DROP');
    let row = 2;
    const add = async (id: string | null, origin: string, destination: string, depart: string | null,
      arrive: string | null, status = 'P', date = '2025-07-01') => {
      await client.query(`INSERT INTO pair_test_input
        (import_id,source_row,service_date,client_id,origin_address,origin_zip,destination_address,destination_zip,
         pickup_depart_time,dropoff_arrive_time,status,origin_city,destination_city,origin_lat,origin_lng,destination_lat,destination_lng)
        VALUES ('fixture',$1,$2,$3,$4,'94500',$5,'94500',$6,$7,$8,'CITY A','CITY B',38,-122,37.9,-122.1)`,
      [row++, date, id, origin, destination, depart, arrive, status]);
    };
    // Return first in source order, nonadjacent outbound, normalized addresses.
    await add('strict', 'Activity A', ' home   a ', '16:28:26', '16:52:59');
    await add('changed', 'Home B', 'Activity B', '09:00:00', '10:00:00');
    await add('strict', 'HOME A', 'ACTIVITY A', '08:58:34', '09:16:12');
    await add('changed', 'Activity C', 'Home B', '15:00:00', '16:00:00', 'NS');
    await add('missing', 'Home C', 'Activity A', '08:00:00', null);
    await add('missing', 'Activity A', 'Home C', '15:00:00', '16:00:00');
    await add('overlap', 'Home D', 'Activity A', '08:00:00', '10:00:00');
    await add('overlap', 'Activity A', 'Home D', '09:00:00', '11:00:00');
    await add('open', 'Home E', 'Activity A', '08:00:00', '09:00:00');
    await add('open', 'Activity A', 'Other address', '15:00:00', '16:00:00');
    await add('multi', 'Home F', 'Activity A', '08:00:00', '09:00:00');
    await add('multi', 'Activity A', 'Home F', '15:00:00', '16:00:00');
    await add('multi', 'Home F', 'Other address', '17:00:00', null, 'NS');
    await add('single', 'Home G', 'Activity A', '08:00:00', '09:00:00');
    await add(null, 'Home H', 'Activity A', '08:00:00', '09:00:00');
    await add('different_day', 'Home I', 'Activity A', '08:00:00', '09:00:00');
    await add('different_day', 'Activity A', 'Home I', '15:00:00', '16:00:00', 'P', '2025-07-02');

    const query = async (from = 0, to = 24, status: string | null = null, date: string | null = null) => {
      const result = await client.query(`WITH pair_source AS MATERIALIZED (
        SELECT ${PAIR_SOURCE_COLUMNS} FROM pair_test_input t
        WHERE ($1::integer IS NULL OR $1=2006) AND ($2::date IS NULL OR service_date >= $2)
          AND ($3::date IS NULL OR service_date <= $3)
      ), ${PAIRED_CTES} SELECT ${PAIRED_PAYLOAD} AS payload`, [2006, date, date, from, to, status]);
      return result.rows[0].payload;
    };
    const all = await query();
    assert.deepEqual(all.quality, { source_records: 17, single_trip_days: 3, multi_trip_days: 1,
      missing_client_records: 1, missing_time_pairs: 1, invalid_sequence_pairs: 1,
      unmatched_home_pairs: 1, valid_pairs: 2, excluded_records: 13 });
    assert.equal(all.selected_pairs, 2);
    assert.equal(all.changed_activity_pairs, 1);
    assert.equal(all.events.total, 8);
    assert.equal(all.points.reduce((sum: number, point: any) => sum + point.home_count, 0), 4);
    assert.equal(all.points.reduce((sum: number, point: any) => sum + point.activity_count, 0), 4);
    for (const chart of all.charts) {
      assert.equal(chart.n, 2);
      assert.equal(chart.bins.reduce((sum: number, bin: any) => sum + bin.count, 0), 2);
    }
    const morning = await query(8, 9);
    assert.equal(morning.selected_pairs, 1);
    assert.equal(morning.charts.find((c: any) => c.id === 'return_time').bins[0].start, 16);
    assert.ok(Math.abs(morning.charts.find((c: any) => c.id === 'outbound_travel').mean - (17 + 38 / 60)) < 0.000001);
    assert.ok(Math.abs(morning.charts.find((c: any) => c.id === 'return_travel').mean - (24 + 33 / 60)) < 0.000001);
    assert.ok(Math.abs(morning.charts.find((c: any) => c.id === 'activity_duration').mean - (7 + 12 / 60 + 14 / 3600)) < 0.000001);
    assert.equal((await query(16, 17)).selected_pairs, 1);
    assert.equal((await query(0, 24, 'P')).selected_pairs, 1);
    assert.equal((await query(0, 24, 'NS')).selected_pairs, 0);
    assert.equal((await query(18, 19)).selected_pairs, 0);
    const empty = await query(0, 24, null, '2026-01-01');
    assert.equal(empty.quality.source_records, 0);
    assert.deepEqual(empty.charts, []);
    assert.deepEqual(empty.points, []);
    await add('overnight', 'Home J', 'Activity A', '20:00:00', '21:00:00');
    await add('overnight', 'Activity A', 'Home J', '23:00:00', '01:00:00');
    assert.equal((await query()).quality.invalid_sequence_pairs, 2);
    await add('empty_home', ' ', 'Activity A', '08:00:00', '09:00:00');
    await add('empty_home', 'Activity A', ' ', '15:00:00', '16:00:00');
    assert.equal((await query()).quality.unmatched_home_pairs, 2);
    assert.doesNotMatch(JSON.stringify(all), /client_id|origin_address|destination_address|Home A|Activity A|94500/);
    return { synthetic_pairing_verified: true, pair_filtering_verified: true, paired_privacy_verified: true };
  } finally {
    await client.query('ROLLBACK');
  }
}
