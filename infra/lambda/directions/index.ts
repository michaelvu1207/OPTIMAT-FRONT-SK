/**
 * Directions Lambda Function
 *
 * Route directions using Amazon Location Service Routes.
 *
 * Routes:
 *   POST /directions → { success, summary, distance_text, duration_text, polyline, legs, ... }
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { calculateRoute } from '../_shared/location.js';

type TravelMode = 'driving' | 'transit';

interface RouteStep {
  instruction: string | null;
  distance_text: string | null;
  distance_meters: number | null;
  duration_text: string | null;
  duration_seconds: number | null;
  travel_mode: string | null;
  polyline: string | null;
}

interface RouteLeg {
  start_address: string | null;
  end_address: string | null;
  distance_text: string | null;
  distance_meters: number | null;
  duration_text: string | null;
  duration_seconds: number | null;
  steps: RouteStep[];
}

function parseSteps(steps: any[]): RouteStep[] {
  return steps.map((step) => ({
    instruction: step.html_instructions || null,
    distance_text: step.distance?.text || null,
    distance_meters: step.distance?.value ?? null,
    duration_text: step.duration?.text || null,
    duration_seconds: step.duration?.value ?? null,
    travel_mode: step.travel_mode || null,
    polyline: step.polyline?.points || null,
  }));
}

function parseLegs(legs: any[]): RouteLeg[] {
  return legs.map((leg) => ({
    start_address: leg.start_address || null,
    end_address: leg.end_address || null,
    distance_text: leg.distance?.text || null,
    distance_meters: leg.distance?.value ?? null,
    duration_text: leg.duration?.text || null,
    duration_seconds: leg.duration?.value ?? null,
    steps: parseSteps(leg.steps || []),
  }));
}

function aggregateMetric(legs: RouteLeg[], key: 'distance_meters' | 'duration_seconds'): number | null {
  const values = legs.map((leg) => leg[key]).filter((v): v is number => v !== null);
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0);
}

async function getDirections(origin: string, destination: string, mode: TravelMode) {
  try {
    const route = await calculateRoute(origin, destination, mode);
    if (!route) {
      return { success: false as const, error: 'No routes found between the specified locations' };
    }
    return { success: true as const, ...route };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : 'Directions request failed' };
  }
}

export const handler = createHandler(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(`Method ${req.method} not allowed. Use POST.`, 405, req.origin);
  }

  const body = req.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return errorResponse('Request body must be a JSON object', 400, req.origin);
  }

  const { origin: routeOrigin, destination, mode } = body;

  if (!routeOrigin || typeof routeOrigin !== 'string' || routeOrigin.trim().length === 0) {
    return errorResponse("Missing or invalid 'origin' parameter", 400, req.origin);
  }
  if (!destination || typeof destination !== 'string' || (destination as string).trim().length === 0) {
    return errorResponse("Missing or invalid 'destination' parameter", 400, req.origin);
  }

  let validatedMode: TravelMode = 'driving';
  if (mode !== undefined) {
    const m = String(mode).toLowerCase();
    if (m !== 'driving' && m !== 'transit') {
      return errorResponse("Mode must be 'driving' or 'transit'", 400, req.origin);
    }
    validatedMode = m as TravelMode;
  }

  const result = await getDirections(
    (routeOrigin as string).trim(),
    (destination as string).trim(),
    validatedMode
  );

  if (result.success) {
    return jsonResponse(result, 200, req.origin);
  } else {
    let status = 500;
    if (result.error.includes('No routes') || result.error.includes('ZERO_RESULTS') || result.error.includes('NOT_FOUND')) {
      status = 404;
    } else if (result.error.includes('INVALID_REQUEST')) {
      status = 400;
    }
    return jsonResponse(result, status, req.origin);
  }
});
