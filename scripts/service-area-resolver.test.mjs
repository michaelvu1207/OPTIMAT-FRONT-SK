#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  loadContraCostaCityIndex,
  normalizeGeoJsonToFeatureCollection,
  parseServiceAreaCities,
  resolveProviderServiceArea,
} from './service-area-resolver.mjs';

const geojsonDir = '/Users/maikyon/Downloads/Geojson Files for Service Areas';
const cityIndex = loadContraCostaCityIndex(`${geojsonDir}/contra_costa_cities.geojson`);

assert.deepEqual(
  parseServiceAreaCities('Walnut Creek, Concord, Clayton, Pleasant Hill, Martinez.'),
  ['Walnut Creek', 'Concord', 'Clayton', 'Pleasant Hill', 'Martinez'],
);

const walnutCreekArea = await resolveProviderServiceArea({
  providerName: 'Walnut Creek Lyft Self Access Pass',
  serviceAreaGeoJson: '',
  serviceAreaCitiesText: 'Walnut Creek, Concord, Clayton, Pleasant Hill, Martinez.',
  geojsonDir,
  cityIndex,
});

assert.equal(walnutCreekArea.source, 'city_list');
assert.equal(walnutCreekArea.geojson.type, 'FeatureCollection');
assert.equal(walnutCreekArea.geojson.features.length, 5);
assert.deepEqual(walnutCreekArea.cities, [
  'Walnut Creek',
  'Concord',
  'Clayton',
  'Pleasant Hill',
  'Martinez',
]);
assert.deepEqual(walnutCreekArea.unresolvedCities, []);

const eastBay = await resolveProviderServiceArea({
  providerName: 'East Bay Paratransit',
  serviceAreaGeoJson: 'https://drive.google.com/file/d/1O6drC5WSoyPKz28yy3ikSX_PGQVzphlq/view?usp=drive_link',
  serviceAreaCitiesText: 'Alameda, Albany, Berkeley',
  geojsonDir,
  cityIndex,
});

assert.equal(eastBay.source, 'custom_geojson');
assert.equal(eastBay.geojson.type, 'FeatureCollection');
assert.ok(eastBay.geojson.features.length >= 1);
assert.deepEqual(eastBay.unresolvedCities, []);

const link = await resolveProviderServiceArea({
  providerName: 'County Connection LINK ',
  serviceAreaGeoJson: 'Geojson',
  serviceAreaCitiesText: 'Concord, Walnut Creek, Pleasant Hill, Martinez',
  geojsonDir,
  cityIndex,
});

assert.equal(link.source, 'custom_geojson');
assert.equal(link.geojson.type, 'FeatureCollection');
assert.ok(link.geojson.features.length >= 1);
assert.equal(link.geojson.features[0].properties.name, 'weekend-service-area');

const featureCollection = normalizeGeoJsonToFeatureCollection({
  type: 'Feature',
  properties: { provider: 'AC Transit' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [-122.3, 37.8],
      [-122.2, 37.9],
    ],
  },
});

assert.equal(featureCollection.type, 'FeatureCollection');
assert.equal(featureCollection.features.length, 1);
assert.equal(featureCollection.features[0].geometry.type, 'LineString');

console.log('service area resolver tests passed');
