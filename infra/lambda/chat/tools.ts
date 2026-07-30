/**
 * Tool definitions and execution logic for the OPTIMAT chat service.
 * Lambda version — uses raw SQL via pg instead of Supabase JS client.
 */

import { queryRows, TABLES } from '../_shared/db.js';
import { getApiKeys } from '../_shared/secrets.js';
import { calculateRoute, geocodePlace, searchPlaces } from '../_shared/location.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FindProvidersParams {
  source_address: string;
  destination_address: string;
  departure_time: string;
  return_time: string;
  travel_date?: string;
  eligibility_type?: string;
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

interface GeocodedLocation {
  lat: number;
  lng: number;
  formatted_address: string;
}

interface Provider {
  id: number;
  name: string;
  provider_type?: string;
  routing_type?: string;
  eligibility_reqs?: unknown;
  eligibility_requirements?: unknown;
  service_hours?: unknown;
  service_zone?: unknown;
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const toolDefinitions = [
  {
    name: 'find_providers',
    description: `Find paratransit providers that can serve a round trip between origin and destination.
Filters providers to only those operating during both the departure and return times.

Before calling this tool, ensure you have asked the user for:
1. Their eligibility context (age/senior status, disability or ADA certification, veteran status, and relevant residency)
2. What time they want to be picked up (departure_time)
3. What time they want to return (return_time)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        source_address: { type: 'string', description: 'The pickup/origin address' },
        destination_address: { type: 'string', description: 'The drop-off/destination address' },
        departure_time: { type: 'string', description: 'Pickup time (e.g., "9:00 AM")' },
        return_time: { type: 'string', description: 'Return time (e.g., "5:00 PM")' },
        travel_date: { type: 'string', description: 'Optional travel date (e.g., "2024-12-05")' },
        eligibility_type: {
          type: 'string',
          description: 'Optional user eligibility context for the assistant to reason from after providers are returned. This tool does not filter providers by eligibility.',
        },
        schedule_type: { type: 'string', description: 'Optional schedule type' },
        provider_type: { type: 'string', description: 'Optional provider type' },
      },
      required: ['source_address', 'destination_address', 'departure_time', 'return_time'],
    },
  },
  {
    name: 'search_addresses_from_user_query',
    description: "Find addresses from a user query using Amazon Location Service.",
    input_schema: {
      type: 'object' as const,
      properties: {
        user_query: { type: 'string', description: 'The search query for finding addresses' },
      },
      required: ['user_query'],
    },
  },
  {
    name: 'get_provider_info',
    description: 'Get detailed information about a specific transportation provider.',
    input_schema: {
      type: 'object' as const,
      properties: {
        provider_name: { type: 'string', description: 'The name of the provider' },
      },
      required: ['provider_name'],
    },
  },
  {
    name: 'general_provider_question',
    description: 'Search the web to answer general questions about transportation providers or paratransit services.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The transportation-related question' },
      },
      required: ['question'],
    },
  },
];

// ─── Helper Functions ───────────────────────────────────────────────────────

function parseTimeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;
  let str = timeStr.trim().toUpperCase();
  const isPM = str.includes('PM');
  const isAM = str.includes('AM');
  str = str.replace('PM', '').replace('AM', '').trim();

  try {
    let hours: number, minutes: number;
    if (str.includes(':')) {
      const parts = str.split(':');
      hours = parseInt(parts[0], 10);
      minutes = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    } else if (str.length === 4 && /^\d+$/.test(str)) {
      hours = parseInt(str.slice(0, 2), 10);
      minutes = parseInt(str.slice(2), 10);
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

function getDayIndexFromDate(dateStr: string): number | null {
  if (!dateStr) return null;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getDay() === 0 ? 6 : date.getDay() - 1;
  }
  return null;
}

function isTimeWithinServiceHours(
  provider: Provider,
  departureTime?: string,
  returnTime?: string,
  travelDate?: string
): boolean {
  if (!departureTime && !returnTime) return true;
  let serviceHours = provider.service_hours;
  if (!serviceHours) return true;
  if (typeof serviceHours === 'string') {
    try { serviceHours = JSON.parse(serviceHours); } catch { return true; }
  }
  const hoursList = (serviceHours as any)?.hours || [];
  if (hoursList.length === 0) return true;

  const dayIndex = travelDate ? getDayIndexFromDate(travelDate) : null;
  const depMinutes = departureTime ? parseTimeToMinutes(departureTime) : null;
  const retMinutes = returnTime ? parseTimeToMinutes(returnTime) : null;
  if (depMinutes === null && retMinutes === null) return true;

  for (const entry of hoursList) {
    const dayPattern = entry.day || '1111111';
    if (dayIndex !== null && dayPattern.length > dayIndex && dayPattern[dayIndex] !== '1') continue;

    const startMinutes = parseTimeToMinutes(entry.start || '0000');
    let endMinutes = parseTimeToMinutes(entry.end || '2400');
    if (startMinutes === null || endMinutes === null) continue;
    if (endMinutes < startMinutes) endMinutes += 24 * 60;

    let depOk = true, retOk = true;
    if (depMinutes !== null) {
      let d = depMinutes;
      if (d < startMinutes && endMinutes > 24 * 60) d += 24 * 60;
      depOk = startMinutes <= d && d <= endMinutes;
    }
    if (retMinutes !== null) {
      let r = retMinutes;
      if (r < startMinutes && endMinutes > 24 * 60) r += 24 * 60;
      retOk = startMinutes <= r && r <= endMinutes;
    }
    if (depOk && retOk) return true;
  }
  return false;
}

async function geocodeAddress(address: string, apiKey: string): Promise<GeocodedLocation | null> {
  try {
    const place = await geocodePlace(address);
    return place ? { lat: place.lat, lng: place.lng, formatted_address: place.address } : null;
  } catch (error) {
    console.error('Geocoding error:', error);
    return null;
  }
}

function isPointInPolygon(lat: number, lng: number, geometry: any): boolean {
  // Handle FeatureCollection — check if point is in ANY feature
  if (geometry.type === "FeatureCollection" && Array.isArray(geometry.features)) {
    return geometry.features.some((feature: any) => {
      if (feature.geometry) {
        return isPointInPolygon(lat, lng, feature.geometry);
      }
      return false;
    });
  }

  // Handle Feature — unwrap to geometry
  if (geometry.type === "Feature" && geometry.geometry) {
    return isPointInPolygon(lat, lng, geometry.geometry);
  }

  if (geometry.type === 'Polygon') {
    return isPointInSinglePolygon(lat, lng, geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      if (isPointInSinglePolygon(lat, lng, polygon)) return true;
    }
  }
  return false;
}

function isPointInSinglePolygon(lat: number, lng: number, coordinates: number[][][]): boolean {
  const ring = coordinates[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

async function getTransitDirections(origin: string, destination: string, apiKey: string) {
  try {
    return await calculateRoute(origin, destination, 'transit');
  } catch {
    return null;
  }
}

// ─── Tool Executors ─────────────────────────────────────────────────────────

async function executeFindProviders(params: FindProvidersParams, apiKey: string): Promise<ToolResult> {
  try {
    const [sourceLocation, destLocation] = await Promise.all([
      geocodeAddress(params.source_address, apiKey),
      geocodeAddress(params.destination_address, apiKey),
    ]);
    if (!sourceLocation) return { success: false, error: `Could not geocode source: ${params.source_address}` };
    if (!destLocation) return { success: false, error: `Could not geocode destination: ${params.destination_address}` };

    const providers = await queryRows(`SELECT * FROM ${TABLES.PROVIDERS}`);

    const matching: Provider[] = [];
    for (const p of providers) {
      let zone = p.service_zone;
      if (!zone) continue;
      if (typeof zone === 'string') { try { zone = JSON.parse(zone); } catch { continue; } }
      if (isPointInPolygon(sourceLocation.lat, sourceLocation.lng, zone) &&
          isPointInPolygon(destLocation.lat, destLocation.lng, zone)) {
        matching.push({
          ...p,
          match_criteria: {
            algorithm: 'Geocode origin and destination, keep providers whose service zone contains both points, then keep providers operating at both requested times. Eligibility is returned for assistant reasoning and is not hard-filtered.',
            passed: [
              { label: 'Origin inside service area', detail: sourceLocation.formatted_address },
              { label: 'Destination inside service area', detail: destLocation.formatted_address },
            ],
            not_hard_filtered: ['eligibility'],
          },
        });
      }
    }

    // Filter by service hours only. Eligibility requirements stay in the
    // provider payload so the assistant can reason from the full text.
    const filtered = matching
      .filter((p) => isTimeWithinServiceHours(p, params.departure_time, params.return_time, params.travel_date))
      .map((p) => ({
        ...p,
        match_criteria: {
          ...(p.match_criteria as Record<string, unknown>),
          passed: [
            ...(((p.match_criteria as Record<string, unknown>)?.passed as unknown[]) || []),
            {
              label: 'Service hours include requested trip window',
              detail: `Departure ${params.departure_time}; return ${params.return_time}`,
            },
          ],
        },
      }));

    const sanitized = filtered.map(({ service_zone, ...rest }) => rest);

    let transitData = null;
    try {
      transitData = await getTransitDirections(sourceLocation.formatted_address, destLocation.formatted_address, apiKey);
    } catch {}

    return {
      success: true,
      data: {
        data: sanitized,
        source_address: sourceLocation.formatted_address,
        destination_address: destLocation.formatted_address,
        source_coordinates: { lat: sourceLocation.lat, lng: sourceLocation.lng },
        destination_coordinates: { lat: destLocation.lat, lng: destLocation.lng },
        total_found: sanitized.length,
        filtered_out_count: matching.length - filtered.length,
        public_transit: transitData,
      },
    };
  } catch (error) {
    return { success: false, error: `Error finding providers: ${error}` };
  }
}

async function executeSearchAddresses(params: SearchAddressesParams, apiKey: string): Promise<ToolResult> {
  try {
    const places = (await searchPlaces(params.user_query)).map((place) => ({
      name: place.name,
      address: place.address,
      location: { lat: place.lat, lng: place.lng },
    }));
    return { success: true, data: { places, query: params.user_query } };
  } catch (error) {
    return { success: false, error: `Error searching addresses: ${error}` };
  }
}

async function executeGetProviderInfo(params: GetProviderInfoParams): Promise<ToolResult> {
  try {
    const providers = await queryRows(
      `SELECT * FROM ${TABLES.PROVIDERS} WHERE provider_name ILIKE $1 LIMIT 5`,
      [`%${params.provider_name}%`]
    );
    if (!providers.length) {
      return {
        success: false,
        error: `No provider found matching: ${params.provider_name}`,
        data: { suggestion: 'Please check the provider name.' },
      };
    }
    const sanitized = providers.map(({ service_zone, ...rest }: any) => rest);
    return { success: true, data: sanitized.length === 1 ? sanitized[0] : sanitized };
  } catch (error) {
    return { success: false, error: `Error getting provider info: ${error}` };
  }
}

async function executeGeneralProviderQuestion(params: GeneralProviderQuestionParams): Promise<ToolResult> {
  try {
    const keys = await getApiKeys();
    const tavilyApiKey = keys.TAVILY_API_KEY;
    if (!tavilyApiKey) {
      return { success: false, error: 'Web search is not configured.', data: { query: params.question } };
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: `paratransit transportation ${params.question}`,
        search_depth: 'advanced',
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
    });

    if (!response.ok) return { success: false, error: `Web search failed: ${response.status}` };
    const result = await response.json() as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return {
      success: true,
      data: {
        query: params.question,
        answer: result.answer || '',
        sources: (result.results || []).slice(0, 5).map((r: any) => ({
          title: r.title || '', url: r.url || '', content: (r.content || '').slice(0, 500),
        })),
      },
    };
  } catch (error) {
    return { success: false, error: `Error searching web: ${error}` };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  toolInput: unknown,
  googleMapsApiKey: string
): Promise<ToolResult> {
  switch (toolName) {
    case 'find_providers':
      return executeFindProviders(toolInput as FindProvidersParams, googleMapsApiKey);
    case 'search_addresses_from_user_query':
      return executeSearchAddresses(toolInput as SearchAddressesParams, googleMapsApiKey);
    case 'get_provider_info':
      return executeGetProviderInfo(toolInput as GetProviderInfoParams);
    case 'general_provider_question':
      return executeGeneralProviderQuestion(toolInput as GeneralProviderQuestionParams);
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

export async function storeToolCall(
  conversationId: string,
  toolName: string,
  toolInput: unknown,
  toolResult: ToolResult
): Promise<void> {
  const { query: dbQuery } = await import('../_shared/db.js');
  const input = toolInput as Record<string, unknown>;
  const timestamp = new Date().toISOString();

  try {
    switch (toolName) {
      case 'find_providers':
        await dbQuery(
          `INSERT INTO ${TABLES.FIND_PROVIDERS_CALLS}
           (conversation_id, source_address, destination_address, provider_data, public_transit_data, message_timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [conversationId, input.source_address, input.destination_address,
           JSON.stringify(toolResult.data), JSON.stringify((toolResult.data as any)?.public_transit || null), timestamp]
        );
        break;
      case 'search_addresses_from_user_query':
        await dbQuery(
          `INSERT INTO ${TABLES.SEARCH_ADDRESSES_CALLS}
           (conversation_id, query_text, places_data, message_timestamp)
           VALUES ($1, $2, $3, $4)`,
          [conversationId, input.user_query, JSON.stringify(toolResult.data), timestamp]
        );
        break;
      case 'get_provider_info': {
        const rd = toolResult.data as any;
        const providerId = rd?.provider_id || rd?.id || null;
        await dbQuery(
          `INSERT INTO ${TABLES.GET_PROVIDER_INFO_CALLS}
           (conversation_id, provider_id, provider_info, message_timestamp)
           VALUES ($1, $2, $3, $4)`,
          [conversationId, providerId ? Number(providerId) : null, JSON.stringify(toolResult.data), timestamp]
        );
        break;
      }
      case 'general_provider_question': {
        const rd = toolResult.data as any;
        await dbQuery(
          `INSERT INTO ${TABLES.GENERAL_QUESTION_CALLS}
           (conversation_id, question, search_results, sources, message_timestamp)
           VALUES ($1, $2, $3, $4, $5)`,
          [conversationId, input.question,
           JSON.stringify({ answer: rd?.answer, raw_results: rd?.sources }),
           JSON.stringify(rd?.sources || []), timestamp]
        );
        break;
      }
    }
  } catch (error) {
    console.error('Error storing tool call:', error);
  }
}
