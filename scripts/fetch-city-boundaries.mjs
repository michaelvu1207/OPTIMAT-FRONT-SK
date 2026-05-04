import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, 'cache', 'city-boundaries');
const USER_AGENT = 'OPTIMAT-Migration/1.0 (transit research)';
const DEFAULT_QUALIFIER = 'California, USA';
const RATE_LIMIT_MS = 1000;

let lastRequestTime = 0;

function citySlug(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function cachePath(cityName) {
  return join(CACHE_DIR, `${citySlug(cityName)}.json`);
}

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Fetch boundary polygon for a single city from Nominatim OSM API.
 * Returns a GeoJSON Feature with the city's geometry, or null if not found.
 */
export async function fetchCityBoundary(cityName, qualifier = DEFAULT_QUALIFIER) {
  const path = cachePath(cityName);

  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf-8'));
    if (cached.features && cached.features.length > 0) {
      const feature = cached.features[0];
      return {
        type: 'Feature',
        geometry: feature.geometry,
        properties: { city: cityName, ...feature.properties },
      };
    }
    return null;
  }

  await rateLimit();

  const q = encodeURIComponent(`${cityName}, ${qualifier}`);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=geojson&polygon_geojson=1&limit=1`;

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    console.warn(`[fetch-city-boundaries] HTTP ${response.status} for "${cityName}"`);
    return null;
  }

  const data = await response.json();

  // Cache the raw Nominatim response
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');

  if (!data.features || data.features.length === 0) {
    console.warn(`[fetch-city-boundaries] No results found for "${cityName}"`);
    return null;
  }

  // Find the first feature with a Polygon or MultiPolygon geometry
  // (skip LineString, Point, etc. which are roads/markers, not boundaries)
  const feature = data.features.find(
    f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
  );

  if (!feature) {
    console.warn(`[fetch-city-boundaries] No polygon boundary found for "${cityName}" (got ${data.features[0].geometry?.type})`);
    return null;
  }

  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: { city: cityName, ...feature.properties },
  };
}

/**
 * Fetch boundaries for multiple cities.
 * Returns a GeoJSON FeatureCollection with each city as a separate Feature,
 * or null if no cities were found.
 */
export async function fetchMultiCityBoundary(cityNames) {
  const features = [];

  for (const cityName of cityNames) {
    const feature = await fetchCityBoundary(cityName);
    if (!feature) {
      console.warn(`[fetch-city-boundaries] Skipping "${cityName}" — not found`);
      continue;
    }
    features.push({
      ...feature,
      properties: { city: cityName },
    });
  }

  if (features.length === 0) {
    return null;
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Remove all cached city boundary files.
 */
export function clearCache() {
  if (!existsSync(CACHE_DIR)) return;
  const files = readdirSync(CACHE_DIR);
  for (const file of files) {
    if (file.endsWith('.json')) {
      unlinkSync(join(CACHE_DIR, file));
    }
  }
  console.log(`[fetch-city-boundaries] Cache cleared (${files.length} files removed)`);
}
