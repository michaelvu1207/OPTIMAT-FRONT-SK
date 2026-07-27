/**
 * Tool definitions and execution logic for the OPTIMAT chat service.
 * Implements the three core tools: find_providers, search_addresses, get_provider_info
 *
 * Note: All tables are in the 'optimat' schema.
 */

import { TABLES } from "../_shared/supabase.ts";
import {
  evaluateEligibility,
  getLocationMismatch,
  requiresRiderAge,
  resolveTravelDate,
  SERVICE_TIME_ZONE,
  type RiderEligibility,
  type TimeIntent,
  type TripType,
} from "./trip.ts";

// `_shared/supabase.ts` and the Edge bundle resolve the Supabase package through
// different module hosts. Keep this small database boundary structural at runtime
// instead of mixing two nominally incompatible SupabaseClient class types.
type DatabaseClient = any;

// Types for tool parameters and results
export interface FindProvidersParams {
  source_address: string;
  destination_address: string;
  departure_time: string;
  return_time?: string | null;
  trip_type: TripType;
  travel_date_raw: string;
  outbound_time_intent?: TimeIntent;
  rider_eligibility: RiderEligibility;
  schedule_type?: string;
  provider_type?: string;
}

export interface CheckTripCoverageParams {
  source_address: string;
  destination_address: string;
}

export interface ResolveTripDateParams {
  travel_date_raw: string;
}

export interface SearchAddressesParams {
  user_query: string;
}

export interface GetProviderInfoParams {
  provider_name: string;
}

export interface GeneralProviderQuestionParams {
  question: string;
}

export interface GeocodedLocation {
  lat: number;
  lng: number;
  formatted_address: string;
  display_name?: string;
}

export interface Provider {
  id: number;
  name?: string;
  provider_type?: string;
  routing_type?: string;
  eligibility_reqs?: unknown;
  eligibility_requirements?: string[];
  service_hours?: {
    hours?: Array<{
      day?: string;
      start?: string;
      end?: string;
    }>;
  };
  service_zone?: unknown;
  website?: string;
  phone?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Tool definitions for Anthropic API
export const toolDefinitions = [
  {
    name: "resolve_trip_date",
    description: `Resolve a rider's date words using the authoritative America/Los_Angeles service clock.
Call this whenever the rider provides or changes a date phrase, before you repeat, confirm, infer a year, or name a weekday.
Pass the rider's exact words. Never calculate the date or weekday yourself.`,
    input_schema: {
      type: "object" as const,
      properties: {
        travel_date_raw: {
          type: "string",
          description: 'The rider\'s exact date phrase, such as "tomorrow", "Tuesday", "July 21ar", or "July 21, 2026".',
        },
      },
      required: ["travel_date_raw"],
    },
  },
  {
    name: "check_trip_coverage",
    description: `Check whether any provider service area covers both the origin and destination.
Call this as soon as both locations are known, before asking for date, times, return details, or eligibility.
It detects impossible provider trips early and also detects when a named place resolves to a different Bay Area city.`,
    input_schema: {
      type: "object" as const,
      properties: {
        source_address: {
          type: "string",
          description: "The user's pickup/origin location, including their city wording",
        },
        destination_address: {
          type: "string",
          description: "The user's destination, including their city wording",
        },
      },
      required: ["source_address", "destination_address"],
    },
  },
  {
    name: "find_providers",
    description: `Find providers for a validated one-way or round trip.
The server resolves the user's verbatim date phrase in America/Los_Angeles, filters geography and service hours, and enforces rider eligibility.

Before calling this tool, ensure you have asked the user for:
1. Their eligibility context (the rider's exact age in years, disability or ADA certification, veteran status, and relevant residency)
2. The travel date (pass the user's exact words as travel_date_raw)
3. Their outbound time and whether it means depart_at or arrive_by
4. Whether this is one_way or round_trip
5. A return time only when trip_type is round_trip`,
    input_schema: {
      type: "object" as const,
      properties: {
        source_address: {
          type: "string",
          description: "The pickup/origin address where the user starts from (home)",
        },
        destination_address: {
          type: "string",
          description: "The drop-off/destination address where the user wants to go",
        },
        departure_time: {
          type: "string",
          description:
            'The user-provided outbound time (e.g., "9:00 AM", "noon"). Required.',
        },
        return_time: {
          type: "string",
          description:
            'The time the user wants to return. Required only for round_trip; omit for one_way.',
        },
        trip_type: {
          type: "string",
          enum: ["one_way", "round_trip"],
          description: "Whether the rider needs only the outbound trip or also a return trip",
        },
        travel_date_raw: {
          type: "string",
          description:
            'The rider\'s verbatim date phrase, such as "tomorrow", "Tuesday", or "July 21, 2026". Do not calculate or invent an ISO date.',
        },
        outbound_time_intent: {
          type: "string",
          enum: ["depart_at", "arrive_by"],
          description: 'Use "arrive_by" when the rider says they need to arrive at a time; otherwise use "depart_at".',
        },
        rider_eligibility: {
          type: "object",
          description: "Only facts the rider stated. Ask for the rider's exact age and the three yes/no facts before searching. Use declined=true if they prefer not to share.",
          properties: {
            age: {
              type: "number",
              description:
                "The rider's exact age in years. Ask \"How old are you?\" — never substitute \"senior\" or \"65+\", because providers in this area set minimums of 50, 55, 60, and 65. Omit only when the rider refuses, and then set declined=true.",
            },
            disabled: { type: "boolean", description: "True or false from the rider's explicit answer" },
            ada_certified: { type: "boolean", description: "True or false from the rider's explicit answer" },
            veteran: { type: "boolean", description: "True or false from the rider's explicit answer" },
            residence_city: { type: "string", description: "Omit when unknown" },
            declined: { type: "boolean" },
          },
          required: ["disabled", "ada_certified", "veteran"],
        },
        schedule_type: {
          type: "string",
          description:
            'Optional schedule type: "fixed-schedules", "in-advance-book", or "real-time-book"',
        },
        provider_type: {
          type: "string",
          description:
            'Optional provider type: "ADA-para", "para", "volunteer-driver", "city", "community", "fix-route", "discount-program", "special-TNC"',
        },
      },
      required: [
        "source_address",
        "destination_address",
        "departure_time",
        "trip_type",
        "travel_date_raw",
        "outbound_time_intent",
        "rider_eligibility",
      ],
    },
  },
  {
    name: "search_addresses_from_user_query",
    description:
      "Find addresses from a user query using Google Places API. Use this when the user doesn't know the exact address.",
    input_schema: {
      type: "object" as const,
      properties: {
        user_query: {
          type: "string",
          description: "The search query for finding addresses (e.g., 'Walnut Creek BART station')",
        },
      },
      required: ["user_query"],
    },
  },
  {
    name: "get_provider_info",
    description: `Get detailed information about a specific transportation provider.
The provider name must match one of the known providers in the system.`,
    input_schema: {
      type: "object" as const,
      properties: {
        provider_name: {
          type: "string",
          description: "The name of the provider to look up",
        },
      },
      required: ["provider_name"],
    },
  },
  {
    name: "general_provider_question",
    description: `Search the web to answer general questions about transportation providers,
paratransit services, accessibility, eligibility requirements, or other
transportation-related topics that are not answered by our internal data.

Use this tool when the user asks questions about:
- General information about a specific provider not in our database
- Policies, procedures, or requirements for transportation services
- Accessibility features or accommodations
- Comparison between different types of transportation services
- Any transportation-related question not answered by internal tools`,
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The transportation-related question to search for",
        },
      },
      required: ["question"],
    },
  },
];

/**
 * Parse a time string to minutes since midnight.
 * Supports formats like: "14:30", "2:30 PM", "0530", "5:30am", "17:00"
 */
export function parseTimeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;

  let str = timeStr.trim().toUpperCase();
  if (str === "NOON") return 12 * 60;
  if (str === "MIDNIGHT") return 0;
  const isPM = str.includes("PM");
  const isAM = str.includes("AM");
  str = str.replace("PM", "").replace("AM", "").trim();

  try {
    let hours: number;
    let minutes: number;

    if (str.includes(":")) {
      const parts = str.split(":");
      hours = parseInt(parts[0], 10);
      minutes = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    } else if (str.length === 4 && /^\d+$/.test(str)) {
      hours = parseInt(str.slice(0, 2), 10);
      minutes = parseInt(str.slice(2), 10);
    } else if (str.length === 3 && /^\d+$/.test(str)) {
      hours = parseInt(str.slice(0, 1), 10);
      minutes = parseInt(str.slice(1), 10);
    } else if (/^\d+$/.test(str)) {
      hours = parseInt(str, 10);
      minutes = 0;
    } else {
      return null;
    }

    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (minutes < 0 || minutes > 59) return null;
    if ((isAM || isPM) && (hours < 0 || hours > 23)) return null;
    if (!isAM && !isPM && (hours < 0 || hours > 24)) return null;
    if (hours === 24 && minutes !== 0) return null;

    return hours * 60 + minutes;
  } catch {
    return null;
  }
}

/**
 * Get the day index (0=Monday, 6=Sunday) from a date string.
 */
function getDayIndexFromDate(dateStr: string): number | null {
  if (!dateStr) return null;

  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})$/, // 2024-12-05
    /^(\d{2})\/(\d{2})\/(\d{4})$/, // 12/05/2024
    /^(\d{2})-(\d{2})-(\d{4})$/, // 12-05-2024
  ];

  for (const fmt of formats) {
    const match = dateStr.trim().match(fmt);
    if (match) {
      let year: number, month: number, day: number;
      if (fmt === formats[0]) {
        [, year, month, day] = match.map(Number) as [number, number, number, number];
      } else {
        [, month, day, year] = match.map(Number) as [number, number, number, number];
      }
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1; // Convert Sunday=0 to Monday=0 format
    }
  }

  return null;
}

/**
 * Check if the requested times fall within the provider's service hours.
 */
function isTimeWithinServiceHours(
  provider: Provider,
  departureTime?: string,
  returnTime?: string,
  travelDate?: string
): boolean {
  if (!departureTime && !returnTime) return true;

  let serviceHours = provider.service_hours;
  if (!serviceHours) return true;

  if (typeof serviceHours === "string") {
    try {
      serviceHours = JSON.parse(serviceHours);
    } catch {
      return true;
    }
  }

  const hoursList =
    typeof serviceHours === "object" && serviceHours !== null && "hours" in serviceHours
      ? (serviceHours as { hours?: Array<{ day?: string; start?: string; end?: string }> }).hours ||
        []
      : [];

  if (hoursList.length === 0) return true;

  const dayIndex = travelDate ? getDayIndexFromDate(travelDate) : null;
  const depMinutes = departureTime ? parseTimeToMinutes(departureTime) : null;
  const retMinutes = returnTime ? parseTimeToMinutes(returnTime) : null;

  if (depMinutes === null && retMinutes === null) return true;

  for (const entry of hoursList) {
    const dayPattern = entry.day || "1111111";
    const startTime = entry.start || "0000";
    const endTime = entry.end || "2400";

    if (dayIndex !== null && dayPattern.length > dayIndex) {
      if (dayPattern[dayIndex] !== "1") continue;
    }

    const startMinutes = parseTimeToMinutes(startTime);
    let endMinutes = parseTimeToMinutes(endTime);

    if (startMinutes === null || endMinutes === null) continue;

    if (endMinutes < startMinutes) {
      endMinutes += 24 * 60;
    }

    if (depMinutes !== null) {
      let depCheck = depMinutes;
      if (depCheck < startMinutes && endMinutes > 24 * 60) {
        depCheck += 24 * 60;
      }
      if (!(startMinutes <= depCheck && depCheck <= endMinutes)) continue;
    }

    if (retMinutes !== null) {
      let retCheck = retMinutes;
      if (retCheck < startMinutes && endMinutes > 24 * 60) {
        retCheck += 24 * 60;
      }
      if (!(startMinutes <= retCheck && retCheck <= endMinutes)) continue;
    }

    return true;
  }

  return false;
}

/**
 * Geocode an address using Google Places API (Text Search).
 * Uses Places API instead of Geocoding API since Places API is enabled.
 */
async function geocodeAddress(
  address: string,
  googleMapsApiKey: string
): Promise<GeocodedLocation | null> {
  try {
    // Use Places API Text Search which we know is enabled
    const url = "https://places.googleapis.com/v1/places:searchText";
    const headers = {
      "X-Goog-Api-Key": googleMapsApiKey,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      "Content-Type": "application/json",
    };

    const body = JSON.stringify({
      textQuery: address,
      maxResultCount: 1,
      regionCode: "US",
      locationBias: {
        circle: {
          center: { latitude: 37.7749, longitude: -122.2194 },
          // Places API (New) caps a circular location bias at 50 km.
          radius: 50000,
        },
      },
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });

    const data = await response.json();

    if (data.places && data.places.length > 0) {
      const place = data.places[0];
      return {
        lat: place.location.latitude,
        lng: place.location.longitude,
        formatted_address: place.formattedAddress,
        display_name: place.displayName?.text || "",
      };
    }

    return null;
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
}

/**
 * Check if a point is within a GeoJSON polygon/multipolygon.
 */
function isPointInPolygon(
  lat: number,
  lng: number,
  geometry: { type: string; coordinates?: number[][][] | number[][][][]; features?: unknown[]; geometry?: unknown }
): boolean {
  // Handle FeatureCollection — check if point is in ANY feature
  if (geometry.type === "FeatureCollection" && Array.isArray((geometry as any).features)) {
    return (geometry as any).features.some((feature: any) => {
      if (feature.geometry) {
        return isPointInPolygon(lat, lng, feature.geometry);
      }
      return false;
    });
  }

  // Handle Feature — unwrap to geometry
  if (geometry.type === "Feature" && (geometry as any).geometry) {
    return isPointInPolygon(lat, lng, (geometry as any).geometry);
  }

  if (geometry.type === "Polygon") {
    return isPointInSinglePolygon(lat, lng, geometry.coordinates as number[][][]);
  } else if (geometry.type === "MultiPolygon") {
    const coordinates = geometry.coordinates as number[][][][];
    for (const polygon of coordinates) {
      if (isPointInSinglePolygon(lat, lng, polygon)) {
        return true;
      }
    }
  }
  return false;
}

function isPointInSinglePolygon(lat: number, lng: number, coordinates: number[][][]): boolean {
  // Use the outer ring (first element)
  const ring = coordinates[0];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];

    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Get public transit directions using Google Directions API.
 */
async function getTransitDirections(
  origin: string,
  destination: string,
  googleMapsApiKey: string,
  travelDate?: string,
  outboundTime?: string,
  timeIntent: TimeIntent = "depart_at",
): Promise<Record<string, unknown> | null> {
  try {
    const params = new URLSearchParams({
      origin,
      destination,
      mode: "transit",
      transit_routing_preference: "less_walking",
      key: googleMapsApiKey,
    });

    if (travelDate && outboundTime) {
      const unixSeconds = serviceDateTimeToUnix(travelDate, outboundTime);
      if (unixSeconds !== null) {
        params.set(timeIntent === "arrive_by" ? "arrival_time" : "departure_time", String(unixSeconds));
      }
    }

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`
    );

    if (!response.ok) {
      console.warn(`Transit directions API returned ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (data.status !== "OK" || !data.routes || data.routes.length === 0) {
      console.warn(`Transit directions status: ${data.status}`);
      return null;
    }

    const route = data.routes[0];
    const leg = route.legs?.[0];

    if (!leg) {
      return null;
    }

    // Parse steps for transit details
    const steps = (leg.steps || []).map((step: {
      html_instructions?: string;
      distance?: { text?: string; value?: number };
      duration?: { text?: string; value?: number };
      travel_mode?: string;
      transit_details?: {
        line?: {
          name?: string;
          short_name?: string;
          color?: string;
          text_color?: string;
          vehicle?: { type?: string; name?: string };
        };
        departure_stop?: { name?: string };
        arrival_stop?: { name?: string };
        num_stops?: number;
      };
      polyline?: { points?: string };
    }) => ({
      instruction: step.html_instructions || null,
      distance_text: step.distance?.text || null,
      distance_meters: step.distance?.value ?? null,
      duration_text: step.duration?.text || null,
      duration_seconds: step.duration?.value ?? null,
      travel_mode: step.travel_mode || null,
      transit_details: step.transit_details ? {
        line_name: step.transit_details.line?.name || step.transit_details.line?.short_name || null,
        vehicle_type: step.transit_details.line?.vehicle?.type || null,
        vehicle_name: step.transit_details.line?.vehicle?.name || null,
        line_color: step.transit_details.line?.color || null,
        line_text_color: step.transit_details.line?.text_color || null,
        departure_stop: step.transit_details.departure_stop?.name || null,
        arrival_stop: step.transit_details.arrival_stop?.name || null,
        num_stops: step.transit_details.num_stops ?? null,
      } : null,
      polyline: step.polyline?.points || null,
    }));

    return {
      summary: route.summary || null,
      overview_polyline: route.overview_polyline?.points || null,
      bounds: route.bounds || null,
      distance_text: leg.distance?.text || null,
      distance_meters: leg.distance?.value ?? null,
      duration_text: leg.duration?.text || null,
      duration_seconds: leg.duration?.value ?? null,
      departure_time: leg.departure_time?.text || null,
      arrival_time: leg.arrival_time?.text || null,
      start_address: leg.start_address || null,
      end_address: leg.end_address || null,
      steps,
      warnings: route.warnings || [],
    };
  } catch (error) {
    console.warn("Error getting transit directions:", error);
    return null;
  }
}

function serviceDateTimeToUnix(
  dateIso: string,
  timeValue: string,
  timeZone = SERVICE_TIME_ZONE,
): number | null {
  const dateMatch = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const minutesSinceMidnight = parseTimeToMinutes(timeValue);
  if (!dateMatch || minutesSinceMidnight === null) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = minutesSinceMidnight % 60;
  const desiredWallClockUtc = Date.UTC(year, month - 1, day, hours, minutes);

  const getOffset = (timestamp: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(timestamp))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return localAsUtc - timestamp;
  };

  let timestamp = desiredWallClockUtc - getOffset(desiredWallClockUtc);
  timestamp = desiredWallClockUtc - getOffset(timestamp);
  return Math.floor(timestamp / 1000);
}

const PROVIDER_SEARCH_COLUMNS = [
  "id",
  "provider_id",
  "provider_name",
  "provider_type",
  "routing_type",
  "schedule_type",
  "planning_type",
  "eligibility_reqs",
  "booking",
  "fare",
  "service_hours",
  "service_zone",
  "website",
  "provider_org",
  "round_trip_booking",
  "investigated",
  "contacts",
  "service_area_cities",
].join(",");

async function resolveTripLocations(
  sourceAddress: string,
  destinationAddress: string,
  googleMapsApiKey: string,
): Promise<
  | { ok: true; source: GeocodedLocation; destination: GeocodedLocation }
  | { ok: false; error?: string; clarification?: Record<string, unknown> }
> {
  const [source, destination] = await Promise.all([
    geocodeAddress(sourceAddress, googleMapsApiKey),
    geocodeAddress(destinationAddress, googleMapsApiKey),
  ]);

  if (!source) return { ok: false, error: `Could not geocode source address: ${sourceAddress}` };
  if (!destination) return { ok: false, error: `Could not geocode destination address: ${destinationAddress}` };

  const sourceMismatch = getLocationMismatch(sourceAddress, source.formatted_address);
  const destinationMismatch = getLocationMismatch(destinationAddress, destination.formatted_address);
  const mismatch = sourceMismatch || destinationMismatch;
  if (mismatch) {
    return {
      ok: false,
      clarification: {
        status: "clarification_required",
        reason_code: "location_city_mismatch",
        message: mismatch.message,
        requested_source: sourceAddress,
        requested_destination: destinationAddress,
        resolved_source: source.formatted_address,
        resolved_destination: destination.formatted_address,
      },
    };
  }

  return { ok: true, source, destination };
}

async function loadProviderSearchRows(supabase: DatabaseClient): Promise<Provider[]> {
  const { data, error } = await supabase.from(TABLES.PROVIDERS).select(PROVIDER_SEARCH_COLUMNS);
  if (error) throw new Error(`Database error: ${error.message}`);
  return (data || []) as unknown as Provider[];
}

function geographyMatches(
  providers: Provider[],
  source: GeocodedLocation,
  destination: GeocodedLocation,
): Provider[] {
  const matches: Provider[] = [];
  for (const provider of providers) {
    if (!provider.service_zone) continue;
    let serviceZone = provider.service_zone;
    if (typeof serviceZone === "string") {
      try {
        serviceZone = JSON.parse(serviceZone);
      } catch {
        continue;
      }
    }
    const zone = serviceZone as {
      type: string;
      coordinates?: number[][][] | number[][][][];
      features?: unknown[];
      geometry?: unknown;
    };
    if (
      isPointInPolygon(source.lat, source.lng, zone) &&
      isPointInPolygon(destination.lat, destination.lng, zone)
    ) {
      matches.push(provider);
    }
  }
  return matches;
}

function isDirectRideProvider(provider: Provider): boolean {
  const providerType = String(provider.provider_type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return providerType !== "fixedroute";
}

function compactProvider(provider: Provider): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      id: provider.id,
      provider_id: provider.provider_id,
      provider_name: provider.provider_name,
      provider_type: provider.provider_type,
      routing_type: provider.routing_type,
      schedule_type: provider.schedule_type,
      planning_type: provider.planning_type,
      eligibility_reqs: provider.eligibility_reqs,
      eligibility_status: provider.eligibility_status,
      eligibility_reason: provider.eligibility_reason,
      booking: provider.booking,
      fare: provider.fare,
      service_hours: provider.service_hours,
      website: provider.website,
      contacts: provider.contacts,
      provider_org: provider.provider_org,
      round_trip_booking: provider.round_trip_booking,
      match_criteria: provider.match_criteria,
    }).filter(([, value]) => value !== undefined && value !== null),
  );
}

export async function executeCheckTripCoverage(
  params: CheckTripCoverageParams,
  supabase: DatabaseClient,
  googleMapsApiKey: string,
): Promise<ToolResult> {
  try {
    const locations = await resolveTripLocations(
      params.source_address,
      params.destination_address,
      googleMapsApiKey,
    );
    if (!locations.ok) {
      if (locations.clarification) return { success: true, data: locations.clarification };
      return { success: false, error: locations.error };
    }

    const providers = await loadProviderSearchRows(supabase);
    const directProviders = providers.filter(isDirectRideProvider);
    const matches = geographyMatches(directProviders, locations.source, locations.destination);
    return {
      success: true,
      data: {
        status: matches.length > 0 ? "covered" : "not_covered",
        source_address: locations.source.formatted_address,
        destination_address: locations.destination.formatted_address,
        geography_match_count: matches.length,
        fixed_route_fallback_count: providers.length - directProviders.length,
        provider_names: matches.slice(0, 10).map((provider) => provider.provider_name),
        message:
          matches.length > 0
            ? `${matches.length} provider service area${matches.length === 1 ? "" : "s"} cover both locations. Continue gathering the trip date, applicable times, and eligibility.`
            : `No provider in the current OPTIMAT data has a service area covering both ${locations.source.formatted_address} and ${locations.destination.formatted_address}. Changing the time will not fix this coverage constraint.`,
      },
    };
  } catch (error) {
    return { success: false, error: `Error checking trip coverage: ${error}` };
  }
}

export function executeResolveTripDate(
  params: ResolveTripDateParams,
  now = new Date(),
): ToolResult {
  const resolved = resolveTravelDate(params.travel_date_raw, now);
  if (!resolved.ok || !resolved.iso) {
    return {
      success: true,
      data: {
        status: "clarification_required",
        reason_code: "travel_date_invalid",
        travel_date_raw: params.travel_date_raw,
        message: resolved.error,
        timezone: SERVICE_TIME_ZONE,
      },
    };
  }

  return {
    success: true,
    data: {
      status: "resolved",
      travel_date_raw: params.travel_date_raw,
      travel_date: resolved.iso,
      travel_date_display: resolved.display,
      timezone: SERVICE_TIME_ZONE,
      message: `Use ${resolved.display} (${resolved.iso}). Do not substitute another year or weekday.`,
    },
  };
}

/** Execute the full provider search after coverage and required trip fields are known. */
export async function executeFindProviders(
  params: FindProvidersParams,
  supabase: DatabaseClient,
  googleMapsApiKey: string,
): Promise<ToolResult> {
  try {
    const locations = await resolveTripLocations(
      params.source_address,
      params.destination_address,
      googleMapsApiKey,
    );
    if (!locations.ok) {
      if (locations.clarification) return { success: true, data: locations.clarification };
      return { success: false, error: locations.error };
    }

    if (params.trip_type !== "one_way" && params.trip_type !== "round_trip") {
      return {
        success: true,
        data: {
          status: "clarification_required",
          reason_code: "trip_type_missing",
          message: "Is this a one-way or round trip?",
        },
      };
    }

    if (params.trip_type === "round_trip" && !params.return_time) {
      return {
        success: true,
        data: {
          status: "clarification_required",
          reason_code: "return_time_missing",
          message: "What time would you like to return? A return time is needed only because this is a round trip.",
        },
      };
    }

    const resolvedDate = resolveTravelDate(params.travel_date_raw);
    if (!resolvedDate.ok || !resolvedDate.iso) {
      return {
        success: true,
        data: {
          status: "clarification_required",
          reason_code: "travel_date_invalid",
          message: resolvedDate.error,
        },
      };
    }

    if (parseTimeToMinutes(params.departure_time) === null) {
      return {
        success: true,
        data: {
          status: "clarification_required",
          reason_code: "departure_time_invalid",
          message: `I couldn't understand the outbound time “${params.departure_time}.” What time should the trip leave or arrive?`,
        },
      };
    }
    if (params.return_time && parseTimeToMinutes(params.return_time) === null) {
      return {
        success: true,
        data: {
          status: "clarification_required",
          reason_code: "return_time_invalid",
          message: `I couldn't understand the return time “${params.return_time}.” What return time would you like?`,
        },
      };
    }

    const providers = await loadProviderSearchRows(supabase);
    const directProviders = providers.filter(isDirectRideProvider);
    const geographyProviders = geographyMatches(directProviders, locations.source, locations.destination);
    const scheduleProviders = geographyProviders.filter((provider) =>
      isTimeWithinServiceHours(
        provider,
        params.departure_time,
        params.trip_type === "round_trip" ? params.return_time || undefined : undefined,
        resolvedDate.iso!,
      )
    );

    // Providers set different minimum ages (50, 55, 60, 65). "I'm a senior" cannot decide those,
    // so ask for the exact age instead of silently hiding the provider behind verification.
    const rider = params.rider_eligibility || {};
    const ageUnknown = !Number.isFinite(Number(rider.age));
    if (ageUnknown && !rider.declined && scheduleProviders.some((provider) => requiresRiderAge(provider.eligibility_reqs))) {
      return {
        success: true,
        data: {
          status: "clarification_required",
          reason_code: "rider_age_missing",
          message:
            "How old is the rider? Providers here set different minimum ages (50, 55, 60, and 65 all appear in this area), so I need the exact age rather than “senior” to tell which ones qualify.",
          source_address: locations.source.formatted_address,
          destination_address: locations.destination.formatted_address,
        },
      };
    }

    const evaluatedProviders = scheduleProviders.map((provider) => {
      const evaluation = evaluateEligibility(provider.eligibility_reqs, rider);
      return {
        ...provider,
        eligibility_status: evaluation.status,
        eligibility_reason: evaluation.reason,
        match_criteria: {
          algorithm: "Both trip points are inside the service area; the provider operates on the requested date/time; rider eligibility is evaluated before recommendation.",
          passed: [
            { label: "Origin inside service area", detail: locations.source.formatted_address },
            { label: "Destination inside service area", detail: locations.destination.formatted_address },
            {
              label: "Service hours include requested trip window",
              detail: params.trip_type === "round_trip"
                ? `${resolvedDate.display}; outbound ${params.departure_time}; return ${params.return_time}`
                : `${resolvedDate.display}; one-way outbound ${params.departure_time}`,
            },
            ...(evaluation.status === "eligible"
              ? [{ label: "Eligibility matched", detail: evaluation.reason }]
              : []),
          ],
        },
      } as Provider;
    });

    const eligibleProviders = evaluatedProviders.filter((provider) => provider.eligibility_status === "eligible");
    const verificationProviders = evaluatedProviders.filter(
      (provider) => provider.eligibility_status === "verification_required",
    );
    const ineligibleProviders = evaluatedProviders.filter((provider) => provider.eligibility_status === "ineligible");

    let transitData: Record<string, unknown> | null = null;
    try {
      transitData = await getTransitDirections(
        locations.source.formatted_address,
        locations.destination.formatted_address,
        googleMapsApiKey,
        resolvedDate.iso,
        params.departure_time,
        params.outbound_time_intent || "depart_at",
      );
    } catch (error) {
      console.warn("Failed to get transit directions:", error);
    }

    const publicTransitAvailable = Boolean(transitData);
    const result = {
      status: "complete",
      trip_type: params.trip_type,
      travel_date: resolvedDate.iso,
      travel_date_display: resolvedDate.display,
      departure_time: params.departure_time,
      outbound_time_intent: params.outbound_time_intent || "depart_at",
      return_time: params.trip_type === "round_trip" ? params.return_time || null : null,
      data: eligibleProviders.map(compactProvider),
      verification_required: verificationProviders.map(compactProvider),
      excluded_providers: ineligibleProviders.map((provider) => ({
        provider_name: provider.provider_name,
        stage: "eligibility",
        reason: provider.eligibility_reason,
        requirement: provider.eligibility_reqs,
      })),
      source_address: locations.source.formatted_address,
      destination_address: locations.destination.formatted_address,
      source_coordinates: { lat: locations.source.lat, lng: locations.source.lng },
      destination_coordinates: { lat: locations.destination.lat, lng: locations.destination.lng },
      total_found: eligibleProviders.length,
      direct_provider_count: eligibleProviders.length,
      public_transit_available: publicTransitAvailable,
      total_options_found: eligibleProviders.length + (publicTransitAvailable ? 1 : 0),
      filtered_out_count: directProviders.length - eligibleProviders.length,
      diagnostics: {
        provider_count: directProviders.length,
        fixed_route_fallback_count: providers.length - directProviders.length,
        geography_match_count: geographyProviders.length,
        schedule_match_count: scheduleProviders.length,
        eligible_match_count: eligibleProviders.length,
        verification_required_count: verificationProviders.length,
        ineligible_count: ineligibleProviders.length,
      },
      public_transit: transitData,
    };

    const serializedSize = JSON.stringify(result).length;
    console.log("find_providers compact result size", {
      bytes: serializedSize,
      providers: eligibleProviders.length,
      verification: verificationProviders.length,
      excluded: ineligibleProviders.length,
    });
    if (serializedSize > 100_000) {
      return {
        success: false,
        error: "Provider result exceeded the safe response limit after compaction.",
      };
    }

    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: `Error finding providers: ${error}` };
  }
}

/**
 * Execute the search_addresses tool.
 */
export async function executeSearchAddresses(
  params: SearchAddressesParams,
  googleMapsApiKey: string
): Promise<ToolResult> {
  try {
    const url = "https://places.googleapis.com/v1/places:searchText";
    const headers = {
      "X-Goog-Api-Key": googleMapsApiKey,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        textQuery: params.user_query,
        regionCode: "US",
        locationBias: {
          circle: {
            center: { latitude: 37.7749, longitude: -122.2194 },
            // Places API (New) caps a circular location bias at 50 km.
            radius: 50000,
          },
        },
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Google Places API error: ${response.status}`,
      };
    }

    const data = await response.json();

    // Format the results
    const places =
      data.places?.map(
        (place: {
          displayName?: { text?: string };
          formattedAddress?: string;
          location?: { latitude?: number; longitude?: number };
        }) => ({
          name: place.displayName?.text || "",
          address: place.formattedAddress || "",
          location: place.location
            ? { lat: place.location.latitude, lng: place.location.longitude }
            : null,
        })
      ) || [];

    return { success: true, data: { places, query: params.user_query } };
  } catch (error) {
    return { success: false, error: `Error searching addresses: ${error}` };
  }
}

/**
 * Execute the get_provider_info tool.
 */
export async function executeGetProviderInfo(
  params: GetProviderInfoParams,
  supabase: DatabaseClient
): Promise<ToolResult> {
  try {
    // Search for provider by name (case-insensitive) - uses provider_name column in optimat schema
    const { data: providers, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select(PROVIDER_SEARCH_COLUMNS.replace(",service_zone", ""))
      .ilike("provider_name", `%${params.provider_name}%`)
      .limit(5);

    if (error) {
      return { success: false, error: `Database error: ${error.message}` };
    }

    if (!providers || providers.length === 0) {
      return {
        success: false,
        error: `No provider found matching: ${params.provider_name}`,
        data: {
          suggestion:
            "Please check the provider name. Available providers include: AC Transit, BART, East Bay Paratransit, WestCAT, and others.",
        },
      };
    }

    const sanitizedProviders = providers.map((provider: unknown) => compactProvider(provider as Provider));

    return {
      success: true,
      data: sanitizedProviders.length === 1 ? sanitizedProviders[0] : sanitizedProviders,
    };
  } catch (error) {
    return { success: false, error: `Error getting provider info: ${error}` };
  }
}

/**
 * Execute the general_provider_question tool using Tavily API for web search.
 */
export async function executeGeneralProviderQuestion(
  params: GeneralProviderQuestionParams
): Promise<ToolResult> {
  try {
    const tavilyApiKey = Deno.env.get("TAVILY_API_KEY");

    if (!tavilyApiKey) {
      return {
        success: false,
        error: "Web search is not configured. Please contact support.",
        data: { query: params.question },
      };
    }

    // Add context to make search more relevant to transportation/paratransit
    const searchQuery = `California Bay Area paratransit transportation ${params.question}`;

    // Perform web search using Tavily API
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: searchQuery,
        search_depth: "advanced",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Tavily API error:", response.status, errorText);
      return {
        success: false,
        error: `Web search failed: ${response.status}`,
        data: { query: params.question },
      };
    }

    const searchResult = await response.json();

    // Extract the answer and relevant results
    const answer = searchResult.answer || "";
    const results = searchResult.results || [];

    // Format results for the LLM
    const formattedResults = results.slice(0, 5).map((result: {
      title?: string;
      url?: string;
      content?: string;
    }) => ({
      title: result.title || "",
      url: result.url || "",
      content: (result.content || "").slice(0, 500), // Limit content length
    }));

    const responseData = {
      query: params.question,
      answer: answer,
      sources: formattedResults,
    };

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Error in general_provider_question:", error);
    return {
      success: false,
      error: `Error searching web: ${error}`,
      data: { query: params.question },
    };
  }
}

/**
 * Execute a tool by name.
 */
export async function executeTool(
  toolName: string,
  toolInput: unknown,
  supabase: DatabaseClient,
  googleMapsApiKey: string
): Promise<ToolResult> {
  switch (toolName) {
    case "resolve_trip_date":
      return executeResolveTripDate(toolInput as ResolveTripDateParams);

    case "check_trip_coverage":
      return executeCheckTripCoverage(toolInput as CheckTripCoverageParams, supabase, googleMapsApiKey);

    case "find_providers":
      return executeFindProviders(toolInput as FindProvidersParams, supabase, googleMapsApiKey);

    case "search_addresses_from_user_query":
      return executeSearchAddresses(toolInput as SearchAddressesParams, googleMapsApiKey);

    case "get_provider_info":
      return executeGetProviderInfo(toolInput as GetProviderInfoParams, supabase);

    case "general_provider_question":
      return executeGeneralProviderQuestion(toolInput as GeneralProviderQuestionParams);

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Store tool call result in the appropriate database table.
 * Uses the specific tool call tables in the optimat schema.
 */
export async function storeToolCall(
  supabase: DatabaseClient,
  conversationId: string,
  toolName: string,
  toolInput: unknown,
  toolResult: ToolResult
): Promise<void> {
  try {
    const input = toolInput as Record<string, unknown>;
    const timestamp = new Date().toISOString();

    switch (toolName) {
      case "check_trip_coverage":
      case "find_providers": {
        const { error } = await supabase.from(TABLES.FIND_PROVIDERS_CALLS).insert({
          conversation_id: conversationId,
          source_address: input.source_address,
          destination_address: input.destination_address,
          provider_data: toolResult.data,
          public_transit_data: (toolResult.data as Record<string, unknown>)?.public_transit || null,
          message_timestamp: timestamp,
        });
        if (error) console.error("Error storing find_providers call:", error);
        break;
      }

      case "search_addresses_from_user_query": {
        const { error } = await supabase.from(TABLES.SEARCH_ADDRESSES_CALLS).insert({
          conversation_id: conversationId,
          query_text: input.user_query,
          places_data: toolResult.data,
          message_timestamp: timestamp,
        });
        if (error) console.error("Error storing search_addresses call:", error);
        break;
      }

      case "get_provider_info": {
        // Get provider_id from the result if available
        const resultData = toolResult.data as Record<string, unknown>;
        const providerId = resultData?.provider_id || resultData?.id || null;

        const { error } = await supabase.from(TABLES.GET_PROVIDER_INFO_CALLS).insert({
          conversation_id: conversationId,
          provider_id: providerId ? Number(providerId) : null,
          provider_info: toolResult.data,
          message_timestamp: timestamp,
        });
        if (error) console.error("Error storing get_provider_info call:", error);
        break;
      }

      case "general_provider_question": {
        const resultData = toolResult.data as Record<string, unknown>;
        const { error } = await supabase.from(TABLES.GENERAL_QUESTION_CALLS).insert({
          conversation_id: conversationId,
          question: input.question,
          search_results: { answer: resultData?.answer, raw_results: resultData?.sources },
          sources: resultData?.sources || [],
          message_timestamp: timestamp,
        });
        if (error) console.error("Error storing general_question call:", error);
        break;
      }

      default:
        console.warn(`Unknown tool name for storage: ${toolName}`);
    }
  } catch (error) {
    console.error("Error storing tool call:", error);
  }
}
