/**
 * Providers Lambda Function
 *
 * Handles provider-related API endpoints:
 *   GET  /providers              - List all providers
 *   GET  /providers/search?q=... - Search providers by name
 *   GET  /providers/map          - GeoJSON FeatureCollection for map display
 *   GET  /providers/geocode?address=... - Geocode an address
 *   GET  /providers/:id          - Get single provider by provider_id
 *   GET  /providers/:id/service-zone - Get provider service zone
 *   POST /providers/filter       - Filter providers by location and criteria
 *   PUT  /providers/:id          - Update provider
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { requireMigrationAdmin } from '../_shared/admin.js';
import { query, queryRows, queryOne, TABLES, normalizeProvider } from '../_shared/db.js';
import { geocodePlace } from '../_shared/location.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProviderFilter {
  source_address: string;
  destination_address: string;
  provider_type?: string;
  routing_type?: string;
  schedule_type?: string;
  planning_type?: string;
  eligibility_req_contains?: string;
  eligibility_type?: string;
  provider_org?: string;
  provider_name__contains?: string;
  is_operating?: boolean;
  has_service_zone?: boolean;
  booking_method?: string;
  fare_type?: string;
}

interface ProviderUpdate {
  provider_name?: string;
  provider_type?: string;
  routing_type?: string;
  schedule_type?: unknown;
  eligibility_reqs?: unknown;
  booking?: unknown;
  fare?: unknown;
  contacts?: unknown;
  website?: string;
  round_trip_booking?: boolean;
  investigated?: boolean;
  service_zone?: unknown;
}

interface GeoCoordinate {
  lat: number;
  lon: number;
}

interface GeocodeResult {
  success: boolean;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  message?: string;
}

interface ProviderRecord {
  provider_type?: string | null;
  routing_type?: string | null;
  schedule_type?: unknown;
  planning_type?: string | null;
  eligibility_reqs?: unknown;
  booking?: unknown;
  fare?: unknown;
  service_zone?: unknown;
  provider_org?: string | null;
  provider_name?: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_SELECT_FIELDS = `
  id,
  provider_id,
  provider_name,
  provider_type,
  routing_type,
  schedule_type,
  planning_type,
  eligibility_reqs,
  booking,
  fare,
  service_hours,
  service_zone,
  service_area_cities,
  service_area_source,
  service_area_notes,
  provider_software,
  website,
  provider_org,
  round_trip_booking,
  investigated,
  created_at
`;

// ─── Geocoding ──────────────────────────────────────────────────────────────

/**
 * Geocode an address using Amazon Location Service.
 */
async function geocodeAddress(address: string): Promise<GeocodeResult> {
  if (!address.trim()) {
    return { success: false, message: 'Address is required' };
  }

  try {
    const place = await geocodePlace(address);
    if (place) {
      return {
        success: true,
        coordinates: { latitude: place.lat, longitude: place.lng },
      };
    }
  } catch (err) {
    console.error('Amazon Location geocoding error:', err);
  }

  return { success: false, message: 'Geocoding failed' };
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

/**
 * GET /providers - List all providers.
 */
async function listProviders(origin: string | null) {
  try {
    const rows = await queryRows(
      `SELECT ${PROVIDER_SELECT_FIELDS} FROM ${TABLES.PROVIDERS} ORDER BY provider_name`
    );
    const data = rows.map((r) => normalizeProvider(r));
    return jsonResponse({ data }, 200, origin);
  } catch (err) {
    console.error('Error fetching providers:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * GET /providers/:id - Get a single provider by provider_id.
 */
async function getProviderById(providerId: string, origin: string | null) {
  try {
    const row = await queryOne(
      `SELECT ${PROVIDER_SELECT_FIELDS} FROM ${TABLES.PROVIDERS} WHERE provider_id = $1`,
      [parseInt(providerId, 10)]
    );

    if (!row) {
      return errorResponse(`Provider with id ${providerId} not found`, 404, origin);
    }

    return jsonResponse(normalizeProvider(row), 200, origin);
  } catch (err) {
    console.error('Error fetching provider:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * GET /providers/search?q=... - Search providers by text query.
 */
async function searchProviders(searchQuery: string, origin: string | null) {
  try {
    if (!searchQuery || searchQuery.length < 2) {
      return errorResponse('Search query must be at least 2 characters', 400, origin);
    }

    // Try RPC function first
    try {
      const rows = await queryRows(
        'SELECT * FROM optimat.search_providers($1)',
        [searchQuery]
      );
      const data = rows.map((r) => normalizeProvider(r));
      return jsonResponse(data, 200, origin);
    } catch (rpcErr: any) {
      // If the function does not exist (42883), fall back to direct query
      if (rpcErr?.code !== '42883') throw rpcErr;
    }

    // Fallback: ILIKE search across multiple columns
    const pattern = `%${searchQuery}%`;
    const rows = await queryRows(
      `SELECT ${PROVIDER_SELECT_FIELDS}
       FROM ${TABLES.PROVIDERS}
       WHERE provider_name ILIKE $1
          OR provider_org ILIKE $1
          OR provider_type ILIKE $1
       ORDER BY provider_name
       LIMIT 25`,
      [pattern]
    );

    const data = rows.map((r) => normalizeProvider(r));
    return jsonResponse(data, 200, origin);
  } catch (err) {
    console.error('Error searching providers:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * GET /providers/map - GeoJSON FeatureCollection for map display.
 */
async function getProvidersMap(origin: string | null) {
  try {
    // Try RPC function first
    try {
      const row = await queryOne('SELECT optimat.get_providers_geojson() AS geojson');
      if (row?.geojson) {
        return jsonResponse(row.geojson, 200, origin);
      }
    } catch (rpcErr: any) {
      if (rpcErr?.code !== '42883') throw rpcErr;
    }

    // Fallback: build GeoJSON manually from provider centroids
    const rows = await queryRows(
      `SELECT provider_id, provider_name, provider_type, provider_org, service_zone
       FROM ${TABLES.PROVIDERS}
       WHERE service_zone IS NOT NULL`
    );

    const features = rows
      .map((provider) => {
        const serviceZone = typeof provider.service_zone === 'string'
          ? (() => { try { return JSON.parse(provider.service_zone); } catch { return null; } })()
          : provider.service_zone;

        if (!serviceZone) return null;

        let centroid: [number, number] | null = null;

        if (serviceZone.features && Array.isArray(serviceZone.features)) {
          const firstFeature = serviceZone.features[0];
          if (firstFeature?.geometry?.coordinates) {
            const coords = firstFeature.geometry.coordinates;
            if (firstFeature.geometry.type === 'Polygon' && coords[0]) {
              const ring = coords[0] as [number, number][];
              const sumLon = ring.reduce((acc: number, c: [number, number]) => acc + c[0], 0);
              const sumLat = ring.reduce((acc: number, c: [number, number]) => acc + c[1], 0);
              centroid = [sumLon / ring.length, sumLat / ring.length];
            } else if (firstFeature.geometry.type === 'Point') {
              centroid = coords as [number, number];
            }
          }
        }

        if (!centroid) return null;

        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: centroid },
          properties: {
            provider_id: provider.provider_id,
            provider_name: provider.provider_name,
            provider_type: provider.provider_type,
            provider_org: provider.provider_org,
          },
        };
      })
      .filter(Boolean);

    return jsonResponse({ type: 'FeatureCollection', features }, 200, origin);
  } catch (err) {
    console.error('Error getting providers map:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * GET /providers/geocode?address=... - Geocode an address.
 */
async function handleGeocodeRequest(address: string, origin: string | null) {
  if (!address || address.trim().length === 0) {
    return errorResponse('Address parameter is required', 400, origin);
  }

  const result = await geocodeAddress(address);

  if (result.success) {
    return jsonResponse({ success: true, coordinates: result.coordinates }, 200, origin);
  }

  return jsonResponse({ success: false, message: result.message }, 200, origin);
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function getObjectType(value: unknown): string | null {
  const parsed = parseJsonIfString(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = (parsed as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

function matchesEligibilityText(provider: ProviderRecord, needle?: string): boolean {
  if (!needle) return true;
  const haystack = JSON.stringify(parseJsonIfString(provider.eligibility_reqs) ?? '').toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

function matchesProviderFilters(provider: ProviderRecord, filter: ProviderFilter): boolean {
  if (filter.provider_type && provider.provider_type !== filter.provider_type) return false;
  if (filter.routing_type && provider.routing_type !== filter.routing_type) return false;
  if (filter.planning_type && provider.planning_type !== filter.planning_type) return false;
  if (filter.schedule_type && getObjectType(provider.schedule_type) !== filter.schedule_type) return false;
  if (filter.booking_method && getObjectType(provider.booking) !== filter.booking_method) return false;
  if (filter.fare_type && getObjectType(provider.fare) !== filter.fare_type) return false;
  if (filter.provider_org && provider.provider_org !== filter.provider_org) return false;
  if (
    filter.provider_name__contains &&
    !String(provider.provider_name || '').toLowerCase().includes(filter.provider_name__contains.toLowerCase())
  ) {
    return false;
  }
  if (filter.has_service_zone === true && !provider.service_zone) return false;
  if (filter.has_service_zone === false && provider.service_zone) return false;
  if (!matchesEligibilityText(provider, filter.eligibility_req_contains)) return false;
  return true;
}

function isPointInSinglePolygon(lat: number, lon: number, coordinates: number[][][]): boolean {
  const ring = coordinates[0];
  if (!Array.isArray(ring)) return false;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

function isPointInGeometry(lat: number, lon: number, rawGeometry: unknown): boolean {
  const geometry = parseJsonIfString(rawGeometry) as {
    type?: string;
    coordinates?: unknown;
    features?: unknown[];
    geometry?: unknown;
  } | null;

  if (!geometry || typeof geometry !== 'object') return false;

  if (geometry.type === 'FeatureCollection' && Array.isArray(geometry.features)) {
    return geometry.features.some((feature) => isPointInGeometry(lat, lon, feature));
  }

  if (geometry.type === 'Feature' && geometry.geometry) {
    return isPointInGeometry(lat, lon, geometry.geometry);
  }

  if (geometry.type === 'Polygon') {
    return isPointInSinglePolygon(lat, lon, geometry.coordinates as number[][][]);
  }

  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return (geometry.coordinates as number[][][][]).some((polygon) =>
      isPointInSinglePolygon(lat, lon, polygon)
    );
  }

  return false;
}

/**
 * POST /providers/filter - Filter providers by location and criteria.
 */
async function filterProviders(filter: ProviderFilter, origin: string | null) {
  try {
    // Validate required fields
    if (!filter.source_address || !filter.destination_address) {
      return errorResponse('source_address and destination_address are required', 400, origin);
    }

    // Geocode addresses
    const originGeo = await geocodeAddress(filter.source_address);
    const destGeo = await geocodeAddress(filter.destination_address);

    if (!originGeo.success || !destGeo.success) {
      return jsonResponse(
        {
          data: [],
          source_address: filter.source_address,
          destination_address: filter.destination_address,
          origin: null,
          destination: null,
          public_transit: null,
          error: 'Failed to geocode one or both addresses',
          details: {
            source: originGeo.success ? null : originGeo.message,
            destination: destGeo.success ? null : destGeo.message,
          },
        },
        502,
        origin
      );
    }

    const originCoord: GeoCoordinate = {
      lat: originGeo.coordinates!.latitude,
      lon: originGeo.coordinates!.longitude,
    };
    const destCoord: GeoCoordinate = {
      lat: destGeo.coordinates!.latitude,
      lon: destGeo.coordinates!.longitude,
    };

    const rows = await queryRows(
      `SELECT ${PROVIDER_SELECT_FIELDS}
       FROM ${TABLES.PROVIDERS}
       ORDER BY provider_name`
    );

    const normalizedProviders = rows
      .filter((provider) =>
        matchesProviderFilters(provider as ProviderRecord, filter) &&
        isPointInGeometry(originCoord.lat, originCoord.lon, (provider as ProviderRecord).service_zone) &&
        isPointInGeometry(destCoord.lat, destCoord.lon, (provider as ProviderRecord).service_zone)
      )
      .map((provider) => normalizeProvider(provider));

    return jsonResponse(
      {
        data: normalizedProviders,
        source_address: filter.source_address,
        destination_address: filter.destination_address,
        origin: originCoord,
        destination: destCoord,
        public_transit: null,
      },
      200,
      origin
    );
  } catch (err) {
    console.error('Error filtering providers:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * GET /providers/:id/service-zone - Get provider service zone metadata.
 */
async function getProviderServiceZone(providerId: string, origin: string | null) {
  try {
    const row = await queryOne(
      `SELECT provider_id, service_zone FROM ${TABLES.PROVIDERS} WHERE provider_id = $1`,
      [parseInt(providerId, 10)]
    );

    if (!row) {
      return jsonResponse(
        { provider_id: providerId, has_service_zone: false, raw_data: null },
        200,
        origin
      );
    }

    // Parse service_zone if it is a string
    let serviceZone = row.service_zone;
    if (typeof serviceZone === 'string') {
      try {
        serviceZone = JSON.parse(serviceZone);
      } catch {
        console.warn(`Failed to parse service_zone JSON for provider ${providerId}`);
      }
    }

    return jsonResponse(
      {
        provider_id: row.provider_id,
        has_service_zone: serviceZone !== null && serviceZone !== undefined,
        raw_data: serviceZone,
      },
      200,
      origin
    );
  } catch (err) {
    console.error('Error fetching provider service zone:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * PUT /providers/:id - Update a provider by provider_id.
 */
async function updateProvider(providerId: string, updateData: ProviderUpdate, origin: string | null) {
  try {
    const id = parseInt(providerId, 10);
    if (isNaN(id)) {
      return errorResponse('Invalid provider ID', 400, origin);
    }

    // Check if provider exists
    const existing = await queryOne(
      `SELECT provider_id FROM ${TABLES.PROVIDERS} WHERE provider_id = $1`,
      [id]
    );
    if (!existing) {
      return errorResponse(`Provider with id ${providerId} not found`, 404, origin);
    }

    // Build update object, only including non-null fields
    const fieldMapping: Record<keyof ProviderUpdate, { column: string; isJsonb: boolean }> = {
      provider_name: { column: 'provider_name', isJsonb: false },
      provider_type: { column: 'provider_type', isJsonb: false },
      routing_type: { column: 'routing_type', isJsonb: false },
      schedule_type: { column: 'schedule_type', isJsonb: true },
      eligibility_reqs: { column: 'eligibility_reqs', isJsonb: true },
      booking: { column: 'booking', isJsonb: true },
      fare: { column: 'fare', isJsonb: true },
      contacts: { column: 'contacts', isJsonb: true },
      website: { column: 'website', isJsonb: false },
      round_trip_booking: { column: 'round_trip_booking', isJsonb: false },
      investigated: { column: 'investigated', isJsonb: false },
      service_zone: { column: 'service_zone', isJsonb: true },
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const [field, { column, isJsonb }] of Object.entries(fieldMapping)) {
      const value = updateData[field as keyof ProviderUpdate];
      if (value === undefined) continue;

      if (!isJsonb) {
        setClauses.push(`${column} = $${paramIdx++}`);
        params.push(value);
        continue;
      }

      // JSONB field handling
      if (value === null) {
        setClauses.push(`${column} = $${paramIdx++}`);
        params.push(null);
        continue;
      }

      let parsed: unknown = value;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
          // Treat empty string as null (clears the field)
          setClauses.push(`${column} = $${paramIdx++}`);
          params.push(null);
          continue;
        }
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return errorResponse(`Invalid JSON for field '${field}'`, 400, origin);
        }
      }

      // Enforce basic shapes to avoid storing JSONB scalar strings/numbers
      const expectsArray = field === 'eligibility_reqs' || field === 'contacts';
      if (expectsArray) {
        if (parsed !== null && parsed !== undefined && !Array.isArray(parsed)) {
          return errorResponse(`Field '${field}' must be a JSON array`, 400, origin);
        }
      } else {
        if (parsed !== null && parsed !== undefined && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          return errorResponse(`Field '${field}' must be a JSON object`, 400, origin);
        }
      }

      setClauses.push(`${column} = $${paramIdx++}`);
      params.push(JSON.stringify(parsed));
    }

    if (setClauses.length === 0) {
      // No fields to update -- return existing provider
      const row = await queryOne(
        `SELECT ${PROVIDER_SELECT_FIELDS} FROM ${TABLES.PROVIDERS} WHERE provider_id = $1`,
        [id]
      );
      return jsonResponse(normalizeProvider(row as Record<string, unknown>), 200, origin);
    }

    // Add the WHERE param
    params.push(id);
    const updatedRow = await queryOne(
      `UPDATE ${TABLES.PROVIDERS}
       SET ${setClauses.join(', ')}
       WHERE provider_id = $${paramIdx}
       RETURNING ${PROVIDER_SELECT_FIELDS}`,
      params
    );

    if (!updatedRow) {
      return errorResponse('Update failed', 500, origin);
    }

    return jsonResponse(normalizeProvider(updatedRow as Record<string, unknown>), 200, origin);
  } catch (err) {
    console.error('Error updating provider:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  const segments = req.pathSegments;
  // segments[0] is always 'providers'; use segments from index 1 onward
  const sub = segments.slice(1);
  const method = req.method;

  console.log(`[Providers] ${method} ${req.pathname} - sub:`, sub);

  // GET /providers - List all
  if (method === 'GET' && sub.length === 0) {
    return listProviders(req.origin);
  }

  // GET /providers/search?q=...
  if (method === 'GET' && sub[0] === 'search') {
    const q = req.searchParams.get('q');
    if (!q) {
      return errorResponse("Query parameter 'q' is required", 400, req.origin);
    }
    return searchProviders(q, req.origin);
  }

  // GET /providers/map
  if (method === 'GET' && sub[0] === 'map') {
    return getProvidersMap(req.origin);
  }

  // GET /providers/geocode?address=...
  if (method === 'GET' && sub[0] === 'geocode') {
    const address = req.searchParams.get('address');
    if (!address) {
      return errorResponse("Query parameter 'address' is required", 400, req.origin);
    }
    return handleGeocodeRequest(address, req.origin);
  }

  // POST /providers/filter
  if (method === 'POST' && sub[0] === 'filter') {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return errorResponse('Invalid JSON body', 400, req.origin);
    }
    return filterProviders(body as ProviderFilter, req.origin);
  }

  // GET /providers/:id/service-zone
  if (method === 'GET' && sub.length === 2 && sub[1] === 'service-zone') {
    return getProviderServiceZone(sub[0], req.origin);
  }

  // GET /providers/:id
  if (method === 'GET' && sub.length === 1 && sub[0] !== 'search' && sub[0] !== 'map' && sub[0] !== 'geocode') {
    return getProviderById(sub[0], req.origin);
  }

  // PUT /providers/:id
  if (method === 'PUT' && sub.length === 1) {
    const unauthorized = await requireMigrationAdmin(req);
    if (unauthorized) return unauthorized;
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return errorResponse('Invalid JSON body', 400, req.origin);
    }
    return updateProvider(sub[0], body as ProviderUpdate, req.origin);
  }

  // Route not found
  return errorResponse(`Not found: ${method} ${req.pathname}`, 404, req.origin);
});
