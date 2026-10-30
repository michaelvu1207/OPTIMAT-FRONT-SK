import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationClusters } from '../src/lib/utils/operationClusters.js';

const points = [
  { city: 'A', lat: 37.96, lng: -122.03, count: 39976 },
  { city: 'B', lat: 37.98, lng: -122.01, count: 10705 },
  { city: 'C', lat: 37.3, lng: -121.8, count: 981 },
];

test('zooming refines groups without losing or duplicating weighted events', () => {
  const levels = buildOperationClusters(points);
  assert.equal(levels[3].length, 1);
  assert.equal(levels[18].length, 3);
  assert.equal(levels[3][0].count, 51662);
  for (let z = 0; z <= 18; z++) {
    assert.equal(levels[z].reduce((sum, g) => sum + g.count, 0), 51662);
    assert.equal(new Set(levels[z].flatMap(g => g.members)).size, 3);
    if (z > 0) {
      assert(levels[z].length >= levels[z - 1].length);
      for (const child of levels[z]) {
        assert(levels[z - 1].some(parent => child.members.every(p => parent.members.includes(p))));
      }
    }
  }
});

test('clustering is independent of API ordering and sums colocated cities', () => {
  assert.deepEqual(buildOperationClusters(points), buildOperationClusters([...points].reverse()));
  const samePlace = buildOperationClusters([points[0], { ...points[0], city: 'D', count: 24 }]);
  assert.equal(samePlace[18].length, 1);
  assert.equal(samePlace[18][0].count, 40000);
});

test('empty, zero, and invalid points do not invent map events', () => {
  assert(buildOperationClusters([]).every(level => level.length === 0));
  const levels = buildOperationClusters([{ ...points[0], count: 0 }, { ...points[1], lat: NaN }, points[2]]);
  assert(levels.every(level => level.length === 1 && level[0].count === 981));
  assert.throws(() => buildOperationClusters(points, 0));
});
