#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildDemandHeatPoints } from '../src/lib/utils/heatmap.js';

const trips = [
  {
    id: 'a',
    origin: [37.9001, -122.0601],
    destination: [37.9401, -122.0101],
  },
  {
    id: 'b',
    origin: [37.9002, -122.0602],
    destination: [37.9701, -122.0501],
  },
  {
    id: 'c',
    origin: [37.9501, -122.0001],
    destination: [37.9402, -122.0102],
  },
  {
    id: 'invalid',
    origin: [200, -122.1],
    destination: null,
  },
];

const origins = buildDemandHeatPoints(trips, { mode: 'origins', binSize: 0.01 });
assert.equal(origins.length, 2);
assert.deepEqual(origins.map((point) => point.kind).sort(), ['origins', 'origins']);
assert.equal(Math.max(...origins.map((point) => point.count)), 2);

const destinations = buildDemandHeatPoints(trips, { mode: 'destinations', binSize: 0.01 });
assert.equal(destinations.length, 2);
assert.deepEqual(destinations.map((point) => point.kind).sort(), ['destinations', 'destinations']);
assert.equal(Math.max(...destinations.map((point) => point.count)), 2);

const combined = buildDemandHeatPoints(trips, { mode: 'combined', binSize: 0.01 });
assert.equal(combined.length, 4);
assert.ok(combined.every((point) => point.kind === 'combined'));
assert.equal(combined.reduce((sum, point) => sum + point.count, 0), 6);
assert.ok(combined.every((point) => point.radius >= 7 && point.radius <= 30));
assert.ok(combined.every((point) => Number.isFinite(point.fillOpacity)));

console.log('heatmap tests passed');
