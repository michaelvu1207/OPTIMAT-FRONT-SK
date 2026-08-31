/**
 * Tool definitions and execution logic for the OPTIMAT chat service.
 * Lambda version — uses raw SQL via pg instead of Supabase JS client.
 */

import { queryRows, TABLES } from '../_shared/db.js';
import { getApiKeys } from '../_shared/secrets.js';
import { geocodePlace, searchPlaces } from '../_shared/location.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FindProvidersParams {
  source_address: string;
  destination_address: string;
  departure_time: string;
  return_time?: string | null;
  travel_date: string;
  trip_type?: 'one_way' | 'round_trip';
  rider_eligibility?: RiderEligibility;
}

export type RiderFact = 'age' | 'disabled' | 'ada_paratransit_eligible' | 'veteran' | 'residence_city';

export interface RiderEligibility {
  age?: number | null;
  disabled?: boolean | null;
  ada_paratransit_eligible?: boolean | null;
  veteran?: boolean | null;
  residence_city?: string | null;
  declined?: boolean;
}

export interface EligibilityAssessment {
  provider_name: string;
  verdict: 'eligible' | 'ineligible' | 'verification_required';
  reason: string;
  missing_fact?: RiderFact | null;
}

export interface AssessEligibilityParams {
  assessments: EligibilityAssessment[];
}

export interface TurnContext {
  riderEligibility: RiderEligibility;
  lastSearch: null | {
    candidates: Record<string, unknown>[];
    result: Record<string, unknown>;
  };
  latestAssessment: Record<string, unknown> | null;
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
  is_operating?: boolean | null;
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
The server filters by source/destination GeoJSON and known operating hours. It does not decide eligibility.
Call this once the locations, date, outbound time, and trip type are known. Pass only rider facts the rider
explicitly stated. Unknown facts must be omitted rather than guessed. After this returns candidates, immediately
call assess_eligibility with a verdict for every candidate. A candidate with service_hours_known=false has not
had its requested time confirmed; describe the schedule as needing provider verification, never as available.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        source_address: { type: 'string', description: 'The pickup/origin address' },
        destination_address: { type: 'string', description: 'The drop-off/destination address' },
        departure_time: { type: 'string', description: 'Pickup time (e.g., "9:00 AM")' },
        return_time: { type: 'string', description: 'Return time for a round trip (e.g., "5:00 PM")' },
        travel_date: { type: 'string', description: 'Travel date in YYYY-MM-DD format.' },
        trip_type: {
          type: 'string',
          enum: ['one_way', 'round_trip'],
          description: 'Whether the rider needs an outbound trip only or a return trip too.',
        },
        rider_eligibility: {
          type: 'object',
          description: 'Only facts explicitly supplied by the rider. Omit unknown facts.',
          properties: {
            age: { type: 'number' },
            disabled: { type: 'boolean' },
            ada_paratransit_eligible: {
              type: 'boolean',
              description: 'Whether the rider explicitly says a transit agency has approved their ADA paratransit eligibility.',
            },
            veteran: { type: 'boolean' },
            residence_city: { type: 'string' },
            declined: { type: 'boolean', description: 'True if the rider declines further eligibility questions.' },
          },
          required: [],
        },
      },
      required: ['source_address', 'destination_address', 'departure_time', 'travel_date', 'trip_type', 'rider_eligibility'],
    },
  },
  {
    name: 'assess_eligibility',
    description: `Assess every candidate returned by the most recent find_providers call before answering.
Read the candidate's complete eligibility requirement and compare every AND/OR clause with the structured rider facts.
Geographic coverage is already established; do not infer residence from the pickup address.
- eligible: the known facts match the requirement. This is preliminary screening, so tell the rider they may qualify.
- ineligible: a known rider fact fails the requirement.
- verification_required: an unknown rider fact or provider decision prevents a verdict. Set missing_fact to the
  single rider fact that would most directly resolve it, or omit it when only the provider can decide.
The server rejects incomplete assessments, invented provider names, and omitted candidates.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        assessments: {
          type: 'array',
          items: {
            type: 'object' as const,
            properties: {
              provider_name: { type: 'string' },
              verdict: { type: 'string', enum: ['eligible', 'ineligible', 'verification_required'] },
              reason: { type: 'string' },
              missing_fact: {
                type: 'string',
                enum: ['age', 'disabled', 'ada_paratransit_eligible', 'veteran', 'residence_city'],
              },
            },
            required: ['provider_name', 'verdict', 'reason'],
          },
        },
      },
      required: ['assessments'],
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

function isTimeCoveredByAnyInterval(
  hoursList: any[],
  dayIndex: number | null,
  requestedMinutes: number | null,
): boolean {
  if (requestedMinutes === null) return true;

  for (const entry of hoursList) {
    const dayPattern = entry.day || '1111111';
    if (dayIndex !== null && dayPattern.length > dayIndex && dayPattern[dayIndex] !== '1') continue;

    const startMinutes = parseTimeToMinutes(entry.start || '0000');
    let endMinutes = parseTimeToMinutes(entry.end || '2400');
    if (startMinutes === null || endMinutes === null) continue;
    if (endMinutes < startMinutes) endMinutes += 24 * 60;

    let requested = requestedMinutes;
    if (requested < startMinutes && endMinutes > 24 * 60) requested += 24 * 60;
    if (startMinutes <= requested && requested <= endMinutes) return true;
  }

  return false;
}

export function isTimeWithinServiceHours(
  provider: Provider,
  departureTime?: string,
  returnTime?: string | null,
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

  // Outbound and return legs may legitimately fall in different service windows. The old
  // implementation required one interval to contain both, which rejected split-shift providers.
  return isTimeCoveredByAnyInterval(hoursList, dayIndex, depMinutes) &&
    isTimeCoveredByAnyInterval(hoursList, dayIndex, retMinutes);
}

function hasKnownServiceHours(provider: Provider): boolean {
  let serviceHours = provider.service_hours;
  if (!serviceHours) return false;
  if (typeof serviceHours === 'string') {
    try { serviceHours = JSON.parse(serviceHours); } catch { return false; }
  }
  return Array.isArray((serviceHours as any)?.hours) && (serviceHours as any).hours.length > 0;
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

async function getTransitDirections(origin: string, destination: string, _apiKey: string) {
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'transit' });
  return {
    routing_status: 'handoff_only',
    google_maps_url: `https://www.google.com/maps/dir/?${params.toString()}`,
    start_address: origin,
    end_address: destination,
    steps: [],
  };
}

function isPubliclyAvailableProvider(provider: Provider): boolean {
  const name = String(provider.provider_name || provider.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return provider.is_operating !== false && name !== 'oneseatregionalride' && name !== 'oneseatride';
}

function isDirectRideProvider(provider: Provider): boolean {
  return String(provider.provider_type || '').toLowerCase().replace(/[^a-z0-9]/g, '') !== 'fixedroute';
}

// ─── Tool Executors ─────────────────────────────────────────────────────────

export async function executeFindProviders(
  params: FindProvidersParams,
  apiKey: string,
  turn: TurnContext,
): Promise<ToolResult> {
  try {
    const [sourceLocation, destLocation] = await Promise.all([
      geocodeAddress(params.source_address, apiKey),
      geocodeAddress(params.destination_address, apiKey),
    ]);
    if (!sourceLocation) return { success: false, error: `Could not geocode source: ${params.source_address}` };
    if (!destLocation) return { success: false, error: `Could not geocode destination: ${params.destination_address}` };

    const providers = (await queryRows(`SELECT * FROM ${TABLES.PROVIDERS}`))
      .filter((provider) => isPubliclyAvailableProvider(provider as Provider))
      .filter((provider) => isDirectRideProvider(provider as Provider));

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

    const riderEligibility = {
      ...turn.riderEligibility,
      ...(params.rider_eligibility || {}),
    };
    turn.riderEligibility = riderEligibility;

    const candidates = filtered.map(({ service_zone, ...rest }) => ({
      ...rest,
      eligibility_requirement: rest.eligibility_reqs || rest.eligibility_requirements || 'None stated',
      service_hours_known: hasKnownServiceHours(rest as Provider),
    }));

    let transitData = null;
    try {
      transitData = await getTransitDirections(sourceLocation.formatted_address, destLocation.formatted_address, apiKey);
    } catch {}

    const result = {
      status: 'awaiting_eligibility_assessment',
      trip_type: params.trip_type || (params.return_time ? 'round_trip' : 'one_way'),
      travel_date: params.travel_date || null,
      departure_time: params.departure_time,
      return_time: params.return_time || null,
      candidates,
      candidate_count: candidates.length,
      rider_eligibility: riderEligibility,
      source_address: sourceLocation.formatted_address,
      destination_address: destLocation.formatted_address,
      source_coordinates: { lat: sourceLocation.lat, lng: sourceLocation.lng },
      destination_coordinates: { lat: destLocation.lat, lng: destLocation.lng },
      filtered_out_count: matching.length - filtered.length,
      diagnostics: {
        geography_match_count: matching.length,
        schedule_match_count: filtered.length,
        providers_without_service_hours: candidates.filter((provider) => !provider.service_hours_known).length,
      },
      public_transit: transitData,
    };

    turn.lastSearch = { candidates, result };

    return {
      success: true,
      data: result,
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
    const providers = (await queryRows(
      `SELECT * FROM ${TABLES.PROVIDERS} WHERE provider_name ILIKE $1 LIMIT 5`,
      [`%${params.provider_name}%`]
    )).filter((provider) => isPubliclyAvailableProvider(provider as Provider));
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

function providerName(provider: Record<string, unknown>): string {
  return String(provider.provider_name || provider.name || '');
}

function providerNameKey(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RIDER_FACT_ORDER: RiderFact[] = [
  'residence_city',
  'age',
  'disabled',
  'ada_paratransit_eligible',
  'veteran',
];

function nextEligibilityQuestion(
  assessments: EligibilityAssessment[],
  rider: RiderEligibility,
): { field: RiderFact; candidates_if_known: number; provider_names: string[]; why: string } | null {
  if (rider.declined) return null;
  const known: Record<RiderFact, boolean> = {
    age: Number.isFinite(rider.age),
    disabled: typeof rider.disabled === 'boolean',
    ada_paratransit_eligible: typeof rider.ada_paratransit_eligible === 'boolean',
    veteran: typeof rider.veteran === 'boolean',
    residence_city: Boolean(rider.residence_city?.trim()),
  };
  const byFact = new Map<RiderFact, string[]>();

  for (const assessment of assessments) {
    if (assessment.verdict !== 'verification_required' || !assessment.missing_fact) continue;
    if (known[assessment.missing_fact]) continue;
    const names = byFact.get(assessment.missing_fact) || [];
    if (!names.includes(assessment.provider_name)) names.push(assessment.provider_name);
    byFact.set(assessment.missing_fact, names);
  }

  const ranked = [...byFact.entries()].sort((a, b) =>
    b[1].length - a[1].length || RIDER_FACT_ORDER.indexOf(a[0]) - RIDER_FACT_ORDER.indexOf(b[0])
  );
  if (ranked.length === 0) return null;
  const [field, names] = ranked[0];
  return {
    field,
    candidates_if_known: names.length,
    provider_names: names,
    why: `${names.length} provider${names.length === 1 ? '' : 's'} can be resolved once this is known`,
  };
}

export function executeAssessEligibility(
  params: AssessEligibilityParams,
  turn: TurnContext,
): ToolResult {
  if (!turn.lastSearch) {
    return { success: false, error: 'Call find_providers before assess_eligibility.' };
  }

  const candidates = turn.lastSearch.candidates;
  const candidateByName = new Map(candidates.map((provider) => [providerNameKey(providerName(provider)), provider]));
  const assessments = Array.isArray(params.assessments) ? params.assessments : [];
  const unknownProviders = assessments
    .filter((assessment) => !candidateByName.has(providerNameKey(assessment.provider_name)))
    .map((assessment) => assessment.provider_name);
  if (unknownProviders.length > 0) {
    return {
      success: false,
      error: `These providers were not candidates: ${unknownProviders.join(', ')}.`,
      data: { candidates: candidates.map(providerName) },
    };
  }

  const assessedNames = new Set(assessments.map((assessment) => providerNameKey(assessment.provider_name)));
  const missingProviders = candidates
    .map(providerName)
    .filter((name) => !assessedNames.has(providerNameKey(name)));
  if (missingProviders.length > 0) {
    return {
      success: false,
      error: `Every candidate needs a verdict. Missing: ${missingProviders.join(', ')}.`,
      data: { candidates: candidates.map(providerName) },
    };
  }

  const eligible: Record<string, unknown>[] = [];
  const verificationRequired: Record<string, unknown>[] = [];
  const excluded: Record<string, unknown>[] = [];

  for (const assessment of assessments) {
    const provider = candidateByName.get(providerNameKey(assessment.provider_name))!;
    const decorated = {
      ...provider,
      eligibility_status: assessment.verdict,
      eligibility_reason: assessment.reason,
      ...(assessment.missing_fact ? { missing_facts: [assessment.missing_fact] } : {}),
    };
    if (assessment.verdict === 'eligible') eligible.push(decorated);
    else if (assessment.verdict === 'verification_required') verificationRequired.push(decorated);
    else {
      excluded.push({
        provider_name: providerName(provider),
        stage: 'eligibility',
        reason: assessment.reason,
        requirement: provider.eligibility_requirement || provider.eligibility_reqs,
      });
    }
  }

  const nextQuestion = nextEligibilityQuestion(assessments, turn.riderEligibility);
  const result = {
    ...turn.lastSearch.result,
    status: 'complete',
    candidates: undefined,
    candidate_count: candidates.length,
    data: eligible,
    verification_required: verificationRequired,
    excluded_providers: excluded,
    next_question: nextQuestion,
    total_found: eligible.length,
    direct_provider_count: eligible.length,
    diagnostics: {
      ...((turn.lastSearch.result.diagnostics as Record<string, unknown>) || {}),
      eligible_match_count: eligible.length,
      verification_required_count: verificationRequired.length,
      ineligible_count: excluded.length,
    },
  };
  turn.latestAssessment = result;
  return { success: true, data: result };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  toolInput: unknown,
  googleMapsApiKey: string,
  turn: TurnContext,
): Promise<ToolResult> {
  switch (toolName) {
    case 'find_providers':
      return executeFindProviders(toolInput as FindProvidersParams, googleMapsApiKey, turn);
    case 'assess_eligibility':
      return executeAssessEligibility(toolInput as AssessEligibilityParams, turn);
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
