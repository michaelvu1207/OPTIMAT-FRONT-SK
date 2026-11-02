import assert from 'node:assert/strict';

// Anonymous, read-only production reconciliation. Never retrieves private fields.
const base = process.env.OPERATIONS_API_URL || 'https://api.optimat.us/trip-records/operations';
async function read(filters = {}) {
  const url = new URL(base);
  url.search = new URLSearchParams(filters).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.doesNotMatch(JSON.stringify(data), /"(?:client_id|origin_address|destination_address|origin_zip|destination_zip|space_type)"/);
  assert.equal(data.heat_points.reduce((sum, p) => sum + p.count, 0), data.event_summary.mapped);
  const paired = data.paired_analysis;
  assert.equal(paired.events.total, paired.selected_pairs * 4);
  assert.equal(paired.events.mapped + paired.events.unmapped, paired.events.total);
  assert.equal(paired.points.reduce((sum, p) => sum + p.count, 0), paired.events.mapped);
  for (const p of paired.points) assert.equal(p.count, p.home_count + p.activity_count);
  for (const chart of paired.charts) {
    assert.equal(chart.n, paired.selected_pairs);
    assert.equal(chart.bins.reduce((sum, b) => sum + b.count, 0), chart.n);
  }
  return data;
}
const expectations = [
  { id: 2006, source: 'LINK', records: 48832, pairs: 20409, mapped: 95372 },
  { id: 1003, source: 'WESTCAT', records: 9906, pairs: 3635, mapped: 19299 },
  { id: 1002, source: 'TDT', records: 71870, pairs: 0, mapped: 143531 },
  { id: 4021, source: 'MM', records: 1673, pairs: 0, mapped: 3262 },
];
const results = await Promise.all(expectations.map(async expected => {
  const data = await read({ provider_id: String(expected.id) });
  assert.equal(data.imports.length, 1);
  assert.equal(data.imports[0].source, expected.source);
  assert.equal(data.summary.records, expected.records);
  assert.equal(data.event_summary.total, expected.records * 2);
  assert.equal(data.event_summary.mapped, expected.mapped);
  assert.equal(data.paired_analysis.selected_pairs, expected.pairs);
  return { provider: expected.source, records: data.summary.records, pairs: data.paired_analysis.selected_pairs };
}));
const all = await read();
assert.equal(all.imports.length, 4);
assert.equal(all.summary.records, 132281);
assert.equal(all.paired_analysis.selected_pairs, 24044);
assert.equal((await read({ provider_id: '1003', status: 'Cancelled at door' })).summary.records, 269);
assert.equal((await read({ provider_id: '1002', status: 'CA,UG' })).summary.records, 4);
assert.equal((await read({ provider_id: '4021', hour_from: '8', hour_to: '9' })).summary.records, 0);
assert.equal((await read({ provider_id: '9999' })).summary.records, 0);
console.log(JSON.stringify({ verified: true, providers: results, total_records: all.summary.records,
  checks: ['source totals', 'LINK preserved', 'all map and role totals', 'histogram counts', 'agency status filters', 'missing-time exclusion', 'provider scope', 'public field sanitization'] }, null, 2));
