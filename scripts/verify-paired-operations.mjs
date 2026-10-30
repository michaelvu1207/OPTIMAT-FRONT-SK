import assert from 'node:assert/strict';

// Optional live smoke check. Sends only anonymous reads to the published API.
const base = process.env.OPERATIONS_API_URL || 'https://api.optimat.us/trip-records/operations';
const queries = ['', '?date_from=2025-07-01&date_to=2025-07-01',
  '?hour_from=8&hour_to=9', '?status=NS', '?provider_id=9999',
  '?date_from=2026-01-01&date_to=2026-01-02', '?mode=destinations&offset=50'];
const results = await Promise.all(queries.map(async query => {
  const response = await fetch(base + query, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, query);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  const pair = data.paired_analysis;
  assert.ok(pair, 'The backend must support paired analysis');
  assert.equal(pair.events.total, pair.selected_pairs * 4);
  assert.equal(pair.events.mapped + pair.events.unmapped, pair.events.total);
  assert.equal(pair.points.reduce((sum, p) => sum + p.count, 0), pair.events.mapped);
  for (const p of pair.points) assert.equal(p.home_count + p.activity_count, p.count);
  for (const chart of pair.charts) {
    assert.equal(chart.n, pair.selected_pairs);
    assert.equal(chart.bins.reduce((sum, bin) => sum + bin.count, 0), chart.n);
  }
  assert.doesNotMatch(JSON.stringify(data), /"(?:client_id|origin_address|destination_address|origin_zip|destination_zip|space_type)"/);
  return data;
}));
assert.equal(results[0].summary.records, 48832);
assert.equal(results[0].paired_analysis.selected_pairs, 20409);
assert.equal(results[0].paired_analysis.quality.excluded_records, 8014);
assert.equal(results[0].paired_analysis.charts.length, 5);
assert.ok(results[1].paired_analysis.selected_pairs > 0 && results[1].paired_analysis.selected_pairs < 20409);
const morning = results[2].paired_analysis;
assert.ok(morning.selected_pairs > 0 && morning.selected_pairs < 20409);
assert.ok(morning.charts.find(c => c.id === 'return_time').bins.some(b => b.start >= 9 && b.count > 0));
for (const i of [3, 4, 5]) {
  assert.equal(results[i].paired_analysis.selected_pairs, 0);
  assert.deepEqual(results[i].paired_analysis.charts, []);
}
assert.equal(results[4].imports.length, 0);
assert.deepEqual(results[6].paired_analysis, results[0].paired_analysis);
console.log(JSON.stringify({ verified: true, source_records: results[0].summary.records,
  pairs: results[0].paired_analysis.selected_pairs, paired_events: results[0].paired_analysis.events,
  single_day_pairs: results[1].paired_analysis.selected_pairs, morning_window_pairs: morning.selected_pairs,
  checked: ['five histogram totals', 'map role totals', 'date/hour/status filters', 'empty states',
    'unpublished provider exclusion', 'pagination and map mode independence', 'private field exclusion'] }, null, 2));
