/**
 * Trip Records Edge Function
 *
 * Handles trip record endpoints:
 * - GET /trip-records/pairs - List trip record pairs
 * - GET /trip-records/pairs-grouped - Get grouped trip pairs
 * - GET /trip-records/stats - Get trip record statistics
 * - POST /trip-records/upload - Upload trip records
 * - GET /trip-records/manifest/pairs - List manifest trip record pairs
 * - GET /trip-records/manifest/pair-summaries - Get manifest summary statistics
 *
 * Uses optimat.demand_response_manifest_review and optimat.trip_record_pairs_raw tables.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  errorResponse,
  handleCorsPreflightRequest,
  jsonResponse,
} from "../_shared/cors.ts";
import { requireMigrationAdmin } from "../_shared/admin.ts";
import { createOptimatClient, TABLES } from "../_shared/supabase.ts";

// Type definitions

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

// Helper functions

/**
 * Convert time string to seconds since midnight.
 */
function timeToSeconds(timeStr: string | null): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(":");
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
  return Math.round(
    (lowerValue + (upperValue - lowerValue) * (k - lower)) * 100,
  ) / 100;
}

/**
 * Split an address string into components.
 */
function splitAddress(
  address: string | null,
): { street: string; city: string | null; state: string | null } {
  if (!address) return { street: "", city: null, state: null };
  const parts = address.split(",").map((p) => p.trim());
  if (parts.length >= 3) {
    return { street: parts[0], city: parts[1], state: parts[2] };
  }
  if (parts.length === 2) {
    return { street: parts[0], city: parts[1], state: null };
  }
  return { street: address, city: null, state: null };
}

/**
 * Parse route info from URL path.
 */
function parseRoute(pathname: string): { segments: string[] } {
  const cleanPath = pathname.replace(/^\/trip-records\/?/, "").replace(
    /\/$/,
    "",
  );
  const segments = cleanPath.split("/").filter(Boolean);
  return { segments };
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
    const key = `${pair.service_date ?? ""}-${pair.trip_id ?? ""}`;
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
    if (fallbackProviderId === null || fallbackProviderId === undefined) {
      return rows;
    }
    return rows.map((row) => ({ ...row, provider_id: fallbackProviderId }));
  }

  const returnTripMap = new Map<number, number>();
  for (const row of rows) {
    const tripIdRaw = row.trip_id;
    const returnTripIdRaw = row.trip_id_return;
    const tripId = tripIdRaw === null || tripIdRaw === undefined
      ? NaN
      : Number(tripIdRaw);
    const returnTripId =
      returnTripIdRaw === null || returnTripIdRaw === undefined
        ? NaN
        : Number(returnTripIdRaw);
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
    const tripId = tripIdRaw === null || tripIdRaw === undefined
      ? NaN
      : Number(tripIdRaw);
    const assignmentTripId = returnTripMap.get(tripId) ?? tripId;
    let providerIndex = 0;
    if (Number.isFinite(assignmentTripId)) {
      providerIndex = Math.abs(assignmentTripId) % providerIds.length;
    } else {
      const key = String(row.trip_id ?? row.trip_id_return ?? "");
      providerIndex = hashToIndex(key, providerIds.length);
    }
    const providerId = providerIds[providerIndex];
    return { ...row, provider_id: providerId };
  });
}

async function fetchProviderIds(): Promise<number[]> {
  try {
    const supabase = createOptimatClient();
    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select("provider_id");

    if (error) {
      console.error("Error fetching provider ids:", error);
    }

    const ids = (data || [])
      .map((row) => Number(row.provider_id))
      .filter((id) => Number.isFinite(id));
    if (ids.length) {
      return ids;
    }
  } catch (err) {
    console.error("Unexpected error fetching provider ids:", err);
  }

  return [];
}

function dedupeTripRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];

  for (const row of rows) {
    const key = [
      row.trip_id ?? "",
      row.no_pk ?? "",
      row.no_dp ?? "",
      row.pick_time ?? "",
      row.drop_time ?? "",
      row.addr_pk ?? "",
      row.addr_dp ?? "",
      row.trip_id_return ?? "",
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

const UPLOAD_ALLOWED_COLUMNS = new Set([
  "no_pk",
  "no_dp",
  "trip_id",
  "pick_time",
  "addr_pk",
  "drop_time",
  "addr_dp",
  "no_return",
  "psg_on_brd",
  "trip_id_return",
  "outgo_dura",
  "google_maps_route",
  "google_route_distance_m",
  "google_route_duration_s",
  "google_route_summary",
  "provider_id",
]);

const UPLOAD_NUMERIC_COLUMNS = new Set([
  "no_pk",
  "no_dp",
  "trip_id",
  "no_return",
  "psg_on_brd",
  "trip_id_return",
  "google_route_distance_m",
  "google_route_duration_s",
  "provider_id",
]);

const UPLOAD_COLUMN_ALIASES: Record<string, string> = {
  pickup_address: "addr_pk",
  pickup_addr: "addr_pk",
  pickup: "addr_pk",
  drop_address: "addr_dp",
  drop_addr: "addr_dp",
  dropoff_address: "addr_dp",
  passengers_on_board: "psg_on_brd",
  passengers: "psg_on_brd",
  return_trip_id: "trip_id_return",
  return_id: "trip_id_return",
  outbound_duration: "outgo_dura",
  duration: "outgo_dura",
  route_polyline: "google_maps_route",
  route_distance_meters: "google_route_distance_m",
  route_distance_m: "google_route_distance_m",
  route_duration_seconds: "google_route_duration_s",
  route_duration_s: "google_route_duration_s",
  route_summary: "google_route_summary",
  pickup_time: "pick_time",
  drop_time: "drop_time",
};

function normalizeUploadHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseUploadRows(
  text: string,
): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
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
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.length > 1 || row[0]?.trim()) {
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  const dataRows = rows.filter((r) => r.some((cell) => cell.trim() !== ""));

  return { headers, rows: dataRows };
}

function coerceUploadValue(
  column: string,
  value: string,
): string | number | null {
  if (value === "") return null;
  if (UPLOAD_NUMERIC_COLUMNS.has(column)) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return value;
}

// API Handlers

/**
 * List trip record pairs from demand_response_manifest_review table.
 */
async function listManifestTripRecordPairs(
  serviceDate: string | null,
  providerId?: number | null,
  origin?: string | null,
  mockProviderIds?: number[] | null,
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    // First try RPC function
    const rpcParams: Record<string, unknown> = {};
    if (serviceDate) {
      rpcParams.p_service_date = serviceDate;
    }

    const { data, error } = await supabase.rpc(
      "get_trip_record_pairs",
      rpcParams,
    );

    if (error) {
      // Fall back to direct query if RPC doesn't exist
      // Check both error code and message since Supabase/PostgREST may format errors differently
      const isRpcNotFound = error.code === "42883" ||
        (error.message &&
          error.message.includes("Could not find the function"));

      if (isRpcNotFound) {
        let query = supabase
          .from("demand_response_manifest_review")
          .select("*")
          .not("trip_id", "is", null);

        if (serviceDate) {
          query = query.eq("service_date", serviceDate);
        }
        if (providerId !== null && providerId !== undefined) {
          query = query.eq("provider_id", providerId);
        }

        const { data: rawData, error: queryError } = await query.order(
          "service_date",
        ).order("trip_id").order("row_number");

        if (queryError) {
          console.error("Error fetching trip records:", queryError);
          return errorResponse(
            `Database error: ${queryError.message}`,
            500,
            origin,
          );
        }

        // Process raw data into pairs (simplified version)
        let pairs = processRawTripRecords(rawData || []);
        if (mockProviderIds && mockProviderIds.length) {
          pairs = applyMockProviderIdsToManifestPairs(pairs, mockProviderIds);
        }

        const filteredPairs = providerId !== null && providerId !== undefined
          ? pairs.filter((pair) => pair.provider_id === providerId)
          : pairs;
        return jsonResponse(filteredPairs, 200, origin);
      }

      console.error("Error in get_trip_record_pairs:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    let pairs = data || [];
    if (mockProviderIds && mockProviderIds.length) {
      pairs = applyMockProviderIdsToManifestPairs(pairs, mockProviderIds);
    }

    const filteredData = providerId !== null && providerId !== undefined
      ? pairs.filter((row) =>
        Number((row as { provider_id?: number | null }).provider_id) ===
          providerId
      )
      : pairs;

    return jsonResponse(filteredData, 200, origin);
  } catch (err) {
    console.error("Unexpected error in listManifestTripRecordPairs:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Process raw trip records into pairs.
 * Simplified version of the Python logic.
 */
function processRawTripRecords(
  records: Record<string, unknown>[],
): ManifestTripRecordPair[] {
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
    const [serviceDateStr, tripId] = key.split("|");

    // Sort by row_number
    rows.sort((a, b) =>
      ((a.row_number as number) || 0) - ((b.row_number as number) || 0)
    );

    // Find LYARD and RYARD
    const lyard = rows.find((r) => r.stop_type === "LYARD");
    const ryard = [...rows].reverse().find((r) => r.stop_type === "RYARD");

    if (!lyard || !ryard) continue;

    // Get pickup and drop rows
    const pickupRows = rows.filter((r) => r.stop_type === "PICK");
    const dropRows = rows.filter((r) => r.stop_type === "DROP");

    // Skip if no service stops
    if (pickupRows.length === 0 && dropRows.length === 0) continue;

    const firstPick = pickupRows[0];
    const lastDrop = dropRows[dropRows.length - 1];

    // Get provider/route/vehicle from first available
    const providerId = rows.find((r) => r.provider_id)?.provider_id as
      | number
      | null;
    const route = (rows.find((r) => r.route)?.route as string) || null;
    const vehicle = (rows.find((r) => r.vehicle)?.vehicle as string) || null;

    // Calculate times
    const lyardTime = (lyard.departure_time || lyard.arrival_time) as
      | string
      | null;
    const ryardTime = (ryard.arrival_time || ryard.departure_time) as
      | string
      | null;

    // Calculate first service stop (excluding LYARD/RYARD)
    const firstService = rows.find((r) =>
      r.stop_type !== "LYARD" && r.stop_type !== "RYARD"
    );
    const lastService = [...rows].reverse().find((r) =>
      r.stop_type !== "LYARD" && r.stop_type !== "RYARD"
    );

    // Calculate outbound/inbound/activity times
    const lyardEnd = timeToSeconds(
      (lyard.departure_time || lyard.arrival_time) as string,
    );
    const firstServiceStart = timeToSeconds(
      (firstService?.arrival_time || firstService?.departure_time) as string,
    );
    const lastServiceEnd = timeToSeconds(
      (lastService?.departure_time || lastService?.arrival_time) as string,
    );
    const ryardStart = timeToSeconds(
      (ryard.arrival_time || ryard.departure_time) as string,
    );

    const outboundMinutes = secondsToMinutes(
      diffSeconds(lyardEnd, firstServiceStart),
    );
    const inboundMinutes = secondsToMinutes(
      diffSeconds(lastServiceEnd, ryardStart),
    );

    // Activity time from first pick to last drop
    const activityStartRow = firstPick || firstService;
    const activityEndRow = lastDrop || lastService;
    const activityStart = timeToSeconds(
      (activityStartRow?.departure_time ||
        activityStartRow?.arrival_time) as string,
    );
    const activityEnd = timeToSeconds(
      (activityEndRow?.arrival_time ||
        activityEndRow?.departure_time) as string,
    );
    const activityMinutes = secondsToMinutes(
      diffSeconds(activityStart, activityEnd),
    );

    pairs.push({
      service_date: serviceDateStr,
      trip_id: tripId,
      provider_id: providerId,
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
  origin?: string | null,
  providerId?: number | null,
  mockProviderIds?: number[] | null,
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    // First try RPC function
    const { data, error } = await supabase.rpc(
      "get_trip_record_pair_summaries",
    );

    if (error) {
      // Check both error code and message since Supabase/PostgREST may format errors differently
      const isRpcNotFound = error.code === "42883" ||
        (error.message &&
          error.message.includes("Could not find the function"));

      if (isRpcNotFound) {
        // Fall back to computing from pairs
        const pairsResponse = await listManifestTripRecordPairs(
          null,
          providerId,
          origin,
          mockProviderIds,
        );
        const pairsData = await pairsResponse.json();

        if (!Array.isArray(pairsData)) {
          return jsonResponse([], 200, origin);
        }

        // Group by date
        const byDate = new Map<string, ManifestTripRecordPair[]>();
        for (const pair of pairsData as ManifestTripRecordPair[]) {
          const date = pair.service_date;
          if (!byDate.has(date)) {
            byDate.set(date, []);
          }
          byDate.get(date)!.push(pair);
        }

        // Compute summaries
        const summaries: ManifestTripRecordPairSummary[] = [];
        for (const [serviceDate, pairs] of byDate) {
          const outbounds = pairs
            .map((p) => p.outbound_minutes)
            .filter((v): v is number => v !== null);
          const inbounds = pairs
            .map((p) => p.inbound_minutes)
            .filter((v): v is number => v !== null);
          const activities = pairs
            .map((p) => p.activity_minutes)
            .filter((v): v is number => v !== null);

          summaries.push({
            service_date: serviceDate,
            pair_count: pairs.length,
            average_outbound_minutes: outbounds.length > 0
              ? Math.round(
                (outbounds.reduce((a, b) => a + b, 0) / outbounds.length) * 100,
              ) / 100
              : null,
            average_inbound_minutes: inbounds.length > 0
              ? Math.round(
                (inbounds.reduce((a, b) => a + b, 0) / inbounds.length) * 100,
              ) / 100
              : null,
            average_activity_minutes: activities.length > 0
              ? Math.round(
                (activities.reduce((a, b) => a + b, 0) / activities.length) *
                  100,
              ) / 100
              : null,
          });
        }

        summaries.sort((a, b) => a.service_date.localeCompare(b.service_date));
        return jsonResponse(summaries, 200, origin);
      }

      console.error("Error in get_trip_record_pair_summaries:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    return jsonResponse(data || [], 200, origin);
  } catch (err) {
    console.error(
      "Unexpected error in listManifestTripRecordPairSummaries:",
      err,
    );
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Upload trip records into trip_record_pairs_raw.
 */
async function uploadTripRecords(
  request: Request,
  origin?: string | null,
): Promise<Response> {
  try {
    const payload = await request.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (!payload || typeof payload !== "object") {
      return errorResponse("Invalid JSON payload", 400, origin);
    }

    const recordsText = typeof payload.records === "string"
      ? payload.records
      : "";
    if (!recordsText.trim()) {
      return errorResponse("Trip records payload is required", 400, origin);
    }

    const providerIdRaw = payload.provider_id;
    let providerId: number | null = null;
    if (
      providerIdRaw !== undefined && providerIdRaw !== null &&
      String(providerIdRaw).trim() !== ""
    ) {
      const parsed = Number(providerIdRaw);
      if (Number.isNaN(parsed)) {
        return errorResponse("Invalid provider_id", 400, origin);
      }
      providerId = parsed;
    }

    const { headers, rows } = parseUploadRows(recordsText);
    if (headers.length === 0) {
      return errorResponse("Upload must include a header row", 400, origin);
    }

    const columnMap = headers.map((header) => {
      const normalized = normalizeUploadHeader(header);
      const mapped = UPLOAD_COLUMN_ALIASES[normalized] || normalized;
      return UPLOAD_ALLOWED_COLUMNS.has(mapped) ? mapped : null;
    });

    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      const record: Record<string, unknown> = {};
      const maxColumns = Math.min(row.length, columnMap.length);
      for (let i = 0; i < maxColumns; i++) {
        const column = columnMap[i];
        if (!column) continue;
        const rawValue = row[i]?.trim() ?? "";
        record[column] = coerceUploadValue(column, rawValue);
      }

      if (providerId !== null && record.provider_id === undefined) {
        record.provider_id = providerId;
      }

      if (Object.keys(record).length > 0) {
        records.push(record);
      }
    }

    const skippedCount = rows.length - records.length;
    if (records.length === 0) {
      return jsonResponse(
        { inserted_count: 0, skipped_count: skippedCount },
        200,
        origin,
      );
    }

    const supabase = createOptimatClient();
    const batchSize = 500;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const { error } = await supabase.from("trip_record_pairs_raw").insert(
        batch,
      );
      if (error) {
        console.error("Error inserting trip records:", error);
        return errorResponse(`Database error: ${error.message}`, 500, origin);
      }
    }

    return jsonResponse(
      { inserted_count: records.length, skipped_count: skippedCount },
      200,
      origin,
    );
  } catch (err) {
    console.error("Unexpected error in uploadTripRecords:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Get trip records from trip_record_pairs_raw table.
 */
async function listTripRecordPairs(
  origin?: string | null,
  providerId?: number | null,
  mockProviderIds?: number[] | null,
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    const { data, error } = await supabase
      .from("trip_record_pairs_raw")
      .select("*")
      .order("pick_time");

    if (error) {
      console.error("Error fetching trip records:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    if (!data) {
      return jsonResponse([], 200, origin);
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
        pickLookup.set(Number(row.trip_id), row.pick_time);
      }
    }

    // Process records
    const records: TripPairRecord[] = rows.map((row) => {
      const pickSeconds = timeToSeconds(row.pick_time);
      const dropSeconds = timeToSeconds(row.drop_time);
      const durationMinutes =
        secondsToMinutes(diffSeconds(pickSeconds, dropSeconds)) || 0;

      let returnPickTime: string | null = null;
      let returnGapMinutes: number | null = null;
      const tripIdReturn = row.trip_id_return;
      if (tripIdReturn !== null && tripIdReturn >= 0) {
        returnPickTime = pickLookup.get(Number(tripIdReturn)) || null;
        if (returnPickTime) {
          returnGapMinutes = secondsToMinutes(
            diffSeconds(dropSeconds, timeToSeconds(returnPickTime)),
          );
        }
      }

      const { street: pickupAddress, city: pickupCity } = splitAddress(
        row.addr_pk,
      );
      const { street: dropAddress, city: dropCity } = splitAddress(row.addr_dp);

      // Parse outbound duration from interval if present
      let outboundDurationMinutes: number | null = null;
      if (row.outgo_dura) {
        const parts = String(row.outgo_dura).split(":");
        if (parts.length >= 2) {
          const h = parseInt(parts[0], 10) || 0;
          const m = parseInt(parts[1], 10) || 0;
          const s = parts.length > 2 ? parseInt(parts[2], 10) || 0 : 0;
          outboundDurationMinutes = Math.round((h * 60 + m + s / 60) * 100) /
            100;
        }
      }

      return {
        trip_id: Number(row.trip_id),
        pickup_sequence: Number(row.no_pk),
        drop_sequence: Number(row.no_dp),
        pick_time: row.pick_time,
        drop_time: row.drop_time,
        pickup_address: pickupAddress,
        pickup_city: pickupCity,
        drop_address: dropAddress,
        drop_city: dropCity,
        passengers_on_board: Number(row.psg_on_brd),
        trip_id_return: tripIdReturn !== null && tripIdReturn >= 0
          ? Number(tripIdReturn)
          : null,
        return_pick_time: returnPickTime,
        duration_minutes: durationMinutes,
        return_gap_minutes: returnGapMinutes,
        outbound_duration_minutes: outboundDurationMinutes,
        route_polyline: row.google_maps_route || null,
        route_distance_meters: row.google_route_distance_m || 0,
        route_duration_seconds: row.google_route_duration_s || 0,
        route_summary: row.google_route_summary || null,
      };
    });

    return jsonResponse(records, 200, origin);
  } catch (err) {
    console.error("Unexpected error in listTripRecordPairs:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Get grouped trip pairs with outbound and return legs.
 */
async function listTripRecordPairsGrouped(
  origin?: string | null,
  providerId?: number | null,
  mockProviderIds?: number[] | null,
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    const { data, error } = await supabase
      .from("trip_record_pairs_raw")
      .select("*")
      .order("pick_time");

    if (error) {
      console.error("Error fetching trip records:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    if (!data) {
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
      const tripIdReturn = row.trip_id_return;
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
      const pickSeconds = timeToSeconds(row.pick_time);
      const dropSeconds = timeToSeconds(row.drop_time);
      const durationMinutes =
        secondsToMinutes(diffSeconds(pickSeconds, dropSeconds)) || 0;

      const { street: pickupAddress, city: pickupCity } = splitAddress(
        row.addr_pk,
      );
      const { street: dropAddress, city: dropCity } = splitAddress(row.addr_dp);

      const outboundLeg: TripPairLeg = {
        trip_id: tripId,
        pickup_sequence: Number(row.no_pk),
        drop_sequence: Number(row.no_dp),
        pick_time: row.pick_time,
        drop_time: row.drop_time,
        pickup_address: pickupAddress,
        pickup_city: pickupCity,
        drop_address: dropAddress,
        drop_city: dropCity,
        passengers_on_board: Number(row.psg_on_brd),
        duration_minutes: durationMinutes,
        route_polyline: row.google_maps_route || null,
        route_distance_meters: row.google_route_distance_m || 0,
        route_duration_seconds: row.google_route_duration_s || 0,
        route_summary: row.google_route_summary || null,
      };

      // Check for return leg
      let returnLeg: TripPairLeg | null = null;
      let gapMinutes: number | null = null;
      let roundTripDuration: number | null = null;
      let isRoundTrip = false;

      const tripIdReturn = row.trip_id_return;
      if (tripIdReturn !== null && tripIdReturn > 0) {
        const returnRow = tripLookup.get(Number(tripIdReturn));
        if (returnRow) {
          isRoundTrip = true;

          const returnPickSeconds = timeToSeconds(
            returnRow.pick_time as string,
          );
          const returnDropSeconds = timeToSeconds(
            returnRow.drop_time as string,
          );
          const returnDuration = secondsToMinutes(
            diffSeconds(returnPickSeconds, returnDropSeconds),
          ) || 0;

          const { street: returnPickupAddr, city: returnPickupCity } =
            splitAddress(
              returnRow.addr_pk as string,
            );
          const { street: returnDropAddr, city: returnDropCity } = splitAddress(
            returnRow.addr_dp as string,
          );

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
            route_distance_meters:
              (returnRow.google_route_distance_m as number) || 0,
            route_duration_seconds:
              (returnRow.google_route_duration_s as number) || 0,
            route_summary: (returnRow.google_route_summary as string) || null,
          };

          // Calculate gap between outbound drop and return pickup
          gapMinutes = secondsToMinutes(
            diffSeconds(dropSeconds, returnPickSeconds),
          );

          // Calculate round trip duration (outbound pickup to return drop)
          roundTripDuration = secondsToMinutes(
            diffSeconds(pickSeconds, returnDropSeconds),
          );
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
  } catch (err) {
    console.error("Unexpected error in listTripRecordPairsGrouped:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Get summary statistics for trip records.
 */
async function getTripRecordStats(
  origin?: string | null,
  providerId?: number | null,
  mockProviderIds?: number[] | null,
): Promise<Response> {
  try {
    // Get all trip records
    const pairsResponse = await listTripRecordPairs(
      origin,
      providerId,
      mockProviderIds,
    );
    const records = (await pairsResponse.json()) as TripPairRecord[];

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
    const pickupHotspots = new Map<
      string,
      { city: string | null; count: number }
    >();
    const dropHotspots = new Map<
      string,
      { city: string | null; count: number }
    >();
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
        const hour = parseInt(record.pick_time.split(":")[0], 10);
        if (!isNaN(hour)) {
          pickHours.set(hour, (pickHours.get(hour) || 0) + 1);
        }
      }
    }

    // Sort hotspots by count
    const topPickupHotspots: TripRecordHotspot[] = Array.from(
      pickupHotspots.entries(),
    )
      .map(([label, data]) => ({ label, city: data.city, count: data.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const topDropHotspots: TripRecordHotspot[] = Array.from(
      dropHotspots.entries(),
    )
      .map(([label, data]) => ({ label, city: data.city, count: data.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Sort hours by count (descending), then hour (ascending)
    const busiestPickHours: TripRecordHourCount[] = Array.from(
      pickHours.entries(),
    )
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count || a.hour - b.hour);

    // Calculate averages
    const avgDuration = durations.length > 0
      ? Math.round(
        (durations.reduce((a, b) => a + b, 0) / durations.length) * 100,
      ) / 100
      : 0;
    const avgReturnGap = returnGaps.length > 0
      ? Math.round(
        (returnGaps.reduce((a, b) => a + b, 0) / returnGaps.length) * 100,
      ) / 100
      : null;

    // Get earliest/latest times
    const pickTimes = records.map((r) => r.pick_time).filter(Boolean).sort();
    const dropTimes = records.map((r) => r.drop_time).filter(Boolean).sort();

    const stats: TripPairStats = {
      total_records: records.length,
      with_return_count: withReturn.length,
      pct_with_return: Math.round((withReturn.length / records.length) * 1000) /
        10,
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
  } catch (err) {
    console.error("Unexpected error in getTripRecordStats:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Main request handler.
 */
serve(async (req: Request): Promise<Response> => {
  const requestOrigin = req.headers.get("origin");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(requestOrigin);
  }

  try {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
    const providerIdParam = url.searchParams.get("provider_id");
    const providerId = providerIdParam ? Number(providerIdParam) : null;
    const mockParam = url.searchParams.get("mock");
    const useMockProviders = mockParam === "true" || mockParam === "1";
    const mockProviderIds = useMockProviders ? await fetchProviderIds() : null;

    if (providerIdParam && Number.isNaN(providerId)) {
      return errorResponse("Invalid provider_id", 400, requestOrigin);
    }

    // Parse route
    const { segments } = parseRoute(pathname);

    console.log(`[TripRecords] ${method} ${pathname} - segments:`, segments);

    // Route handling
    // GET /trip-records/pairs - List trip record pairs
    if (method === "GET" && segments[0] === "pairs" && segments.length === 1) {
      return await listTripRecordPairs(
        requestOrigin,
        providerId,
        mockProviderIds,
      );
    }

    // GET /trip-records/pairs-grouped - Get grouped trip pairs
    if (
      method === "GET" && segments[0] === "pairs-grouped" &&
      segments.length === 1
    ) {
      return await listTripRecordPairsGrouped(
        requestOrigin,
        providerId,
        mockProviderIds,
      );
    }

    // GET /trip-records/stats - Get trip record stats
    if (method === "GET" && segments[0] === "stats" && segments.length === 1) {
      return await getTripRecordStats(
        requestOrigin,
        providerId,
        mockProviderIds,
      );
    }

    // POST /trip-records/upload - Upload trip records
    if (
      method === "POST" && segments[0] === "upload" && segments.length === 1
    ) {
      const unauthorized = requireMigrationAdmin(req, requestOrigin);
      if (unauthorized) return unauthorized;
      return await uploadTripRecords(req, requestOrigin);
    }

    // GET /trip-records/manifest/pairs - List manifest trip record pairs
    if (
      method === "GET" && segments[0] === "manifest" &&
      segments[1] === "pairs" && segments.length === 2
    ) {
      const serviceDate = url.searchParams.get("service_date");
      return await listManifestTripRecordPairs(
        serviceDate,
        providerId,
        requestOrigin,
        mockProviderIds,
      );
    }

    // GET /trip-records/manifest/pair-summaries - Get manifest daily summaries
    if (
      method === "GET" && segments[0] === "manifest" &&
      segments[1] === "pair-summaries" && segments.length === 2
    ) {
      return await listManifestTripRecordPairSummaries(
        requestOrigin,
        providerId,
        mockProviderIds,
      );
    }

    // Route not found
    return errorResponse(
      `Not found: ${method} ${pathname}`,
      404,
      requestOrigin,
    );
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500, requestOrigin);
  }
});
