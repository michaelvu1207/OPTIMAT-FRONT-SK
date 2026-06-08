#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  DEFAULT_COMMUNITY_PLACE_GEOJSON_PATH,
  DEFAULT_ZIP_GEOJSON_PATH,
  loadContraCostaCityIndex,
  loadCommunityPlaceIndex,
  loadZipCodeIndex,
  mergeBoundaryIndexes,
  normalizeGeoJsonToFeatureCollection,
  parseServiceAreaCities,
  resolveProviderServiceArea,
} from './service-area-resolver.mjs';

const geojsonDir = '/Users/maikyon/Downloads/Geojson Files for Service Areas';
const cityIndex = loadContraCostaCityIndex(`${geojsonDir}/contra_costa_cities.geojson`);
const cityAndCommunityIndex = mergeBoundaryIndexes(
  cityIndex,
  loadCommunityPlaceIndex(DEFAULT_COMMUNITY_PLACE_GEOJSON_PATH),
);
const fullBoundaryIndex = mergeBoundaryIndexes(
  cityAndCommunityIndex,
  loadZipCodeIndex(DEFAULT_ZIP_GEOJSON_PATH),
);

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

const kensingtonArea = await resolveProviderServiceArea({
  providerName: 'R-Transit (Richmond)',
  serviceAreaGeoJson: '',
  serviceAreaCitiesText: 'North Richmond, El Sobrante, Kensington',
  geojsonDir,
  cityIndex: cityAndCommunityIndex,
});

assert.equal(kensingtonArea.source, 'city_list');
assert.equal(kensingtonArea.geojson.type, 'FeatureCollection');
assert.equal(kensingtonArea.geojson.features.length, 3);
assert.deepEqual(
  kensingtonArea.geojson.features.map((feature) => feature.properties.source_place_name),
  ['North Richmond CDP', 'El Sobrante CDP (Contra Costa County)', 'Kensington CDP'],
);
assert.deepEqual(kensingtonArea.unresolvedCities, []);

assert.deepEqual(
  parseServiceAreaCities('Richmond, North Richmond CDP, El Sobrante CDP, Kensington CDP,'),
  ['Richmond', 'North Richmond', 'El Sobrante', 'Kensington'],
);

const zipArea = await resolveProviderServiceArea({
  providerName: 'San Pablo Senior & Disabled Transportation',
  serviceAreaGeoJson: 'Bay_Area_Zip_ark28722-s7888q-geojson.json',
  serviceAreaCitiesText: 'San Pablo, ZIP 94806',
  geojsonDir,
  cityIndex: fullBoundaryIndex,
});

assert.equal(zipArea.source, 'city_list');
assert.equal(zipArea.geojson.features.length, 2);
assert.deepEqual(zipArea.unresolvedCities, []);
assert.equal(zipArea.geojson.features[1].properties.source_zip, '94806');

const countyArea = await resolveProviderServiceArea({
  providerName: 'Mobility Matters',
  serviceAreaGeoJson: 'contra_costa_county_boundary.geojson',
  serviceAreaCitiesText: 'Contra Costa',
  geojsonDir,
  cityIndex: fullBoundaryIndex,
});

assert.equal(countyArea.source, 'custom_geojson');
assert.equal(countyArea.geojson.type, 'FeatureCollection');
assert.ok(countyArea.geojson.features.length >= 1);

const tdtAdaArea = await resolveProviderServiceArea({
  providerName: 'TDT ADA Paratransit',
  serviceAreaGeoJson: 'tdt-ada.geojson',
  serviceAreaCitiesText: 'Antioch, Bay Point, Pittsburg, Brentwood, Byron CDP',
  geojsonDir,
  cityIndex: fullBoundaryIndex,
});

assert.equal(tdtAdaArea.source, 'custom_geojson');
assert.equal(tdtAdaArea.geojson.type, 'FeatureCollection');
assert.equal(tdtAdaArea.geojson.features[0].properties.agency_name, 'Tri Delta Transit');

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
