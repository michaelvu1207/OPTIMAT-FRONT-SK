/**
 * Tri Delta Transit Lambda Handler
 *
 * Handles Tri Delta Transit historical data endpoints:
 * - GET /tri-delta-transit/trips — List historical trips
 * - GET /tri-delta-transit/routes?mode=driving|transit — Get route overlays
 *
 * Uses PUBLIC schema tables: public.tri_delta_transit and public.transit_driving_driving.
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { queryRows, TABLES } from '../_shared/db.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TriDeltaTrip {
  trip_id: number;
  origin_address: string;
  origin_city: string;
  destination_address: string;
  destination_city: string;
  duration_hours: number;
  origin_latitude: number | null;
  origin_longitude: number | null;
  destination_latitude: number | null;
  destination_longitude: number | null;
  origin_geometry: string | null;
  destination_geometry: string | null;
}

interface TriDeltaRouteOverlay {
  trip_id: number;
  mode: 'driving' | 'transit';
  summary: string | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  polyline: string | null;
  warnings: string[];
}

type RouteMode = 'driving' | 'transit';

// ─── Handler ────────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405, req.origin);
  }

  // Determine sub-route from pathSegments
  // pathSegments: ['tri-delta-transit', 'trips'] or ['tri-delta-transit', 'routes']
  const segments = req.pathSegments;
  const subRoute = segments.find((_, i) => {
    const prev = segments[i - 1];
    return prev === 'tri-delta-transit';
  });

  if (subRoute === 'trips') {
    return await listTriDeltaTrips(req.origin);
  }

  if (subRoute === 'routes') {
    const mode = req.searchParams.get('mode') || 'driving';
    if (mode !== 'driving' && mode !== 'transit') {
      return errorResponse(
        "Invalid mode parameter. Must be 'driving' or 'transit'.",
        400,
        req.origin,
      );
    }
    return await listTriDeltaRouteOverlays(mode as RouteMode, req.origin);
  }

  return errorResponse(`Not found: ${req.method} ${req.pathname}`, 404, req.origin);
});

// ─── Route Handlers ─────────────────────────────────────────────────────────

/**
 * List historical Tri Delta Transit trips.
 */
async function listTriDeltaTrips(origin: string | null) {
  const rows = await queryRows(
    `SELECT
       "Trip ID",
       "Origin Address",
       "Origin City",
       "Destination Address",
       "Destination City",
       "Duration (hours)",
       "Origin Latitude",
       "Origin Longitude",
       "Destination Latitude",
       "Destination Longitude",
       "Origin Geometry",
       "Destination Geometry"
     FROM ${TABLES.TRI_DELTA_TRANSIT}
     ORDER BY "Trip ID"`,
  );

  const trips: TriDeltaTrip[] = rows.map((row) => ({
    trip_id: row['Trip ID'],
    origin_address: row['Origin Address'],
    origin_city: row['Origin City'],
    destination_address: row['Destination Address'],
    destination_city: row['Destination City'],
    duration_hours: row['Duration (hours)'],
    origin_latitude: row['Origin Latitude'],
    origin_longitude: row['Origin Longitude'],
    destination_latitude: row['Destination Latitude'],
    destination_longitude: row['Destination Longitude'],
    origin_geometry: row['Origin Geometry'],
    destination_geometry: row['Destination Geometry'],
  }));

  return jsonResponse(trips, 200, origin);
}

/**
 * List route overlays for Tri Delta trips.
 */
async function listTriDeltaRouteOverlays(
  mode: RouteMode,
  origin: string | null,
) {
  const prefix = mode === 'transit' ? 'transit' : 'driving';

  const rows = await queryRows(
    `SELECT
       trip_id,
       ${prefix}_summary,
       ${prefix}_distance_meters,
       ${prefix}_duration_seconds,
       ${prefix}_polyline,
       ${prefix}_warnings
     FROM ${TABLES.TRANSIT_DRIVING_DRIVING}
     WHERE ${prefix}_polyline IS NOT NULL
     ORDER BY trip_id`,
  );

  const routes: TriDeltaRouteOverlay[] = rows.map((row) => {
    // Parse warnings if it's a string
    let warnings: string[] = [];
    const warningsData = row[`${prefix}_warnings`];
    if (warningsData) {
      if (typeof warningsData === 'string') {
        try {
          warnings = JSON.parse(warningsData);
        } catch {
          warnings = [];
        }
      } else if (Array.isArray(warningsData)) {
        warnings = warningsData;
      }
    }

    return {
      trip_id: row.trip_id,
      mode,
      summary: row[`${prefix}_summary`] || null,
      distance_meters: row[`${prefix}_distance_meters`] || null,
      duration_seconds: row[`${prefix}_duration_seconds`] || null,
      polyline: row[`${prefix}_polyline`] || null,
      warnings,
    };
  });

  return jsonResponse(routes, 200, origin);
}
