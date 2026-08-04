/**
 * Tool definitions and execution logic for the OPTIMAT chat service.
 * Implements the core tools: find_providers, assess_eligibility, search_addresses
 *
 * Note: All tables are in the 'optimat' schema.
 */

import { TABLES } from "../_shared/supabase.ts";
import {
  citiesMatch,
  resolveTravelDate,
  RIDER_FACTS,
  SERVICE_TIME_ZONE,
  type EligibilityStatus,
  type RiderEligibility,
  type RiderFact,
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
  source_city?: string | null;
  destination_city?: string | null;
}

export interface CheckTripCoverageParams {
  source_address: string;
  destination_address: string;
  source_city?: string | null;
  destination_city?: string | null;
}

/** One provider's eligibility verdict, reasoned out by the assistant from the requirement prose. */
export interface EligibilityAssessment {
  provider_name: string;
  verdict: EligibilityStatus;
  reason: string;
  missing_fact?: RiderFact | null;
}

export interface AssessEligibilityParams {
  assessments: EligibilityAssessment[];
}

export interface ResolveTripDateParams {
  travel_date_raw: string;
}

export interface SearchAddressesParams {
  user_query: string;
}

export interface GeneralProviderQuestionParams {
  question: string;
}

export interface GeocodedLocation {
  lat: number;
  lng: number;
  formatted_address: string;
  display_name?: string;
  /** The locality Google itself assigned to the matched place; null when it returns none. */
  city?: string | null;
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
        source_city: {
          type: "string",
          description: "The city the rider named for the pickup, when they named one. Omit otherwise.",
        },
        destination_city: {
          type: "string",
          description: "The city the rider named for the destination, when they named one. Omit otherwise.",
        },
      },
      required: ["source_address", "destination_address"],
    },
  },
  {
    name: "find_providers",
    description: `Find the providers that can physically serve a one-way or round trip.
The server resolves the verbatim date phrase in America/Los_Angeles, then filters by service area and service hours — the two things it can compute exactly. It does NOT judge eligibility.

Only the travel date and outbound time are required to search. Do not gather eligibility facts before calling: run the search with whatever the rider has already said and pass null for the rest.

The result returns "candidates": every provider whose service area covers both ends of the trip and whose hours include the requested times. Each candidate carries its verbatim eligibility_requirement and service_area_cities. Read those and decide for yourself who the rider qualifies for — you know, for instance, which communities are in Contra Costa County, which a fixed list of city names never will.

Then call assess_eligibility with a verdict for every candidate. Nothing is shown to the rider as a callable option until you do.

The result also carries:
- alternatives: variations that would work when the trip as asked does not (another day, a different time, one way instead of round trip, or partial coverage). Offer them as possibilities.
- diagnostics.providers_without_service_hours: providers whose operating hours are not on file. Their times were not actually checked, so tell the rider to confirm the time rather than presenting it as available.`,
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
          description:
            "Only facts the rider has actually stated. Omit anything unknown rather than guessing — the search runs with gaps and tells you which fact matters most. Never convert a self-description into a number.",
          properties: {
            age: {
              type: "number",
              description:
                'The rider\'s exact age in years, only if they stated it. Omit when they said something like "senior" or "elderly" without a number.',
            },
            disabled: {
              type: "boolean",
              description:
                "Only when the rider states they have a disability or a qualifying condition. Describing a difficulty is not a disability claim: \"my balance is bad\", \"I can't manage the stairs\", \"I gave up driving\", \"I use a walker\" all mean this is still UNKNOWN — omit it and let the search report that it needs confirming. Setting it from an inference makes the rider eligible for services that may turn them away.",
            },
            ada_certified: {
              type: "boolean",
              description:
                "Only when the rider says they hold ADA paratransit certification. Having a disability is not certification — it requires a separate application. Omit when unstated.",
            },
            veteran: { type: "boolean", description: "Only from the rider's explicit answer; omit when unstated" },
            residence_city: { type: "string", description: "Omit when unknown" },
            declined: {
              type: "boolean",
              description: "True when the rider has said they do not want to answer eligibility questions. Stops further eligibility questions.",
            },
          },
          required: [],
        },
        source_city: {
          type: "string",
          description:
            "The city the rider named for the pickup, in their own words, when they named one. The server compares it against the city the address actually geocoded to and stops if they disagree, so a rider is never sent to the right street name in the wrong town. Omit when the rider named no city.",
        },
        destination_city: {
          type: "string",
          description: "The city the rider named for the destination, when they named one. Omit otherwise.",
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
    name: "assess_eligibility",
    description: `Record your eligibility verdict for every candidate returned by find_providers.
Call this immediately after find_providers, before writing your answer. The rider's provider cards are built from what you record here, so a candidate you leave out is a ride the rider never hears about — the server rejects the call if any candidate is missing.

For each candidate, read its eligibility_requirement against the rider facts you actually have:
- "eligible" — the available facts match the listed requirements. This is an internal screening verdict; rider-facing answers must still say they may qualify or could be eligible because only the provider makes the final determination.
- "ineligible" — the rider plainly fails it. Requires a fact you actually have; never infer one.
- "verification_required" — you cannot tell yet. Name the single rider fact that would settle it in missing_fact, or leave missing_fact null when no answer from the rider would help and only the provider can confirm.

Requirements name their own thresholds ("Senior (55+)", "Senior (65+)"), so an exact age decides them and a self-description like "senior" does not. Judge residency requirements on what you know about the region: someone living in Alamo or Rodeo is a Contra Costa County resident.`,
    input_schema: {
      type: "object" as const,
      properties: {
        assessments: {
          type: "array",
          description: "One entry per candidate from the most recent find_providers result.",
          items: {
            type: "object" as const,
            properties: {
              provider_name: {
                type: "string",
                description: "The candidate's provider_name, copied exactly as the search returned it",
              },
              verdict: {
                type: "string",
                enum: ["eligible", "ineligible", "verification_required"],
                description: "Your verdict for this rider and this provider",
              },
              reason: {
                type: "string",
                description:
                  "One short sentence a rider could hear, saying what decided it — the rule and the fact it turned on.",
              },
              missing_fact: {
                type: "string",
                enum: ["age", "disabled", "ada_certified", "veteran", "residence_city"],
                description:
                  "For verification_required only: the one rider fact that would settle this. Omit when no rider answer would help.",
              },
            },
            required: ["provider_name", "verdict", "reason"],
          },
        },
      },
      required: ["assessments"],
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
 * The city Google assigned to a matched place.
 *
 * Unincorporated communities come back as `sublocality` or `neighborhood` rather than `locality`
 * — Alamo and Rodeo among them — so those are accepted as a fallback rather than reported as
 * having no city at all.
 */
function localityOf(place: {
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
}): string | null {
  const components = place.addressComponents;
  if (!Array.isArray(components)) return null;
  for (const type of ["locality", "sublocality", "neighborhood", "administrative_area_level_3"]) {
    const match = components.find((component) => component.types?.includes(type));
    if (match?.longText) return match.longText;
  }
  return null;
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
      // addressComponents carries Google's own locality for the matched place. That is what the
      // rider's stated city is checked against, so no list of Bay Area city names is needed.
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.location,places.addressComponents",
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
        city: localityOf(place),
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

/**
 * Geocode both ends, and stop if either landed in a different city than the rider named.
 *
 * A rider sent to the right street name in the wrong town misses their appointment, so this
 * stays a hard gate. What changed is where the two city names come from: the rider's city is
 * reported by the assistant from the rider's own words, and the resolved city is Google's
 * locality for the matched place. Comparing two authoritative strings needs no gazetteer, and
 * cannot repeat the old failure where "Danville" resolving to "2601 San Ramon Valley Blvd,
 * Danville" was reported as a San Ramon mismatch and the search abandoned.
 */
async function resolveTripLocations(
  sourceAddress: string,
  destinationAddress: string,
  googleMapsApiKey: string,
  statedCities: { source?: string | null; destination?: string | null } = {},
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

  const mismatched = [
    { end: "pickup", stated: statedCities.source, place: source, requested: sourceAddress },
    { end: "destination", stated: statedCities.destination, place: destination, requested: destinationAddress },
  ].find((candidate) => !citiesMatch(candidate.stated, candidate.place.city));

  if (mismatched) {
    return {
      ok: false,
      clarification: {
        status: "clarification_required",
        reason_code: "location_city_mismatch",
        message:
          `“${mismatched.requested}” resolved to ${mismatched.place.formatted_address}, which is in ` +
          `${mismatched.place.city}, not ${mismatched.stated}. Please confirm the ${mismatched.end} before I search providers.`,
        requested_source: sourceAddress,
        requested_destination: destinationAddress,
        resolved_source: source.formatted_address,
        resolved_destination: destination.formatted_address,
      },
    };
  }

  return { ok: true, source, destination };
}

/**
 * Every provider in the system, rendered for the system prompt.
 *
 * There are thirty of them and the whole roster costs a few thousand tokens, so the assistant
 * can simply read it. That removes the last reason to look a provider up by name: the previous
 * `get_provider_info` tool matched with `ilike %query%`, so a rider asking about the "San Ramon
 * Senior Express Van" found nothing — the row is named "Senior Express Van (San Ramon)" — and
 * the assistant reported, wrongly, that OPTIMAT had never heard of it.
 *
 * Service areas are excluded: they are megabytes of polygon, and the only question anyone asks
 * of them ("does this cover the trip?") is answered by find_providers.
 */
export async function loadProviderRoster(supabase: DatabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from(TABLES.PROVIDERS)
    .select(PROVIDER_SEARCH_COLUMNS.replace(",service_zone", ""))
    .order("provider_name");
  if (error) throw new Error(`Database error: ${error.message}`);

  const rows = (data || []) as unknown as Provider[];
  const lines = rows.map((provider) => {
    const requirement = requirementText(provider.eligibility_reqs) || "none stated";
    const cities = Array.isArray(provider.service_area_cities) && provider.service_area_cities.length > 0
      ? (provider.service_area_cities as string[]).join(", ")
      : "not listed";
    const booking = provider.booking && typeof provider.booking === "object"
      ? Object.values(provider.booking as Record<string, unknown>).filter(Boolean).join(" ")
      : "";
    const fare = provider.fare && typeof provider.fare === "object"
      ? String((provider.fare as Record<string, unknown>).cost ?? "")
      : "";
    return [
      `- ${provider.provider_name} (${provider.provider_type || "type unknown"})`,
      `  eligibility: ${requirement}`,
      `  serves: ${cities}`,
      booking ? `  booking: ${booking}` : "",
      fare ? `  fare: ${fare}` : "",
    ].filter(Boolean).join("\n");
  });

  return [
    `All ${rows.length} providers in OPTIMAT's system, in full. This is the complete list — a service that is not here is one OPTIMAT does not have data on, and a service that is here exists no matter how the rider phrases its name.`,
    ...lines,
  ].join("\n");
}

async function loadProviderSearchRows(supabase: DatabaseClient): Promise<Provider[]> {
  const { data, error } = await supabase.from(TABLES.PROVIDERS).select(PROVIDER_SEARCH_COLUMNS);
  if (error) throw new Error(`Database error: ${error.message}`);
  return (data || []) as unknown as Provider[];
}

function parsedServiceZone(provider: Provider): {
  type: string;
  coordinates?: number[][][] | number[][][][];
  features?: unknown[];
  geometry?: unknown;
} | null {
  if (!provider.service_zone) return null;
  let serviceZone = provider.service_zone;
  if (typeof serviceZone === "string") {
    try {
      serviceZone = JSON.parse(serviceZone);
    } catch {
      return null;
    }
  }
  return serviceZone as ReturnType<typeof parsedServiceZone>;
}

export interface GeographyPartition {
  /** Service area contains both trip ends — the only providers that can serve the trip. */
  both: Provider[];
  /** Contains the pickup but not the destination. */
  originOnly: Provider[];
  /** Contains the destination but not the pickup. */
  destinationOnly: Provider[];
}

/**
 * Split providers by which ends of the trip their service area covers.
 *
 * The partial buckets are what make "no providers" explainable: a rider going from Pleasant Hill
 * to San Francisco can be told which provider covers the Pleasant Hill end, instead of only that
 * nothing matched.
 */
export function partitionByGeography(
  providers: Provider[],
  source: GeocodedLocation,
  destination: GeocodedLocation,
): GeographyPartition {
  const partition: GeographyPartition = { both: [], originOnly: [], destinationOnly: [] };
  for (const provider of providers) {
    const zone = parsedServiceZone(provider);
    if (!zone) continue;
    const coversOrigin = isPointInPolygon(source.lat, source.lng, zone);
    const coversDestination = isPointInPolygon(destination.lat, destination.lng, zone);
    if (coversOrigin && coversDestination) partition.both.push(provider);
    else if (coversOrigin) partition.originOnly.push(provider);
    else if (coversDestination) partition.destinationOnly.push(provider);
  }
  return partition;
}

function geographyMatches(
  providers: Provider[],
  source: GeocodedLocation,
  destination: GeocodedLocation,
): Provider[] {
  return partitionByGeography(providers, source, destination).both;
}

/** True when the provider has any usable service-hours data. Most rows currently do not. */
export function hasServiceHours(provider: Provider): boolean {
  let serviceHours = provider.service_hours;
  if (typeof serviceHours === "string") {
    try {
      serviceHours = JSON.parse(serviceHours);
    } catch {
      return false;
    }
  }
  if (!serviceHours || typeof serviceHours !== "object") return false;
  const hoursList = "hours" in serviceHours
    ? (serviceHours as { hours?: unknown[] }).hours
    : null;
  return Array.isArray(hoursList) && hoursList.length > 0;
}

function isDirectRideProvider(provider: Provider): boolean {
  const providerType = String(provider.provider_type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return providerType !== "fixedroute";
}

/**
 * Render the eligibility_reqs column as the sentence a person would read.
 *
 * Formatting only — it draws no conclusions. The column holds prose for most rows and a JSON
 * list of rule objects for a few older ones, and separate rules are alternatives, so they are
 * joined with "or".
 */
export function requirementText(requirements: unknown): string {
  if (requirements === null || requirements === undefined) return "";
  if (typeof requirements === "string") {
    const trimmed = requirements.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        return requirementText(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(requirements)) {
    return requirements.map(requirementText).filter(Boolean).join(" or ");
  }
  if (typeof requirements === "object") {
    const record = requirements as Record<string, unknown>;
    const nested = record.eligibility ?? record.eligibility_text ?? record.eligibility_reqs;
    if (nested !== undefined && nested !== null) return requirementText(nested);
    if (typeof record.type === "string" && record.type.trim()) return record.type.trim();
    return JSON.stringify(record);
  }
  return String(requirements);
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
      // The requirement verbatim, which is what the assistant reasons over. The server no longer
      // reduces this to a verdict — see the note at the top of trip.ts.
      eligibility_requirement: requirementText(provider.eligibility_reqs) || "None stated",
      // The cities the provider actually serves, so a residency rule can be judged against data
      // rather than against a hand-written list of town names.
      service_area_cities: provider.service_area_cities,
      eligibility_status: provider.eligibility_status,
      eligibility_reason: provider.eligibility_reason,
      // Which rider fact would settle an unconfirmed provider, so the assistant can say what it
      // needs rather than repeating a generic "verify with the provider".
      missing_facts: Array.isArray(provider.missing_facts) && provider.missing_facts.length > 0
        ? provider.missing_facts
        : undefined,
      service_hours_known: hasServiceHours(provider as Provider) || undefined,
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
      { source: params.source_city, destination: params.destination_city },
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

// ─── Search core ────────────────────────────────────────────────────────────

export interface SearchContext {
  /** Direct-ride providers only; fixed-route agencies are handled as public transit. */
  directProviders: Provider[];
  totalProviderCount: number;
  source: GeocodedLocation;
  destination: GeocodedLocation;
}

/**
 * What one turn's tool calls need to pass to each other.
 *
 * assess_eligibility grades the candidates find_providers just produced, so the candidate set
 * has to survive between the two calls without a round trip through the database.
 */
export interface TurnContext {
  lastSearch: {
    candidates: Record<string, unknown>[];
    result: Record<string, unknown>;
  } | null;
}

export function emptyTurnContext(): TurnContext {
  return { lastSearch: null };
}

export interface SearchStageParams {
  travel_date: string;
  departure_time: string;
  return_time?: string | null;
  trip_type: TripType;
}

export interface StagedSearch {
  geography: GeographyPartition;
  /** Service area covers both ends and the hours include the requested times. */
  candidates: Provider[];
}

function filterBySchedule(providers: Provider[], params: SearchStageParams): Provider[] {
  return providers.filter((provider) =>
    isTimeWithinServiceHours(
      provider,
      params.departure_time,
      params.trip_type === "round_trip" ? params.return_time || undefined : undefined,
      params.travel_date,
    )
  );
}

/**
 * Run the filter pipeline once and keep every stage's output.
 *
 * Both stages are computation the assistant could not do for itself: ray-casting a point against
 * an 80KB service-area MultiPolygon, and clock arithmetic against a weekday bitmask. Eligibility
 * used to be a third stage here and is now the assistant's, via assess_eligibility.
 *
 * Extracted from the tool wrapper so relaxation variants can re-run it against already-loaded
 * providers and already-geocoded endpoints — a variant costs pure computation, no extra API calls.
 */
export function searchProviders(context: SearchContext, params: SearchStageParams): StagedSearch {
  const geography = partitionByGeography(context.directProviders, context.source, context.destination);
  return { geography, candidates: filterBySchedule(geography.both, params) };
}

export interface SearchAlternative {
  change: string;
  description: string;
  providers: string[];
  count: number;
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MAX_ALTERNATIVES = 6;
const MAX_ALTERNATIVE_PROVIDERS = 5;

function providerNames(providers: Provider[]): string[] {
  return providers
    .slice(0, MAX_ALTERNATIVE_PROVIDERS)
    .map((provider) => String(provider.provider_name || "Unnamed provider"));
}

function formatClock(hhmm: string): string {
  const minutes = parseTimeToMinutes(hhmm);
  if (minutes === null) return hhmm;
  const hours = Math.floor(minutes / 60);
  const suffix = hours < 12 || hours === 24 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  const mins = minutes % 60;
  return `${display}${mins ? `:${String(mins).padStart(2, "0")}` : ""} ${suffix}`;
}

/** "Monday-Thursday 9:30 AM-3 PM", from the provider's own service_hours entries. */
function describeServiceHours(provider: Provider): string | null {
  let serviceHours = provider.service_hours;
  if (typeof serviceHours === "string") {
    try {
      serviceHours = JSON.parse(serviceHours);
    } catch {
      return null;
    }
  }
  const entries = (serviceHours as { hours?: Array<{ day?: string; start?: string; end?: string }> })?.hours;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const parts: string[] = [];
  for (const entry of entries.slice(0, 3)) {
    const mask = entry.day || "1111111";
    const days: string[] = [];
    let runStart = -1;
    for (let index = 0; index <= 7; index++) {
      const active = index < 7 && mask[index] === "1";
      if (active && runStart === -1) runStart = index;
      if (!active && runStart !== -1) {
        const end = index - 1;
        days.push(runStart === end ? DAY_NAMES[runStart] : `${DAY_NAMES[runStart]}-${DAY_NAMES[end]}`);
        runStart = -1;
      }
    }
    if (days.length === 0) continue;
    parts.push(`${days.join(", ")} ${formatClock(entry.start || "0000")}-${formatClock(entry.end || "2400")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function shiftTime(time: string, deltaMinutes: number): string | null {
  const minutes = parseTimeToMinutes(time);
  if (minutes === null) return null;
  const shifted = minutes + deltaMinutes;
  if (shifted < 0 || shifted > 24 * 60) return null;
  const hours = Math.floor(shifted / 60) % 24;
  const suffix = hours < 12 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(shifted % 60).padStart(2, "0")} ${suffix}`;
}

/** Substitute one calendar day, keeping the same weekday semantics the schedule filter uses. */
function dateForWeekday(travelDate: string, targetDayIndex: number): string | null {
  const currentDayIndex = getDayIndexFromDate(travelDate);
  if (currentDayIndex === null) return null;
  const match = travelDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const delta = (targetDayIndex - currentDayIndex + 7) % 7;
  if (delta === 0) return travelDate;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Find bounded variations of a failed or thin search that would return providers.
 *
 * Every variant is a possibility to offer the rider, never a booking: the point is to replace
 * "I couldn't find anything" with "nothing works as asked, but here is what would."
 *
 * Runs only when the primary search is empty or thin. Each variant reuses the loaded provider
 * rows and geocoded endpoints, so the whole set costs no additional network calls.
 */
export function relaxSearch(
  context: SearchContext,
  params: SearchStageParams,
  primary: StagedSearch,
): SearchAlternative[] {
  const alternatives: SearchAlternative[] = [];
  const add = (alternative: SearchAlternative) => {
    if (alternatives.length >= MAX_ALTERNATIVES) return;
    if (alternative.count === 0) return;
    alternatives.push(alternative);
  };

  // Geography is the one constraint no change of date, time, or eligibility can relax, so when
  // it fails the useful answer is which end of the trip is reachable at all.
  if (primary.geography.both.length === 0) {
    if (primary.geography.originOnly.length > 0) {
      add({
        change: "partial_coverage_origin",
        description: `covers the pickup area but not the destination — could take the rider part of the way`,
        providers: providerNames(primary.geography.originOnly),
        count: primary.geography.originOnly.length,
      });
    }
    if (primary.geography.destinationOnly.length > 0) {
      add({
        change: "partial_coverage_destination",
        description: `serves the destination area but does not reach the pickup point`,
        providers: providerNames(primary.geography.destinationOnly),
        count: primary.geography.destinationOnly.length,
      });
    }
    return alternatives;
  }

  // Providers that could serve the trip geographically but were dropped on the requested day or
  // time. Reported even when other providers did match: a rider offered one option is still owed
  // "this other service would work on Monday" rather than silence about why it vanished.
  const scheduleExcluded = primary.geography.both.filter(
    (provider) => !primary.candidates.includes(provider),
  );

  if (scheduleExcluded.length > 0) {
    const requestedDayIndex = getDayIndexFromDate(params.travel_date);
    const workingDays: string[] = [];
    const dayProviders = new Set<string>();
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      if (dayIndex === requestedDayIndex) continue;
      const candidateDate = dateForWeekday(params.travel_date, dayIndex);
      if (!candidateDate) continue;
      const matches = filterBySchedule(scheduleExcluded, { ...params, travel_date: candidateDate });
      if (matches.length > 0) {
        workingDays.push(DAY_NAMES[dayIndex]);
        for (const name of providerNames(matches)) dayProviders.add(name);
      }
    }
    if (workingDays.length > 0) {
      add({
        change: "other_day",
        description: `the same trip is inside service hours on ${workingDays.join(", ")}`,
        providers: [...dayProviders].slice(0, MAX_ALTERNATIVE_PROVIDERS),
        count: dayProviders.size,
      });
    }

    for (const delta of [-120, -60, 60, 120]) {
      const shifted = shiftTime(params.departure_time, delta);
      if (!shifted) continue;
      const matches = filterBySchedule(scheduleExcluded, { ...params, departure_time: shifted });
      if (matches.length > 0) {
        add({
          change: "shift_time",
          description: `leaving at ${shifted} instead is inside service hours`,
          providers: providerNames(matches),
          count: matches.length,
        });
        break;
      }
    }

    // A round trip can fail purely on the return leg; the outbound may be servable on its own.
    if (params.trip_type === "round_trip" && params.return_time) {
      const outboundOnly = filterBySchedule(scheduleExcluded, { ...params, trip_type: "one_way" });
      if (outboundOnly.length > 0) {
        add({
          change: "one_way_instead",
          description: `the outbound leg alone is inside service hours — the return time is what falls outside`,
          providers: providerNames(outboundOnly),
          count: outboundOnly.length,
        });
      }
    }

    // Whatever the variants above did or did not find, a provider excluded on schedule can always
    // be explained by stating its own hours. Searching a grid of nearby days and times misses the
    // common case where both need to change at once: a 7am Sunday request against a service that
    // runs Monday-Thursday from 9:30am is outside every variant, yet trivially explainable.
    for (const provider of scheduleExcluded) {
      const window = describeServiceHours(provider);
      if (!window) continue;
      add({
        change: "provider_schedule",
        description: `${provider.provider_name} serves this trip, but only ${window}`,
        providers: [String(provider.provider_name || "Unnamed provider")],
        count: 1,
      });
    }
  }

  // The "which eligibility category would unlock providers" variant used to live here. It worked
  // by re-running the parser against five invented riders (age 60, age 65, disabled, ADA-certified,
  // veteran) — thresholds that came from the code rather than from any provider's rule, so it
  // could suggest "a rider aged 60 or older would qualify" for a service whose actual floor is 55.
  // The assistant reads each candidate's real requirement text and can say this accurately.

  return alternatives;
}

/** Execute the full provider search after coverage and required trip fields are known. */
export async function executeFindProviders(
  params: FindProvidersParams,
  supabase: DatabaseClient,
  googleMapsApiKey: string,
  turn: TurnContext = emptyTurnContext(),
): Promise<ToolResult> {
  try {
    const locations = await resolveTripLocations(
      params.source_address,
      params.destination_address,
      googleMapsApiKey,
      { source: params.source_city, destination: params.destination_city },
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

    // An unknown rider fact no longer stops the search. Providers it would decide come back as
    // needing verification with the fact named, so the rider always gets a list plus one
    // well-chosen question instead of an interrogation before any results.
    const rider = params.rider_eligibility || {};
    const context: SearchContext = {
      directProviders,
      totalProviderCount: providers.length,
      source: locations.source,
      destination: locations.destination,
    };
    const stageParams: SearchStageParams = {
      travel_date: resolvedDate.iso,
      departure_time: params.departure_time,
      return_time: params.return_time,
      trip_type: params.trip_type,
    };
    const staged = searchProviders(context, stageParams);
    const geographyProviders = staged.geography.both;
    const scheduleProviders = staged.candidates;

    const withMatchCriteria = (provider: Provider): Provider => ({
      ...provider,
      match_criteria: {
        algorithm: "Both trip points are inside the service area; the provider operates on the requested date/time; rider eligibility is evaluated before recommendation.",
        passed: [
          { label: "Origin inside service area", detail: locations.source.formatted_address },
          { label: "Destination inside service area", detail: locations.destination.formatted_address },
          {
            label: hasServiceHours(provider)
              ? "Service hours include requested trip window"
              : "Service hours are not on file — confirm the time with the provider",
            detail: params.trip_type === "round_trip"
              ? `${resolvedDate.display}; outbound ${params.departure_time}; return ${params.return_time}`
              : `${resolvedDate.display}; one-way outbound ${params.departure_time}`,
          },
        ],
      },
    } as Provider);

    const candidates = staged.candidates.map(withMatchCriteria);

    // Relaxation runs only when the answer is empty or thin, where the cost of an extra pass is
    // worth being able to say what would work instead.
    const alternatives = candidates.length <= 1
      ? relaxSearch(context, stageParams, staged)
      : [];

    const providersWithoutHours = candidates.filter((provider) => !hasServiceHours(provider)).length;

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
      // Deliberately not called `data`: the frontend renders provider cards from a `data` array,
      // and these are not results yet. They become results once assess_eligibility records a
      // verdict for each of them.
      candidates: candidates.map(compactProvider),
      candidate_count: candidates.length,
      next_step: candidates.length > 0
        ? "Read each candidate's eligibility_requirement against the rider facts, then call assess_eligibility with a verdict for every candidate listed here."
        : "No provider can serve this trip as asked. Explain why using binding_constraint and offer any alternatives.",
      alternatives,
      rider_eligibility: rider,
      source_address: locations.source.formatted_address,
      destination_address: locations.destination.formatted_address,
      source_coordinates: { lat: locations.source.lat, lng: locations.source.lng },
      destination_coordinates: { lat: locations.destination.lat, lng: locations.destination.lng },
      public_transit_available: publicTransitAvailable,
      binding_constraint: candidates.length > 0
        ? null
        : geographyProviders.length === 0
          ? "geography"
          : "schedule",
      diagnostics: {
        provider_count: directProviders.length,
        fixed_route_fallback_count: providers.length - directProviders.length,
        geography_match_count: geographyProviders.length,
        geography_origin_only_count: staged.geography.originOnly.length,
        geography_destination_only_count: staged.geography.destinationOnly.length,
        schedule_match_count: scheduleProviders.length,
        candidate_count: candidates.length,
        // Some provider rows still carry no service hours, so the schedule filter passed them
        // through unchecked. The rider must be told the time is unconfirmed, not that it works.
        providers_without_service_hours: providersWithoutHours,
        alternatives_found: alternatives.length,
      },
      public_transit: transitData,
    };

    const serializedSize = JSON.stringify(result).length;
    console.log("find_providers compact result size", {
      bytes: serializedSize,
      candidates: candidates.length,
    });
    if (serializedSize > 100_000) {
      return {
        success: false,
        error: "Provider result exceeded the safe response limit after compaction.",
      };
    }

    turn.lastSearch = { candidates: result.candidates, result };

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
 * Names differ only by punctuation, case and spacing, so compare on letters and digits alone.
 * This is the one place a provider name is still matched, and it matches against the candidate
 * set from the search rather than against the whole table.
 */
function nameKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The rider fact that would settle the most undecided candidates. Counting, not interpretation. */
function questionFromAssessments(
  assessments: EligibilityAssessment[],
  rider: RiderEligibility,
): { field: RiderFact; why: string; candidates_if_known: number; provider_names: string[] } | null {
  if (rider.declined) return null;
  const known: Record<RiderFact, boolean> = {
    age: Number.isFinite(rider.age),
    disabled: typeof rider.disabled === "boolean",
    ada_certified: typeof rider.ada_certified === "boolean",
    veteran: typeof rider.veteran === "boolean",
    residence_city: Boolean(rider.residence_city?.trim()),
  };

  const byField = new Map<RiderFact, string[]>();
  for (const assessment of assessments) {
    const field = assessment.missing_fact;
    if (!field || !RIDER_FACTS.includes(field) || known[field]) continue;
    const names = byField.get(field) || [];
    if (!names.includes(assessment.provider_name)) names.push(assessment.provider_name);
    byField.set(field, names);
  }
  if (byField.size === 0) return null;

  const best = [...byField.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return RIDER_FACTS.indexOf(a[0]) - RIDER_FACTS.indexOf(b[0]);
  })[0];
  const [field, names] = best;
  return {
    field,
    why: `${names.length} provider${names.length === 1 ? "" : "s"} on this trip (${names.join(", ")}) can only be decided once this is known`,
    candidates_if_known: names.length,
    provider_names: names,
  };
}

/**
 * Record the assistant's eligibility verdicts and assemble the rider-facing result.
 *
 * The server no longer decides eligibility, but it still guarantees the thing that protects the
 * rider: every candidate the search found gets a verdict. A provider left out of the assessment
 * is a ride nobody mentions, so an incomplete call is rejected and the assistant retries with
 * the missing names in hand.
 */
export function executeAssessEligibility(
  params: AssessEligibilityParams,
  turn: TurnContext,
): ToolResult {
  const search = turn.lastSearch;
  if (!search) {
    return {
      success: false,
      error: "No provider search to assess. Call find_providers first, then assess its candidates.",
    };
  }

  const assessments = Array.isArray(params.assessments) ? params.assessments : [];
  const byKey = new Map(search.candidates.map((provider) => [nameKey(provider.provider_name), provider]));
  const candidateNames = search.candidates.map((provider) => String(provider.provider_name));

  const unknown = assessments
    .map((assessment) => assessment.provider_name)
    .filter((name) => !byKey.has(nameKey(name)));
  if (unknown.length > 0) {
    return {
      success: false,
      error: `These are not candidates from the last search: ${unknown.join(", ")}.`,
      data: { candidates: candidateNames },
    };
  }

  const assessed = new Set(assessments.map((assessment) => nameKey(assessment.provider_name)));
  const missing = candidateNames.filter((name) => !assessed.has(nameKey(name)));
  if (missing.length > 0) {
    return {
      success: false,
      error:
        `Every candidate needs a verdict; these were left out: ${missing.join(", ")}. ` +
        `A provider with no verdict is never shown to the rider.`,
      data: { candidates: candidateNames },
    };
  }

  const buckets: Record<EligibilityStatus, Record<string, unknown>[]> = {
    eligible: [],
    verification_required: [],
    ineligible: [],
  };
  const undecided: EligibilityAssessment[] = [];

  for (const assessment of assessments) {
    const provider = byKey.get(nameKey(assessment.provider_name))!;
    const verdict: EligibilityStatus = assessment.verdict === "eligible" || assessment.verdict === "ineligible"
      ? assessment.verdict
      : "verification_required";
    const missingFact = verdict === "verification_required" && assessment.missing_fact &&
        RIDER_FACTS.includes(assessment.missing_fact)
      ? [assessment.missing_fact]
      : undefined;
    if (verdict === "verification_required") undecided.push({ ...assessment, verdict });
    buckets[verdict].push({
      ...provider,
      eligibility_status: verdict,
      eligibility_reason: assessment.reason,
      ...(missingFact ? { missing_facts: missingFact } : {}),
    });
  }

  const rider = (search.result.rider_eligibility || {}) as RiderEligibility;
  const question = questionFromAssessments(undecided, rider);
  const eligible = buckets.eligible;
  const verification = buckets.verification_required;

  return {
    success: true,
    data: {
      ...search.result,
      status: "complete",
      // The frontend renders cards from `data`, so this is where the result becomes rider-facing.
      data: eligible,
      verification_required: verification,
      excluded_providers: buckets.ineligible.map((provider) => ({
        provider_name: provider.provider_name,
        stage: "eligibility",
        reason: provider.eligibility_reason,
        requirement: provider.eligibility_requirement,
      })),
      candidates: undefined,
      next_step: undefined,
      next_question: question,
      total_found: eligible.length,
      direct_provider_count: eligible.length,
      total_options_found: eligible.length + (search.result.public_transit_available ? 1 : 0),
      binding_constraint: eligible.length > 0 ? null : buckets.ineligible.length > 0 ? "eligibility" : null,
      diagnostics: {
        ...(search.result.diagnostics as Record<string, number>),
        eligible_match_count: eligible.length,
        verification_required_count: verification.length,
        ineligible_count: buckets.ineligible.length,
      },
    },
  };
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
  googleMapsApiKey: string,
  turn: TurnContext = emptyTurnContext(),
): Promise<ToolResult> {
  switch (toolName) {
    case "resolve_trip_date":
      return executeResolveTripDate(toolInput as ResolveTripDateParams);

    case "check_trip_coverage":
      return executeCheckTripCoverage(toolInput as CheckTripCoverageParams, supabase, googleMapsApiKey);

    case "find_providers":
      return executeFindProviders(toolInput as FindProvidersParams, supabase, googleMapsApiKey, turn);

    case "search_addresses_from_user_query":
      return executeSearchAddresses(toolInput as SearchAddressesParams, googleMapsApiKey);

    case "assess_eligibility":
      return executeAssessEligibility(toolInput as AssessEligibilityParams, turn);

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
      case "assess_eligibility":
      case "find_providers": {
        const resultRecord = toolResult.data as Record<string, unknown> | undefined;
        const { error } = await supabase.from(TABLES.FIND_PROVIDERS_CALLS).insert({
          conversation_id: conversationId,
          // assess_eligibility carries the addresses in its result rather than its input, since
          // its input is the verdict list.
          source_address: input.source_address ?? resultRecord?.source_address,
          destination_address: input.destination_address ?? resultRecord?.destination_address,
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
