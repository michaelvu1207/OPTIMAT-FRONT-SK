import assert from 'node:assert/strict';
import { DEMAND_BANDS, demandStyle } from '../src/lib/utils/demandScale.js';
import { buildOperationClusters } from '../src/lib/utils/operationClusters.js';

for (let i = 1; i < DEMAND_BANDS.length; i++) {
  const threshold = DEMAND_BANDS[i].min;
  assert.equal(demandStyle(threshold - 1).color, DEMAND_BANDS[i - 1].color);
  assert.equal(demandStyle(threshold).color, DEMAND_BANDS[i].color);
}
// The screenshot's extreme counts must remain readable and visibly distinct.
const counts = [1, 14, 37, 591, 1005, 7588, 9410, 16083, 30136, 66291, 99784, 261464];
const sizes = counts.map(count => demandStyle(count).size);
assert.ok(sizes.every((size, i) => size >= 36 && size <= 84 && (!i || size >= sizes[i - 1])));
assert.equal(new Set(counts.map(count => demandStyle(count).color)).size, 5);
// Clusters encode summed demand, not number of cities; zoom preserves totals.
const points = [
  { city: 'A', lat: 38, lng: -122, count: 30000 },
  { city: 'B', lat: 38.01, lng: -122.01, count: 25000 },
];
const levels = buildOperationClusters(points);
assert.ok(levels.every(groups => groups.reduce((sum, group) => sum + group.count, 0) === 55000));
assert.equal(demandStyle(levels[0][0].count).color, DEMAND_BANDS[4].color);
assert.ok(levels[18].every(group => demandStyle(group.count).color === DEMAND_BANDS[3].color));
console.log('Demand scale: boundaries, size, skewed counts and zoom aggregation passed.');
