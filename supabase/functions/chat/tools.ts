/**
 * Tool definitions and execution logic for the OPTIMAT chat service.
 * Implements the three core tools: find_providers, search_addresses, get_provider_info
 *
 * Note: All tables are in the 'optimat' schema.
 */

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { TABLES } from "../_shared/supabase.ts";

// Types for tool parameters and results
export interface FindProvidersParams {
  source_address: string;
  destination_address: string;
  departure_time: string;
  return_time: string;
  travel_date?: string;
  schedule_type?: string;
  provider_type?: string;
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
}

export interface Provider {
  id: number;
  name: string;
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
    name: "find_providers",
    description: `Find paratransit providers that can serve a round trip between origin and destination.
Filters providers to only those operating during both the departure and return times.

Before calling this tool, ensure you have asked the user for:
1. Their eligibility context (age/senior status, disability or ADA certification, veteran status, and relevant residency)
2. What time they want to be picked up (departure_time)
3. What time they want to return (return_time)`,
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
            'The time the user wants to be picked up (e.g., "9:00 AM", "14:30"). Required.',
        },
        return_time: {
          type: "string",
          description:
            'The time the user wants to return back home (e.g., "5:00 PM", "17:00"). Required.',
        },
        travel_date: {
          type: "string",
          description:
            'Optional travel date to check day-of-week availability (e.g., "2024-12-05")',
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
      required: ["source_address", "destination_address", "departure_time", "return_time"],
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
function parseTimeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;

  let str = timeStr.trim().toUpperCase();
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
      const date = new Date(year, month - 1, day);
      return date.getDay() === 0 ? 6 : date.getDay() - 1; // Convert Sunday=0 to Monday=0 format
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
  googleMapsApiKey: string
): Promise<Record<string, unknown> | null> {
  try {
    const params = new URLSearchParams({
      origin,
      destination,
      mode: "transit",
      transit_routing_preference: "less_walking",
      key: googleMapsApiKey,
    });

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
          vehicle?: { type?: string; name?: string };
        };
        departure_stop?: { name?: string };
        arrival_stop?: { name?: string };
        num_stops?: number;
      };
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
        departure_stop: step.transit_details.departure_stop?.name || null,
        arrival_stop: step.transit_details.arrival_stop?.name || null,
        num_stops: step.transit_details.num_stops ?? null,
      } : null,
    }));

    return {
      summary: route.summary || null,
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

/**
 * Execute the find_providers tool.
 */
export async function executeFindProviders(
  params: FindProvidersParams,
  supabase: SupabaseClient,
  googleMapsApiKey: string
): Promise<ToolResult> {
  try {
    // Geocode both addresses
    const [sourceLocation, destLocation] = await Promise.all([
      geocodeAddress(params.source_address, googleMapsApiKey),
      geocodeAddress(params.destination_address, googleMapsApiKey),
    ]);

    if (!sourceLocation) {
      return {
        success: false,
        error: `Could not geocode source address: ${params.source_address}`,
      };
    }

    if (!destLocation) {
      return {
        success: false,
        error: `Could not geocode destination address: ${params.destination_address}`,
      };
    }

    // Fetch all providers from the database (optimat schema)
    const { data: providers, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select("*");

    if (error) {
      return { success: false, error: `Database error: ${error.message}` };
    }

    // Filter providers by service zone (both source and destination must be in zone)
    const matchingProviders: Provider[] = [];

    for (const provider of providers || []) {
      if (provider.service_zone) {
        let serviceZone = provider.service_zone;
        if (typeof serviceZone === "string") {
          try {
            serviceZone = JSON.parse(serviceZone);
          } catch {
            continue;
          }
        }

        const sourceInZone = isPointInPolygon(sourceLocation.lat, sourceLocation.lng, serviceZone);
        const destInZone = isPointInPolygon(destLocation.lat, destLocation.lng, serviceZone);

        if (sourceInZone && destInZone) {
          matchingProviders.push({
            ...provider,
            match_criteria: {
              algorithm: "Geocode origin and destination, keep providers whose service zone contains both points, then keep providers operating at both requested times. Eligibility is returned for assistant reasoning and is not hard-filtered.",
              passed: [
                {
                  label: "Origin inside service area",
                  detail: sourceLocation.formatted_address,
                },
                {
                  label: "Destination inside service area",
                  detail: destLocation.formatted_address,
                },
              ],
              not_hard_filtered: ["eligibility"],
            },
          });
        }
      }
    }

    // Filter by service hours only. Eligibility requirements stay in the
    // provider payload so the assistant can reason from the full text.
    const filteredProviders = matchingProviders
      .filter((p) => isTimeWithinServiceHours(p, params.departure_time, params.return_time, params.travel_date))
      .map((p) => ({
        ...p,
        match_criteria: {
          ...(p.match_criteria as Record<string, unknown>),
          passed: [
            ...(((p.match_criteria as Record<string, unknown>)?.passed as unknown[]) || []),
            {
              label: "Service hours include requested trip window",
              detail: `Departure ${params.departure_time}; return ${params.return_time}`,
            },
          ],
        },
      }));

    // Prepare response without heavy service_zone data for LLM
    const sanitizedProviders = filteredProviders.map((p) => {
      const { service_zone, ...rest } = p;
      return rest;
    });

    // Fetch public transit routing information
    let transitData: Record<string, unknown> | null = null;
    try {
      transitData = await getTransitDirections(
        sourceLocation.formatted_address,
        destLocation.formatted_address,
        googleMapsApiKey
      );
    } catch (e) {
      console.warn("Failed to get transit directions:", e);
      // Continue without transit data
    }

    const result = {
      data: sanitizedProviders,
      source_address: sourceLocation.formatted_address,
      destination_address: destLocation.formatted_address,
      source_coordinates: { lat: sourceLocation.lat, lng: sourceLocation.lng },
      destination_coordinates: { lat: destLocation.lat, lng: destLocation.lng },
      total_found: sanitizedProviders.length,
      filtered_out_count: matchingProviders.length - filteredProviders.length,
      public_transit: transitData,
    };

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
      body: JSON.stringify({ textQuery: params.user_query }),
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
  supabase: SupabaseClient
): Promise<ToolResult> {
  try {
    // Search for provider by name (case-insensitive) - uses provider_name column in optimat schema
    const { data: providers, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select("*")
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

    // Return without heavy service_zone data
    const sanitizedProviders = providers.map((p) => {
      const { service_zone, ...rest } = p;
      return rest;
    });

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
    const searchQuery = `paratransit transportation ${params.question}`;

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
  supabase: SupabaseClient,
  googleMapsApiKey: string
): Promise<ToolResult> {
  switch (toolName) {
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
  supabase: SupabaseClient,
  conversationId: string,
  toolName: string,
  toolInput: unknown,
  toolResult: ToolResult
): Promise<void> {
  try {
    const input = toolInput as Record<string, unknown>;
    const timestamp = new Date().toISOString();

    switch (toolName) {
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
