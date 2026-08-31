/**
 * Trip Records Lambda Handler
 *
 * Handles trip record endpoints:
 * - GET /trip-records/pairs — List trip record pairs
 * - GET /trip-records/pairs-grouped — Get grouped trip pairs
 * - GET /trip-records/stats — Get trip record statistics
 * - POST /trip-records/upload — Upload trip records
 * - GET /trip-records/manifest/pairs?service_date=... — List manifest trip record pairs
 * - GET /trip-records/manifest/pair-summaries — Get manifest summary statistics
 *
 * Uses optimat.demand_response_manifest_review and optimat.trip_record_pairs_raw tables.
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, TABLES } from '../_shared/db.js';
import type { ParsedRequest } from '../_shared/adapter.js';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const region = process.env.AWS_REGION || 'us-west-1';
const s3 = new S3Client({ region });
const MAX_TRIP_UPLOAD_BYTES = 8 * 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ManifestTripRecordPair {
  service_date: string;
  trip_id: string;
  provider_id: number | null;
  route: string | null;
  vehicle: string | null;
  pickup_count: number;
  drop_count: number;
  lyard_time: string | null;
  ryard_time: string | null;
  first_pick_address: string | null;
  first_pick_city: string | null;
  last_drop_address: string | null;
  last_drop_city: string | null;
  outbound_minutes: number | null;
  inbound_minutes: number | null;
  activity_minutes: number | null;
}

interface ManifestTripRecordPairSummary {
  service_date: string;
  pair_count: number;
  average_outbound_minutes: number | null;
  average_inbound_minutes: number | null;
  average_activity_minutes: number | null;
}

interface TripPairRecord {
  trip_id: number;
  pickup_sequence: number;
  drop_sequence: number;
  pick_time: string;
  drop_time: string;
  pickup_address: string;
  pickup_city: string | null;
  drop_address: string;
  drop_city: string | null;
  passengers_on_board: number;
  trip_id_return: number | null;
  return_pick_time: string | null;
  duration_minutes: number;
  return_gap_minutes: number | null;
  outbound_duration_minutes: number | null;
  route_polyline: string | null;
  route_distance_meters: number;
  route_duration_seconds: number;
  route_summary: string | null;
}

interface TripPairLeg {
  trip_id: number;
  pickup_sequence: number;
  drop_sequence: number;
  pick_time: string;
  drop_time: string;
  pickup_address: string;
  pickup_city: string | null;
  drop_address: string;
  drop_city: string | null;
  passengers_on_board: number;
  duration_minutes: number;
  route_polyline: string | null;
  route_distance_meters: number;
  route_duration_seconds: number;
  route_summary: string | null;
}

interface TripPairGroup {
  outbound: TripPairLeg;
  return_leg: TripPairLeg | null;
  gap_minutes: number | null;
  round_trip_duration_minutes: number | null;
  is_round_trip: boolean;
}

interface TripRecordHotspot {
  label: string;
  city: string | null;
  count: number;
}

interface TripRecordHourCount {
  hour: number;
  count: number;
}

interface TripPairStats {
  total_records: number;
  with_return_count: number;
  pct_with_return: number;
  avg_duration_minutes: number;
  median_duration_minutes: number;
  p90_duration_minutes: number;
  avg_return_gap_minutes: number | null;
  earliest_pick_time: string | null;
  latest_drop_time: string | null;
  top_pickup_hotspots: TripRecordHotspot[];
  top_drop_hotspots: TripRecordHotspot[];
  busiest_pick_hours: TripRecordHourCount[];
}

// ─── Pure Computation Helpers ───────────────────────────────────────────────

/**
 * Convert time string to seconds since midnight.
 */
function timeToSeconds(timeStr: string | null): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Calculate time difference in seconds, handling midnight wrap.
 */
function diffSeconds(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null;
  let delta = end - start;
  if (delta < 0) delta += 24 * 3600;
  return delta;
}

/**
 * Convert seconds to minutes, rounded to 2 decimal places.
 */
function secondsToMinutes(seconds: number | null): number | null {
  if (seconds === null) return null;
  return Math.round((seconds / 60) * 100) / 100;
}

/**
 * Calculate percentile of a sorted array.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * p;
  const lower = Math.floor(k);
  const upper = Math.ceil(k);
  if (lower === upper) {
    return Math.round(sorted[lower] * 100) / 100;
  }
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  return Math.round((lowerValue + (upperValue - lowerValue) * (k - lower)) * 100) / 100;
}

/**
 * Split an address string into components.
 */
function splitAddress(address: string | null): { street: string; city: string | null; state: string | null } {
  if (!address) return { street: '', city: null, state: null };
  const parts = address.split(',').map((p) => p.trim());
  if (parts.length >= 3) {
    return { street: parts[0], city: parts[1], state: parts[2] };
  }
  if (parts.length === 2) {
    return { street: parts[0], city: parts[1], state: null };
  }
  return { street: address, city: null, state: null };
}

function hashToIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return modulo === 0 ? 0 : hash % modulo;
}

function applyMockProviderIdsToManifestPairs(
  pairs: ManifestTripRecordPair[],
  providerIds: number[],
): ManifestTripRecordPair[] {
  if (!providerIds.length) return pairs;
  return pairs.map((pair) => {
    const key = `${pair.service_date ?? ''}-${pair.trip_id ?? ''}`;
    const providerId = providerIds[hashToIndex(key, providerIds.length)];
    return { ...pair, provider_id: providerId };
  });
}

function applyMockProviderIdsToTripRows(
  rows: Record<string, unknown>[],
  providerIds: number[],
  fallbackProviderId?: number | null,
): Record<string, unknown>[] {
  if (!providerIds.length) {
    if (fallbackProviderId === null || fallbackProviderId === undefined) return rows;
    return rows.map((row) => ({ ...row, provider_id: fallbackProviderId }));
  }

  const returnTripMap = new Map<number, number>();
  for (const row of rows) {
    const tripIdRaw = row.trip_id;
    const returnTripIdRaw = row.trip_id_return;
    const tripId = tripIdRaw === null || tripIdRaw === undefined ? NaN : Number(tripIdRaw);
    const returnTripId =
      returnTripIdRaw === null || returnTripIdRaw === undefined ? NaN : Number(returnTripIdRaw);
    if (
      Number.isFinite(tripId) &&
      Number.isFinite(returnTripId) &&
      returnTripId > 0 &&
      !returnTripMap.has(returnTripId)
    ) {
      returnTripMap.set(returnTripId, tripId);
    }
  }

  return rows.map((row) => {
    const tripIdRaw = row.trip_id;
    const tripId = tripIdRaw === null || tripIdRaw === undefined ? NaN : Number(tripIdRaw);
    const assignmentTripId = returnTripMap.get(tripId) ?? tripId;
    let providerIndex = 0;
    if (Number.isFinite(assignmentTripId)) {
      providerIndex = Math.abs(assignmentTripId) % providerIds.length;
    } else {
      const key = String(row.trip_id ?? row.trip_id_return ?? '');
      providerIndex = hashToIndex(key, providerIds.length);
    }
    const providerId = providerIds[providerIndex];
    return { ...row, provider_id: providerId };
  });
}

async function fetchProviderIds(): Promise<number[]> {
  try {
    const rows = await queryRows(
      `SELECT provider_id FROM ${TABLES.PROVIDERS}`,
    );
    const ids = rows
      .map((row) => Number(row.provider_id))
      .filter((id) => Number.isFinite(id));
    if (ids.length) return ids;
  } catch (err) {
    console.error('Unexpected error fetching provider ids:', err);
  }
  return [];
}

function dedupeTripRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];

  for (const row of rows) {
    const key = [
      row.trip_id ?? '',
      row.no_pk ?? '',
      row.no_dp ?? '',
      row.pick_time ?? '',
      row.drop_time ?? '',
      row.addr_pk ?? '',
      row.addr_dp ?? '',
      row.trip_id_return ?? '',
    ].join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

// ─── CSV Upload Helpers ─────────────────────────────────────────────────────

const UPLOAD_ALLOWED_COLUMNS = new Set([
  'no_pk', 'no_dp', 'trip_id', 'pick_time', 'addr_pk', 'drop_time', 'addr_dp',
  'no_return', 'psg_on_brd', 'trip_id_return', 'outgo_dura',
  'google_maps_route', 'google_route_distance_m', 'google_route_duration_s',
  'google_route_summary', 'provider_id',
]);

const UPLOAD_NUMERIC_COLUMNS = new Set([
  'no_pk', 'no_dp', 'trip_id', 'no_return', 'psg_on_brd', 'trip_id_return',
  'google_route_distance_m', 'google_route_duration_s', 'provider_id',
]);

const UPLOAD_COLUMN_ALIASES: Record<string, string> = {
  pickup_address: 'addr_pk',
  pickup_addr: 'addr_pk',
  pickup: 'addr_pk',
  drop_address: 'addr_dp',
  drop_addr: 'addr_dp',
  dropoff_address: 'addr_dp',
  passengers_on_board: 'psg_on_brd',
  passengers: 'psg_on_brd',
  return_trip_id: 'trip_id_return',
  return_id: 'trip_id_return',
  outbound_duration: 'outgo_dura',
  duration: 'outgo_dura',
  route_polyline: 'google_maps_route',
  route_distance_meters: 'google_route_distance_m',
  route_distance_m: 'google_route_distance_m',
  route_duration_seconds: 'google_route_duration_s',
  route_duration_s: 'google_route_duration_s',
  route_summary: 'google_route_summary',
  pickup_time: 'pick_time',
  drop_time: 'drop_time',
};

function normalizeUploadHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseUploadRows(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        const nextChar = text[i + 1];
        if (nextChar === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.length > 1 || row[0]?.trim()) {
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  const dataRows = rows.filter((r) => r.some((cell) => cell.trim() !== ''));

  return { headers, rows: dataRows };
}

function coerceUploadValue(column: string, value: string): string | number | null {
  if (value === '') return null;
  if (UPLOAD_NUMERIC_COLUMNS.has(column)) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return value;
}

// ─── Parse Route ────────────────────────────────────────────────────────────

function parseRoute(segments: string[]): string[] {
  const idx = segments.indexOf('trip-records');
  if (idx !== -1) {
    return segments.slice(idx + 1);
  }
  return segments;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  const subSegments = parseRoute(req.pathSegments);
  const providerIdParam = req.searchParams.get('provider_id');
  const providerId = providerIdParam ? Number(providerIdParam) : null;
  const mockParam = req.searchParams.get('mock');
  const useMockProviders = mockParam === 'true' || mockParam === '1';
  const mockProviderIds = useMockProviders ? await fetchProviderIds() : null;

  if (providerIdParam && Number.isNaN(providerId)) {
    return errorResponse('Invalid provider_id', 400, req.origin);
  }

  console.log(`[TripRecords] ${req.method} ${req.pathname} - segments:`, subSegments);

  // GET /trip-records/pairs
  if (req.method === 'GET' && subSegments[0] === 'pairs' && subSegments.length === 1) {
    const records = await listTripRecordPairs(req.origin, providerId, mockProviderIds);
    return jsonResponse(records, 200, req.origin);
  }

  // GET /trip-records/pairs-grouped
  if (req.method === 'GET' && subSegments[0] === 'pairs-grouped' && subSegments.length === 1) {
    return await listTripRecordPairsGrouped(req.origin, providerId, mockProviderIds);
  }

  // GET /trip-records/stats
  if (req.method === 'GET' && subSegments[0] === 'stats' && subSegments.length === 1) {
    return await getTripRecordStats(req.origin, providerId, mockProviderIds);
  }

  // POST /trip-records/upload
  if (req.method === 'POST' && subSegments[0] === 'upload' && subSegments.length === 1) {
    return await uploadTripRecords(req, req.origin);
  }

  // GET /trip-records/manifest/pairs
  if (req.method === 'GET' && subSegments[0] === 'manifest' && subSegments[1] === 'pairs' && subSegments.length === 2) {
    const serviceDate = req.searchParams.get('service_date');
    return await listManifestTripRecordPairs(serviceDate, providerId, req.origin, mockProviderIds);
  }

  // GET /trip-records/manifest/pair-summaries
  if (req.method === 'GET' && subSegments[0] === 'manifest' && subSegments[1] === 'pair-summaries' && subSegments.length === 2) {
    return await listManifestTripRecordPairSummaries(req.origin, providerId, mockProviderIds);
  }

  return errorResponse(`Not found: ${req.method} ${req.pathname}`, 404, req.origin);
});

// ─── API Handlers ───────────────────────────────────────────────────────────

/**
 * List manifest trip record pairs from demand_response_manifest_review table.
 */
async function listManifestTripRecordPairs(
  serviceDate: string | null,
  providerId: number | null,
  origin: string | null,
  mockProviderIds: number[] | null,
) {
  // Try RPC function first
  try {
    const params: unknown[] = [];
    let rpcSql = `SELECT * FROM ${TABLES.DEMAND_RESPONSE_MANIFEST_REVIEW} WHERE trip_id IS NOT NULL`;

    if (serviceDate) {
      rpcSql += ` AND service_date = $${params.length + 1}`;
      params.push(serviceDate);
    }
    if (providerId !== null && providerId !== undefined && !mockProviderIds) {
      rpcSql += ` AND provider_id = $${params.length + 1}`;
      params.push(providerId);
    }

    rpcSql += ' ORDER BY service_date, trip_id, row_number';

    const rawData = await queryRows(rpcSql, params);

    // Process raw data into pairs
    let pairs = processRawTripRecords(rawData);
    if (mockProviderIds && mockProviderIds.length) {
      pairs = applyMockProviderIdsToManifestPairs(pairs, mockProviderIds);
    }

    const filteredPairs = providerId !== null && providerId !== undefined
      ? pairs.filter((pair) => pair.provider_id === providerId)
      : pairs;

    return jsonResponse(filteredPairs, 200, origin);
  } catch (err) {
    console.error('Unexpected error in listManifestTripRecordPairs:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * Process raw trip records into pairs.
 */
function processRawTripRecords(records: Record<string, unknown>[]): ManifestTripRecordPair[] {
  // Group records by (service_date, trip_id)
  const grouped = new Map<string, Record<string, unknown>[]>();

  for (const record of records) {
    const tripId = record.trip_id;
    const serviceDate = record.service_date;
    if (!tripId || !serviceDate) continue;

    const key = `${serviceDate}|${tripId}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(record);
  }

  const pairs: ManifestTripRecordPair[] = [];

  for (const [key, rows] of grouped) {
    const [serviceDateStr, tripId] = key.split('|');

    // Sort by row_number
    rows.sort((a, b) => ((a.row_number as number) || 0) - ((b.row_number as number) || 0));

    // Find LYARD and RYARD
    const lyard = rows.find((r) => r.stop_type === 'LYARD');
    const ryard = [...rows].reverse().find((r) => r.stop_type === 'RYARD');

    if (!lyard || !ryard) continue;

    // Get pickup and drop rows
    const pickupRows = rows.filter((r) => r.stop_type === 'PICK');
    const dropRows = rows.filter((r) => r.stop_type === 'DROP');

    // Skip if no service stops
    if (pickupRows.length === 0 && dropRows.length === 0) continue;

    const firstPick = pickupRows[0];
    const lastDrop = dropRows[dropRows.length - 1];

    // Get provider/route/vehicle from first available
    const providerIdVal = rows.find((r) => r.provider_id)?.provider_id as number | null;
    const route = (rows.find((r) => r.route)?.route as string) || null;
    const vehicle = (rows.find((r) => r.vehicle)?.vehicle as string) || null;

    // Calculate times
    const lyardTime = (lyard.departure_time || lyard.arrival_time) as string | null;
    const ryardTime = (ryard.arrival_time || ryard.departure_time) as string | null;

    // Calculate first service stop (excluding LYARD/RYARD)
    const firstService = rows.find((r) => r.stop_type !== 'LYARD' && r.stop_type !== 'RYARD');
    const lastService = [...rows].reverse().find((r) => r.stop_type !== 'LYARD' && r.stop_type !== 'RYARD');

    // Calculate outbound/inbound/activity times
    const lyardEnd = timeToSeconds((lyard.departure_time || lyard.arrival_time) as string);
    const firstServiceStart = timeToSeconds(
      (firstService?.arrival_time || firstService?.departure_time) as string,
    );
    const lastServiceEnd = timeToSeconds(
      (lastService?.departure_time || lastService?.arrival_time) as string,
    );
    const ryardStart = timeToSeconds((ryard.arrival_time || ryard.departure_time) as string);

    const outboundMinutes = secondsToMinutes(diffSeconds(lyardEnd, firstServiceStart));
    const inboundMinutes = secondsToMinutes(diffSeconds(lastServiceEnd, ryardStart));

    // Activity time from first pick to last drop
    const activityStartRow = firstPick || firstService;
    const activityEndRow = lastDrop || lastService;
    const activityStart = timeToSeconds(
      (activityStartRow?.departure_time || activityStartRow?.arrival_time) as string,
    );
    const activityEnd = timeToSeconds(
      (activityEndRow?.arrival_time || activityEndRow?.departure_time) as string,
    );
    const activityMinutes = secondsToMinutes(diffSeconds(activityStart, activityEnd));

    pairs.push({
      service_date: serviceDateStr,
      trip_id: tripId,
      provider_id: providerIdVal,
      route,
      vehicle,
      pickup_count: pickupRows.length,
      drop_count: dropRows.length,
      lyard_time: lyardTime,
      ryard_time: ryardTime,
      first_pick_address: (firstPick?.address1 as string) || null,
      first_pick_city: (firstPick?.city as string) || null,
      last_drop_address: (lastDrop?.address1 as string) || null,
      last_drop_city: (lastDrop?.city as string) || null,
      outbound_minutes: outboundMinutes,
      inbound_minutes: inboundMinutes,
      activity_minutes: activityMinutes,
    });
  }

  // Sort by service_date, trip_id
  pairs.sort((a, b) => {
    const dateCompare = a.service_date.localeCompare(b.service_date);
    if (dateCompare !== 0) return dateCompare;
    return a.trip_id.localeCompare(b.trip_id);
  });

  return pairs;
}

/**
 * Get daily summary statistics for manifest trip record pairs.
 */
async function listManifestTripRecordPairSummaries(
  origin: string | null,
  providerId: number | null,
  mockProviderIds: number[] | null,
) {
  try {
    const providerFilter = providerId !== null && providerId !== undefined && !mockProviderIds
      ? 'AND provider_id = $1'
      : '';
    const params = providerFilter ? [providerId] : [];
    const summaries = await queryRows<ManifestTripRecordPairSummary>(`
      WITH grouped AS (
        SELECT service_date,
               trip_id,
               bool_or(stop_type = 'LYARD') AS has_lyard,
               bool_or(stop_type = 'RYARD') AS has_ryard,
               count(*) FILTER (WHERE stop_type = 'PICK') AS pickup_count,
               count(*) FILTER (WHERE stop_type = 'DROP') AS drop_count,
               (array_agg(coalesce(departure_time, arrival_time) ORDER BY row_number)
                 FILTER (WHERE stop_type = 'LYARD'))[1] AS lyard_end,
               (array_agg(coalesce(arrival_time, departure_time) ORDER BY row_number DESC)
                 FILTER (WHERE stop_type = 'RYARD'))[1] AS ryard_start,
               (array_agg(coalesce(arrival_time, departure_time) ORDER BY row_number)
                 FILTER (WHERE stop_type NOT IN ('LYARD', 'RYARD')))[1] AS first_service_start,
               (array_agg(coalesce(departure_time, arrival_time) ORDER BY row_number DESC)
                 FILTER (WHERE stop_type NOT IN ('LYARD', 'RYARD')))[1] AS last_service_end,
               coalesce(
                 (array_agg(coalesce(departure_time, arrival_time) ORDER BY row_number)
                   FILTER (WHERE stop_type = 'PICK'))[1],
                 (array_agg(coalesce(departure_time, arrival_time) ORDER BY row_number)
                   FILTER (WHERE stop_type NOT IN ('LYARD', 'RYARD')))[1]
               ) AS activity_start,
               coalesce(
                 (array_agg(coalesce(arrival_time, departure_time) ORDER BY row_number DESC)
                   FILTER (WHERE stop_type = 'DROP'))[1],
                 (array_agg(coalesce(arrival_time, departure_time) ORDER BY row_number DESC)
                   FILTER (WHERE stop_type NOT IN ('LYARD', 'RYARD')))[1]
               ) AS activity_end
        FROM ${TABLES.DEMAND_RESPONSE_MANIFEST_REVIEW}
        WHERE trip_id IS NOT NULL ${providerFilter}
        GROUP BY service_date, trip_id
      ), pairs AS (
        SELECT service_date,
               extract(epoch FROM CASE WHEN first_service_start >= lyard_end
                 THEN first_service_start - lyard_end
                 ELSE first_service_start - lyard_end + interval '24 hours' END) / 60.0 AS outbound_minutes,
               extract(epoch FROM CASE WHEN ryard_start >= last_service_end
                 THEN ryard_start - last_service_end
                 ELSE ryard_start - last_service_end + interval '24 hours' END) / 60.0 AS inbound_minutes,
               extract(epoch FROM CASE WHEN activity_end >= activity_start
                 THEN activity_end - activity_start
                 ELSE activity_end - activity_start + interval '24 hours' END) / 60.0 AS activity_minutes
        FROM grouped
        WHERE has_lyard AND has_ryard AND (pickup_count > 0 OR drop_count > 0)
      )
      SELECT service_date::text,
             count(*)::int AS pair_count,
             round(avg(outbound_minutes)::numeric, 2)::double precision AS average_outbound_minutes,
             round(avg(inbound_minutes)::numeric, 2)::double precision AS average_inbound_minutes,
             round(avg(activity_minutes)::numeric, 2)::double precision AS average_activity_minutes
      FROM pairs
      GROUP BY service_date
      ORDER BY service_date
    `, params);
    return jsonResponse(summaries, 200, origin);
  } catch (err) {
    console.error('Unexpected error in listManifestTripRecordPairSummaries:', err);
    return errorResponse('Internal server error', 500, origin);
  }
}

/**
 * Store a provider CSV in the private intake bucket for asynchronous processing.
 *
 * This endpoint intentionally does not write provider-supplied rows directly into
 * application tables. A later, controlled importer can validate and process the
 * immutable source file.
 */
async function uploadTripRecords(req: ParsedRequest, origin: string | null) {
  const payload = req.body as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') {
    return errorResponse('Invalid JSON payload', 400, origin);
  }

  const recordsText = typeof payload.records === 'string' ? payload.records : '';
  if (!recordsText.trim()) {
    return errorResponse('Trip records payload is required', 400, origin);
  }

  const sizeBytes = Buffer.byteLength(recordsText, 'utf8');
  if (sizeBytes > MAX_TRIP_UPLOAD_BYTES) {
    return errorResponse('Trip data file must be 8 MB or smaller', 413, origin);
  }

  const filenameRaw = typeof payload.filename === 'string' ? payload.filename.trim() : '';
  if (!filenameRaw.toLowerCase().endsWith('.csv')) {
    return errorResponse('Trip data file must use the .csv extension', 400, origin);
  }

  const providerIdRaw = payload.provider_id;
  if (providerIdRaw === undefined || providerIdRaw === null || String(providerIdRaw).trim() === '') {
    return errorResponse('Provider is required', 400, origin);
  }
  const providerId = Number(providerIdRaw);
  if (!Number.isInteger(providerId) || providerId <= 0) {
    return errorResponse('Invalid provider_id', 400, origin);
  }

  const providerRows = await queryRows<{ provider_id: number }>(
    `SELECT provider_id FROM ${TABLES.PROVIDERS} WHERE provider_id = $1 LIMIT 1`,
    [providerId],
  );
  if (providerRows.length === 0) {
    return errorResponse('Provider was not found', 404, origin);
  }

  const { headers, rows } = parseUploadRows(recordsText);
  if (headers.length === 0) {
    return errorResponse('Upload must include a header row', 400, origin);
  }
  if (rows.length === 0) {
    return errorResponse('Upload must include at least one data row', 400, origin);
  }

  const bucket = process.env.TRIP_UPLOAD_BUCKET;
  if (!bucket) {
    return errorResponse('Trip upload storage is not configured', 500, origin);
  }

  const uploadId = randomUUID();
  const now = new Date();
  const safeFilename = filenameRaw
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-120) || 'trip-records.csv';
  const datePath = now.toISOString().slice(0, 10).replaceAll('-', '/');
  const objectKey = `incoming/provider-${providerId}/${datePath}/${uploadId}-${safeFilename}`;

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: Buffer.from(recordsText, 'utf8'),
    ContentType: 'text/csv; charset=utf-8',
    Metadata: {
      provider_id: String(providerId),
      upload_id: uploadId,
      row_count: String(rows.length),
    },
  }));

  return jsonResponse(
    {
      upload_id: uploadId,
      filename: filenameRaw,
      row_count: rows.length,
      size_bytes: sizeBytes,
      status: 'received',
    },
    201,
    origin,
  );
}

/**
 * Get trip records from trip_record_pairs_raw table.
 */
async function listTripRecordPairs(
  origin: string | null,
  providerId: number | null,
  mockProviderIds: number[] | null,
): Promise<TripPairRecord[]> {
  const data = await queryRows(
    `SELECT * FROM ${TABLES.TRIP_RECORD_PAIRS_RAW} ORDER BY pick_time`,
  );

  if (data.length === 0) {
    return [];
  }

  let rows: Record<string, unknown>[] = dedupeTripRows(data);
  if (mockProviderIds) {
    rows = applyMockProviderIdsToTripRows(rows, mockProviderIds, providerId);
  }

  if (providerId !== null && providerId !== undefined) {
    rows = rows.filter((row) => Number(row.provider_id) === providerId);
  }

  // Build lookup for return trip pick times
  const pickLookup = new Map<number, string>();
  for (const row of rows) {
    if (row.trip_id !== null) {
      pickLookup.set(Number(row.trip_id), row.pick_time as string);
    }
  }

  // Process records
  const records: TripPairRecord[] = rows.map((row) => {
    const pickSeconds = timeToSeconds(row.pick_time as string);
    const dropSeconds = timeToSeconds(row.drop_time as string);
    const durationMinutes = secondsToMinutes(diffSeconds(pickSeconds, dropSeconds)) || 0;

    let returnPickTime: string | null = null;
    let returnGapMinutes: number | null = null;
    const tripIdReturn = row.trip_id_return as number | null;
    if (tripIdReturn !== null && tripIdReturn >= 0) {
      returnPickTime = pickLookup.get(Number(tripIdReturn)) || null;
      if (returnPickTime) {
        returnGapMinutes = secondsToMinutes(
          diffSeconds(dropSeconds, timeToSeconds(returnPickTime)),
        );
      }
    }

    const { street: pickupAddress, city: pickupCity } = splitAddress(row.addr_pk as string);
    const { street: dropAddress, city: dropCity } = splitAddress(row.addr_dp as string);

    // Parse outbound duration from interval if present
    let outboundDurationMinutes: number | null = null;
    if (row.outgo_dura) {
      const parts = String(row.outgo_dura).split(':');
      if (parts.length >= 2) {
        const h = parseInt(parts[0], 10) || 0;
        const m = parseInt(parts[1], 10) || 0;
        const s = parts.length > 2 ? parseInt(parts[2], 10) || 0 : 0;
        outboundDurationMinutes = Math.round((h * 60 + m + s / 60) * 100) / 100;
      }
    }

    return {
      trip_id: Number(row.trip_id),
      pickup_sequence: Number(row.no_pk),
      drop_sequence: Number(row.no_dp),
      pick_time: row.pick_time as string,
      drop_time: row.drop_time as string,
      pickup_address: pickupAddress,
      pickup_city: pickupCity,
      drop_address: dropAddress,
      drop_city: dropCity,
      passengers_on_board: Number(row.psg_on_brd),
      trip_id_return: tripIdReturn !== null && tripIdReturn >= 0 ? Number(tripIdReturn) : null,
      return_pick_time: returnPickTime,
      duration_minutes: durationMinutes,
      return_gap_minutes: returnGapMinutes,
      outbound_duration_minutes: outboundDurationMinutes,
      route_polyline: (row.google_maps_route as string) || null,
      route_distance_meters: (row.google_route_distance_m as number) || 0,
      route_duration_seconds: (row.google_route_duration_s as number) || 0,
      route_summary: (row.google_route_summary as string) || null,
    };
  });

  return records;
}

/**
 * Get grouped trip pairs with outbound and return legs.
 */
async function listTripRecordPairsGrouped(
  origin: string | null,
  providerId: number | null,
  mockProviderIds: number[] | null,
) {
  const data = await queryRows(
    `SELECT * FROM ${TABLES.TRIP_RECORD_PAIRS_RAW} ORDER BY pick_time`,
  );

  if (data.length === 0) {
    return jsonResponse([], 200, origin);
  }

  let rows: Record<string, unknown>[] = dedupeTripRows(data);
  if (mockProviderIds) {
    rows = applyMockProviderIdsToTripRows(rows, mockProviderIds, providerId);
  }

  if (providerId !== null && providerId !== undefined) {
    rows = rows.filter((row) => Number(row.provider_id) === providerId);
  }

  // Build lookup by trip_id
  const tripLookup = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (row.trip_id !== null) {
      tripLookup.set(Number(row.trip_id), row);
    }
  }

  // Track which trip IDs are used as return legs
  const usedAsReturn = new Set<number>();
  for (const row of rows) {
    const tripIdReturn = row.trip_id_return as number | null;
    if (tripIdReturn !== null && tripIdReturn > 0) {
      usedAsReturn.add(Number(tripIdReturn));
    }
  }

  // Build grouped pairs
  const groupedPairs: TripPairGroup[] = [];

  for (const row of rows) {
    const tripId = Number(row.trip_id);

    // Skip if this trip is used as a return leg
    if (usedAsReturn.has(tripId)) {
      continue;
    }

    // Build outbound leg
    const pickSeconds = timeToSeconds(row.pick_time as string);
    const dropSeconds = timeToSeconds(row.drop_time as string);
    const durationMinutes = secondsToMinutes(diffSeconds(pickSeconds, dropSeconds)) || 0;

    const { street: pickupAddress, city: pickupCity } = splitAddress(row.addr_pk as string);
    const { street: dropAddress, city: dropCity } = splitAddress(row.addr_dp as string);

    const outboundLeg: TripPairLeg = {
      trip_id: tripId,
      pickup_sequence: Number(row.no_pk),
      drop_sequence: Number(row.no_dp),
      pick_time: row.pick_time as string,
      drop_time: row.drop_time as string,
      pickup_address: pickupAddress,
      pickup_city: pickupCity,
      drop_address: dropAddress,
      drop_city: dropCity,
      passengers_on_board: Number(row.psg_on_brd),
      duration_minutes: durationMinutes,
      route_polyline: (row.google_maps_route as string) || null,
      route_distance_meters: (row.google_route_distance_m as number) || 0,
      route_duration_seconds: (row.google_route_duration_s as number) || 0,
      route_summary: (row.google_route_summary as string) || null,
    };

    // Check for return leg
    let returnLeg: TripPairLeg | null = null;
    let gapMinutes: number | null = null;
    let roundTripDuration: number | null = null;
    let isRoundTrip = false;

    const tripIdReturn = row.trip_id_return as number | null;
    if (tripIdReturn !== null && tripIdReturn > 0) {
      const returnRow = tripLookup.get(Number(tripIdReturn));
      if (returnRow) {
        isRoundTrip = true;

        const returnPickSeconds = timeToSeconds(returnRow.pick_time as string);
        const returnDropSeconds = timeToSeconds(returnRow.drop_time as string);
        const returnDuration = secondsToMinutes(diffSeconds(returnPickSeconds, returnDropSeconds)) || 0;

        const { street: returnPickupAddr, city: returnPickupCity } = splitAddress(returnRow.addr_pk as string);
        const { street: returnDropAddr, city: returnDropCity } = splitAddress(returnRow.addr_dp as string);

        returnLeg = {
          trip_id: Number(returnRow.trip_id),
          pickup_sequence: Number(returnRow.no_pk),
          drop_sequence: Number(returnRow.no_dp),
          pick_time: returnRow.pick_time as string,
          drop_time: returnRow.drop_time as string,
          pickup_address: returnPickupAddr,
          pickup_city: returnPickupCity,
          drop_address: returnDropAddr,
          drop_city: returnDropCity,
          passengers_on_board: Number(returnRow.psg_on_brd),
          duration_minutes: returnDuration,
          route_polyline: (returnRow.google_maps_route as string) || null,
          route_distance_meters: (returnRow.google_route_distance_m as number) || 0,
          route_duration_seconds: (returnRow.google_route_duration_s as number) || 0,
          route_summary: (returnRow.google_route_summary as string) || null,
        };

        // Calculate gap between outbound drop and return pickup
        gapMinutes = secondsToMinutes(diffSeconds(dropSeconds, returnPickSeconds));

        // Calculate round trip duration (outbound pickup to return drop)
        roundTripDuration = secondsToMinutes(diffSeconds(pickSeconds, returnDropSeconds));
      }
    }

    groupedPairs.push({
      outbound: outboundLeg,
      return_leg: returnLeg,
      gap_minutes: gapMinutes,
      round_trip_duration_minutes: roundTripDuration,
      is_round_trip: isRoundTrip,
    });
  }

  return jsonResponse(groupedPairs, 200, origin);
}

/**
 * Get summary statistics for trip records.
 */
async function getTripRecordStats(
  origin: string | null,
  providerId: number | null,
  mockProviderIds: number[] | null,
) {
  // Get all trip records
  const records = await listTripRecordPairs(origin, providerId, mockProviderIds);

  if (!Array.isArray(records) || records.length === 0) {
    return jsonResponse(
      {
        total_records: 0,
        with_return_count: 0,
        pct_with_return: 0,
        avg_duration_minutes: 0,
        median_duration_minutes: 0,
        p90_duration_minutes: 0,
        avg_return_gap_minutes: null,
        earliest_pick_time: null,
        latest_drop_time: null,
        top_pickup_hotspots: [],
        top_drop_hotspots: [],
        busiest_pick_hours: [],
      },
      200,
      origin,
    );
  }

  // Calculate statistics
  const durations = records
    .map((r) => r.duration_minutes)
    .filter((d): d is number => d !== null);
  const withReturn = records.filter((r) => r.trip_id_return !== null);
  const returnGaps = records
    .map((r) => r.return_gap_minutes)
    .filter((g): g is number => g !== null);

  // Calculate hotspots
  const pickupHotspots = new Map<string, { city: string | null; count: number }>();
  const dropHotspots = new Map<string, { city: string | null; count: number }>();
  const pickHours = new Map<number, number>();

  for (const record of records) {
    // Pickup hotspots
    const pickupKey = record.pickup_address;
    if (pickupHotspots.has(pickupKey)) {
      pickupHotspots.get(pickupKey)!.count++;
    } else {
      pickupHotspots.set(pickupKey, { city: record.pickup_city, count: 1 });
    }

    // Drop hotspots
    const dropKey = record.drop_address;
    if (dropHotspots.has(dropKey)) {
      dropHotspots.get(dropKey)!.count++;
    } else {
      dropHotspots.set(dropKey, { city: record.drop_city, count: 1 });
    }

    // Pickup hours
    if (record.pick_time) {
      const hour = parseInt(record.pick_time.split(':')[0], 10);
      if (!isNaN(hour)) {
        pickHours.set(hour, (pickHours.get(hour) || 0) + 1);
      }
    }
  }

  // Sort hotspots by count
  const topPickupHotspots: TripRecordHotspot[] = Array.from(pickupHotspots.entries())
    .map(([label, data]) => ({ label, city: data.city, count: data.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const topDropHotspots: TripRecordHotspot[] = Array.from(dropHotspots.entries())
    .map(([label, data]) => ({ label, city: data.city, count: data.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Sort hours by count (descending), then hour (ascending)
  const busiestPickHours: TripRecordHourCount[] = Array.from(pickHours.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count || a.hour - b.hour);

  // Calculate averages
  const avgDuration =
    durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 100) / 100
      : 0;
  const avgReturnGap =
    returnGaps.length > 0
      ? Math.round((returnGaps.reduce((a, b) => a + b, 0) / returnGaps.length) * 100) / 100
      : null;

  // Get earliest/latest times
  const pickTimes = records.map((r) => r.pick_time).filter(Boolean).sort();
  const dropTimes = records.map((r) => r.drop_time).filter(Boolean).sort();

  const stats: TripPairStats = {
    total_records: records.length,
    with_return_count: withReturn.length,
    pct_with_return: Math.round((withReturn.length / records.length) * 1000) / 10,
    avg_duration_minutes: avgDuration,
    median_duration_minutes: percentile(durations, 0.5) || 0,
    p90_duration_minutes: percentile(durations, 0.9) || 0,
    avg_return_gap_minutes: avgReturnGap,
    earliest_pick_time: pickTimes[0] || null,
    latest_drop_time: dropTimes[dropTimes.length - 1] || null,
    top_pickup_hotspots: topPickupHotspots,
    top_drop_hotspots: topDropHotspots,
    busiest_pick_hours: busiestPickHours,
  };

  return jsonResponse(stats, 200, origin);
}
