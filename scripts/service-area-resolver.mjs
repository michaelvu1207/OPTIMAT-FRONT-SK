import fs from 'node:fs';
import path from 'node:path';
import { getServiceAreaSource } from './service-area-sources.mjs';

export const DEFAULT_SERVICE_AREA_GEOJSON_DIR =
  '/Users/maikyon/Downloads/Geojson Files for Service Areas';

const CITY_ALIASES = {
  'walnut creek.': 'Walnut Creek',
  'downtown walnut creek': 'Walnut Creek',
  'downtown walnut creek.': 'Walnut Creek',
  'rossmoor neighborhood': 'Rossmoor',
  'contra costa': 'Contra Costa County',
  'contra costa county': 'Contra Costa County',
  'eastern contra costa county': 'Eastern Contra Costa County',
  'all nine bay area counties': 'All nine Bay Area Counties',
  'the unincorporated communities of montalvin manor': 'Montalvin Manor',
  'unincorporated communities of montalvin manor': 'Montalvin Manor',
  'port\ncosta': 'Port Costa',
};

const PHRASE_CITY_GROUPS = {
  'Eastern Contra Costa County': [
    'Antioch',
    'Brentwood',
    'Oakley',
    'Pittsburg',
    'Bay Point',
    'Discovery Bay',
    'Byron',
    'Knightsen',
  ],
  'All nine Bay Area Counties': [
    'Alameda County',
    'Contra Costa County',
    'Marin County',
    'Napa County',
    'San Francisco County',
    'San Mateo County',
    'Santa Clara County',
    'Solano County',
    'Sonoma County',
  ],
};

function normalizeName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
}

function titleCase(value) {
  return normalizeName(value)
    .toLowerCase()
    .split(' ')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeGeoJsonToFeatureCollection(geojson) {
  if (!geojson || typeof geojson !== 'object') {
    throw new Error('GeoJSON must be an object');
  }

  if (geojson.type === 'FeatureCollection') {
    if (!Array.isArray(geojson.features)) {
      throw new Error('GeoJSON FeatureCollection missing features array');
    }
    return cloneJson(geojson);
  }

  if (geojson.type === 'Feature') {
    if (!geojson.geometry) {
      throw new Error('GeoJSON Feature missing geometry');
    }
    return {
      type: 'FeatureCollection',
      features: [cloneJson(geojson)],
    };
  }

  if (typeof geojson.type === 'string' && geojson.coordinates) {
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: cloneJson(geojson),
        },
      ],
    };
  }

  throw new Error(`Unsupported GeoJSON type: ${geojson.type ?? 'unknown'}`);
}

export function loadContraCostaCityIndex(cityGeoJsonPath) {
  const raw = JSON.parse(fs.readFileSync(cityGeoJsonPath, 'utf8'));
  const collection = normalizeGeoJsonToFeatureCollection(raw);
  const index = new Map();

  for (const feature of collection.features) {
    const city = feature?.properties?.city;
    if (!city) continue;
    index.set(normalizeName(city), cloneJson(feature));
  }

  return index;
}

function stripServiceAreaNoise(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\([^)]*we need to use existing geojson file[^)]*\)/gi, '')
    .replace(/^fixed\s+route\s*\(?/i, '')
    .replace(/^fixed\s*\(?/i, '')
    .replace(/\bfixed route\b/gi, '')
    .replace(/\bfixed\b/gi, '')
    .replace(/\)/g, '')
    .replace(/\(/g, '')
    .replace(/\.$/, '')
    .trim();
}

export function parseServiceAreaCities(text) {
  const cleaned = stripServiceAreaNoise(text);
  if (!cleaned || /^(none|missing|missing website)$/i.test(cleaned)) return [];

  const phrase = CITY_ALIASES[cleaned.toLowerCase()] ?? normalizeName(cleaned);
  if (PHRASE_CITY_GROUPS[phrase]) return [...PHRASE_CITY_GROUPS[phrase]];

  const rawParts = cleaned
    .replace(/\band the unincorporated communities of\b/gi, ',')
    .replace(/\band unincorporated\b/gi, ', Unincorporated')
    .split(/,\s*(?:and\s+)?|\s+and\s+/i)
    .map((part) => normalizeName(part.replace(/\bpart\b/gi, '').replace(/\?$/g, '')))
    .filter(Boolean);

  const cities = [];
  const seen = new Set();

  for (const rawPart of rawParts) {
    const alias = CITY_ALIASES[rawPart.toLowerCase()];
    const city = alias ?? titleCase(rawPart);
    if (/^(none|missing|missing website|service area depends on the day of the week)$/i.test(city)) {
      continue;
    }
    if (!seen.has(city)) {
      seen.add(city);
      cities.push(city);
    }
  }

  return cities;
}

function resolveLocalPath(sourcePath, geojsonDir) {
  return path.isAbsolute(sourcePath) ? sourcePath : path.join(geojsonDir, sourcePath);
}

function readLocalGeoJson(sourcePath, geojsonDir) {
  const fullPath = resolveLocalPath(sourcePath, geojsonDir);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

async function readRemoteGeoJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'OPTIMAT-ServiceAreaImport/1.0' },
  });
  if (!response.ok) {
    throw new Error(`GeoJSON fetch failed ${response.status} for ${url}`);
  }
  return response.json();
}

function sourceFromWorkbookValue(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\/.+\.geojson(?:\?.*)?$/i.test(trimmed)) {
    return { type: 'remote_geojson', url: trimmed };
  }
  return null;
}

function citiesToFeatureCollection(cities, cityIndex) {
  const features = [];
  const unresolvedCities = [];

  for (const city of cities) {
    const feature = cityIndex.get(city);
    if (!feature) {
      unresolvedCities.push(city);
      continue;
    }
    const next = cloneJson(feature);
    next.properties = { ...(next.properties ?? {}), city };
    features.push(next);
  }

  return {
    geojson: features.length ? { type: 'FeatureCollection', features } : null,
    unresolvedCities,
  };
}

export async function resolveProviderServiceArea({
  providerName,
  serviceAreaGeoJson,
  serviceAreaCitiesText,
  geojsonDir = DEFAULT_SERVICE_AREA_GEOJSON_DIR,
  cityIndex,
  existingServiceZone = null,
}) {
  const trimmedProviderName = String(providerName ?? '').trim();
  const source = getServiceAreaSource(trimmedProviderName) ?? sourceFromWorkbookValue(serviceAreaGeoJson);
  const cities = parseServiceAreaCities(serviceAreaCitiesText);

  if (source) {
    const rawGeoJson = source.type === 'local_geojson'
      ? readLocalGeoJson(source.path, geojsonDir)
      : await readRemoteGeoJson(source.url);
    const geojson = normalizeGeoJsonToFeatureCollection(rawGeoJson);
    return {
      geojson,
      serviceAreaGeoJson: geojson,
      cities,
      source: 'custom_geojson',
      notes: source.type === 'local_geojson'
        ? `Imported from ${resolveLocalPath(source.path, geojsonDir)}`
        : `Imported from ${source.url}`,
      unresolvedCities: [],
    };
  }

  if (cities.length > 0 && cityIndex) {
    const generated = citiesToFeatureCollection(cities, cityIndex);
    if (generated.geojson && generated.unresolvedCities.length === 0) {
      return {
        geojson: generated.geojson,
        serviceAreaGeoJson: null,
        cities,
        source: 'city_list',
        notes: null,
        unresolvedCities: [],
      };
    }

    if (existingServiceZone) {
      return {
        geojson: normalizeGeoJsonToFeatureCollection(existingServiceZone),
        serviceAreaGeoJson: null,
        cities,
        source: 'existing_preserved',
        notes: `Preserved existing service zone; unresolved cities: ${generated.unresolvedCities.join(', ')}`,
        unresolvedCities: generated.unresolvedCities,
      };
    }

    return {
      geojson: generated.geojson,
      serviceAreaGeoJson: null,
      cities,
      source: 'unresolved',
      notes: `Unresolved cities: ${generated.unresolvedCities.join(', ')}`,
      unresolvedCities: generated.unresolvedCities,
    };
  }

  if (existingServiceZone) {
    return {
      geojson: normalizeGeoJsonToFeatureCollection(existingServiceZone),
      serviceAreaGeoJson: null,
      cities,
      source: 'existing_preserved',
      notes: 'Preserved existing service zone; no import source available',
      unresolvedCities: [],
    };
  }

  return {
    geojson: null,
    serviceAreaGeoJson: null,
    cities,
    source: 'unresolved',
    notes: 'No service-area source available',
    unresolvedCities: [],
  };
}
