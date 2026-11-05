import { clarifyTripTime, routePlanner } from './tripChoices.js';
/**
 * Tool definitions and execution logic for the OPTIMAT chat service.
 * Lambda version — uses raw SQL via pg instead of Supabase JS client.
 */

import { eligibilityField, registerQuestion, YES_NO_OPTIONS, type BinaryQuestion } from './yes-no.js';
import { explicitlyRequestedWebSearch, destinationAddressAllowed, buildAddressQuery, needsDepartmentVerification, selectablePlace, verifyDestination, type AddressSearchInput, type LocationContext } from './destination.js';
import { riderProviderDetails } from './provider-details.js';
import { queryRows, TABLES } from '../_shared/db.js';
import { getApiKeys } from '../_shared/secrets.js';
import { geocodePlace, searchPlaces } from '../_shared/location.js';
import { AGE_RANGES, AGE_RANGE_QUESTION, ageBounds, ageChoiceData, mergeAgeFacts, providerAgeCheck, type AgeRangeId } from './age.js';

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
  age_range?: AgeRangeId | null;
  disabled?: boolean | null;
  ada_paratransit_eligible?: boolean | null;
  veteran?: boolean | null;
  residence_city?: string | null;
  declined?: boolean;
  declined_facts?: RiderFact[];
}

export interface EligibilityAssessment {
  provider_name: string;
  verdict: 'eligible' | 'ineligible' | 'verification_required';
  reason: string;
  missing_fact?: RiderFact | null;
  exclusion_basis?: 'age' | 'residence_city' | 'veteran' | 'disability' | 'ada_approval' | 'other';
}

export interface AssessEligibilityParams {
  assessments: EligibilityAssessment[];
}

export interface TurnContext extends LocationContext {
  binaryQuestions?: BinaryQuestion[];
  riderEligibility: RiderEligibility;
  lastSearch: null | {
    candidates: Record<string, unknown>[];
    result: Record<string, unknown>;
  };
  latestAssessment: Record<string, unknown> | null;
}

export interface SearchAddressesParams extends AddressSearchInput {}

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
  /** Internal audit linkage; never included in attachment data or model context. */
  providerId?: number;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const toolDefinitions = [
  {
    name: 'clarify_trip_time',
    description: 'Show Pickup time and Arrival time buttons when a rider states a time without specifying its meaning. Do not ask again if already explicit or clarified.',
    input_schema: { type: 'object' as const, properties: { time: { type: 'string', maxLength: 80 } }, required: ['time'] },
  },
  {
    name: 'open_route_planner',
    description: 'Offer a Google Maps link for bus/train directions (transit) or bicycle directions (bicycling). This is a handoff, not a calculated route. Use only explicitly provided locations; omit missing locations. Do not collect age, residence, disability or trip dates for route-only requests. Requires no external search.',
    input_schema: { type: 'object' as const, properties: { mode: { type: 'string', enum: ['transit', 'bicycling'] }, origin: { type: 'string', maxLength: 300 }, destination: { type: 'string', maxLength: 300 } }, required: ['mode'] },
  },
  {
    name: 'ask_yes_no',
    description: 'Show Yes, No, and Would rather not say buttons for any binary question. Ask one fact per question. Use a complete standalone question. For disability use exactly "Do you have a disability?"; for veteran status use exactly "Are you a veteran?". Never ask ADA certification status. Do not use for open-ended details, age ranges, or address selection.',
    input_schema: { type: 'object' as const, properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'ask_age_range',
    description: 'Show clickable age-range choices when age information is needed and neither a range nor an exact age is known. Use this instead of asking for an exact age. Do not call for unrelated questions or when age information is already known.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'find_providers',
    description: `Find paratransit providers that can serve a one-way or round trip between origin and destination.
The server filters by source/destination GeoJSON, known operating hours, and excludes ADA Paratransit when disabled=false.
An age range (or a voluntarily supplied exact age) and residence city are needed before searching. Use ask_age_range for missing age information; never infer residence from pickup.
Call this once the locations, date, outbound time, trip type, age range, and residence city are known. For a round trip, collect the return time too; for a one-way trip, omit return_time. Preserve the rider's requested times without adding an automatic buffer. Do not require contact information, driver instructions, or optional travel needs before searching. Pass only rider facts the rider
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
            age: { type: 'integer', minimum: 0, maximum: 120, description: 'Only an exact age voluntarily stated by the rider. Never substitute the minimum, maximum, or midpoint of a range.' },
            age_range: { type: 'string', enum: AGE_RANGES.map(range => range.id), description: 'The age band explicitly selected or stated by the rider. Supply this instead of age for a range.' },
            disabled: { type: 'boolean' },
            ada_paratransit_eligible: {
              type: 'boolean',
              description: 'Record only if the rider voluntarily states whether a transit agency has approved their ADA paratransit eligibility. Never ask for this status or infer it from disability.',
            },
            veteran: { type: 'boolean' },
            residence_city: { type: 'string', minLength: 1 },
            declined: { type: 'boolean', description: 'True if the rider declines further eligibility questions.' },
          },
          required: ['residence_city'],
        },
      },
      required: ['source_address', 'destination_address', 'departure_time', 'travel_date', 'trip_type', 'rider_eligibility'],
    },
  },
  {
    name: 'assess_eligibility',
    description: `Assess every candidate returned by the most recent find_providers call before answering.
Read the candidate's complete eligibility requirement and compare every AND/OR clause with the structured rider facts.
For an age range, compare the whole interval with each explicit age cutoff. Never treat a bound or midpoint as an exact age. For example, 60–64 meets 60+ but fails 65+; 50–54 meets 50+ but fails 55+. Disabled (18+) still requires adulthood; preserve senior OR disability OR veteran alternatives. A cutoff inside the range or an unspecified "Senior" requirement needs provider verification, not a guess or a request for an exact age.
Geographic coverage is already established; do not infer residence from the pickup address.
- eligible: the known facts match the requirement. This is preliminary screening, so tell the rider they may qualify.
- ineligible: a known rider fact fails the requirement.
- verification_required: an unknown rider fact or provider decision prevents a verdict. Set missing_fact to the
  single rider fact that would most directly resolve it, or omit it when only the provider can decide.
If ADA approval is required but unknown, use verification_required and explain that the provider must confirm it.
Omit missing_fact for ADA approval; never ask the rider about ADA eligibility, certification, application, or agency approval.
Disability alone does not establish ADA approval. Preserve any ADA status the rider voluntarily supplied.
When disabled=false, ADA Paratransit is excluded by the server. Non-ADA services still follow their own requirements.
When disabled=true, never exclude an option because of disability or ADA approval, even if approval is unknown or false.
Keep such options as verification_required when provider confirmation is needed. Age, residence, veteran status,
and other independent requirements still apply. For every ineligible verdict, supply exclusion_basis naming the failed requirement.
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
              exclusion_basis: {
                type: 'string',
                enum: ['age', 'residence_city', 'veteran', 'disability', 'ada_approval', 'other'],
              },
              missing_fact: {
                type: 'string',
                enum: ['age', 'disabled', 'veteran', 'residence_city'],
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
    name: 'verify_destination_address',
    description: 'Find destination candidates with Amazon Location first. Tavily is an optional last resort: only when AWS has no specific candidate and the rider explicitly requests checking the official website or department address; at most one basic web search. Never call third-party search routinely. Use when a rider does not know which building, department results are ambiguous, or map results do not match the named institution. Return possible map candidates if official verification fails. Let the rider choose or enter another address; never claim an unverified result is a confirmed department. All results require rider confirmation before provider search. Pass the named organization, facility, specialty, and destination city from user messages; never the pickup city. Include at least a structured city or facility so the official page can be checked against the intended destination. This tool currently recognizes official Kaiser and Town of Danville sources; unsupported sources fall back to map candidates or manual entry.',
    input_schema: {
      type: 'object' as const,
      properties: {
        user_query: { type: 'string', description: 'The destination query, preserving organization, facility, department, and stated destination city.' },
        organization: { type: 'string' }, facility: { type: 'string' }, department: { type: 'string' }, city: { type: 'string' },
      }, required: ['user_query'],
    },
  },
  {
    name: 'search_addresses_from_user_query',
    description: "Find candidate addresses using Amazon Location Service. Separate pickup and destination searches with their role. Preserve the named organization and specialty. Do not add a destination city from pickup or residence. Medical department queries use AWS candidates first. A campus listing is a possible match, not confirmed department evidence; the rider must select or enter the destination.",
    input_schema: {
      type: 'object' as const,
      properties: {
        user_query: { type: 'string', description: 'The search query for finding addresses' },
        role: { type: 'string', enum: ['pickup', 'destination'] },
        organization: { type: 'string' }, facility: { type: 'string' }, department: { type: 'string' }, city: { type: 'string' },
      },
      required: ['user_query'],
    },
  },
  {
    name: 'get_provider_info',
    description: 'Look up recorded fees, membership terms, eligibility and application details for a named provider. Call before claiming details are unavailable. Use the complete municipal program name, such as Walnut Creek Lyft Concierge Pass, rather than generic Lyft.',
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
    description: 'Optional last-resort web lookup only when recorded provider data cannot answer and the rider explicitly requests online or official-source research. Do not use for routine questions or address choices. At most one basic external search per turn.',
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

export function missingRequiredRiderFacts(rider: RiderEligibility): Array<'age' | 'residence_city'> {
  const missing: Array<'age' | 'residence_city'> = [];
  if (!ageBounds(rider)) missing.push('age');
  if (typeof rider.residence_city !== 'string' || !rider.residence_city.trim()) missing.push('residence_city');
  return missing;
}

export function requiredRiderQuestion(rider: RiderEligibility): string | null {
  const missing = missingRequiredRiderFacts(rider);
  if (!missing.length) return null;
  if (rider.declined) return 'An age range and city of residence are needed to check trip options. You do not need to share an exact age. I cannot complete this search without those details.';
  if (missing.length === 2) return `${AGE_RANGE_QUESTION} What city do you live in?`;
  return missing[0] === 'age'
    ? AGE_RANGE_QUESTION
    : 'What city do you live in? Your city of residence is required to check transportation options.';
}

export function isAdaParatransit(provider: Record<string, unknown>): boolean {
  // Use the service classification, not a substring in eligibility text:
  // Non-ADA services can mention ADA documentation as one possible proof.
  return ['adaparatransit', 'adapara'].includes(String(provider.provider_type || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function filterByDisability<T extends Record<string, unknown>>(providers: T[], rider: RiderEligibility): T[] {
  return rider.disabled === false ? providers.filter((provider) => !isAdaParatransit(provider)) : providers;
}

export async function executeFindProviders(
  params: FindProvidersParams,
  apiKey: string,
  turn: TurnContext,
): Promise<ToolResult> {
  if (!destinationAddressAllowed(turn, params.destination_address)) {
    return { success: false, error: 'The destination is pending or does not match its confirmed street address. Use verify_destination_address or the explicit rider-provided address. Do not search providers using another building.' };
  }
  // A selected range is authoritative: a model must not replace it with a
  // fabricated exact age while building a tool call.
  const suppliedFacts = { ...(params.rider_eligibility || {}) };
  delete suppliedFacts.declined_facts; // Field refusals are owned by explicit rider answers.
  if (turn.riderEligibility.declined_facts?.length) delete suppliedFacts.declined;
  if (ageBounds(turn.riderEligibility)) {
    delete suppliedFacts.age;
    delete suppliedFacts.age_range;
  }
  for (const field of ['disabled', 'veteran'] as const) {
    if (turn.riderEligibility.declined_facts?.includes(field) || turn.binaryQuestions?.some(question => question.answer && eligibilityField(question.question) === field)) delete suppliedFacts[field];
  }
  turn.riderEligibility = mergeAgeFacts(turn.riderEligibility, suppliedFacts);
  const requiredQuestion = requiredRiderQuestion(turn.riderEligibility);
  if (requiredQuestion) {
    turn.lastSearch = null;
    turn.latestAssessment = null;
    return { success: false, error: requiredQuestion };
  }
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
            algorithm: 'Match both addresses and service hours, then exclude ADA Paratransit for riders who explicitly report no disability. Assess remaining requirements from provider data.',
            passed: [
              { label: 'Origin inside service area', detail: sourceLocation.formatted_address },
              { label: 'Destination inside service area', detail: destLocation.formatted_address },
            ],
            not_hard_filtered: ['remaining eligibility requirements'],
          },
        });
      }
    }

    // Apply service hours before the disability policy. Other eligibility
    // requirements stay in the provider payload for assessment.
    const scheduled = matching
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

    const filtered = filterByDisability(scheduled, turn.riderEligibility);
    const disabilityExcluded = scheduled.filter((provider) => !filtered.includes(provider)).map((provider) => ({
      provider_name: providerName(provider), stage: 'eligibility',
      reason: 'ADA Paratransit is excluded because the rider stated they are not disabled.',
    }));

    const riderEligibility = turn.riderEligibility;

    const candidates = filtered.map(({ service_zone, ...rest }) => ({
      ...rest,
      eligibility_requirement: rest.eligibility_reqs || rest.eligibility_requirements || 'None stated',
      service_hours_known: hasKnownServiceHours(rest as Provider),
      service_area_explanation: serviceAreaExplanation(rest, riderEligibility.residence_city, sourceLocation.formatted_address, destLocation.formatted_address),
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
      excluded_providers: disabilityExcluded,
      rider_eligibility: riderEligibility,
      source_address: sourceLocation.formatted_address,
      destination_address: destLocation.formatted_address,
      source_coordinates: { lat: sourceLocation.lat, lng: sourceLocation.lng },
      destination_coordinates: { lat: destLocation.lat, lng: destLocation.lng },
      filtered_out_count: matching.length - filtered.length,
      diagnostics: {
        geography_match_count: matching.length,
        schedule_match_count: scheduled.length,
        disability_excluded_count: disabilityExcluded.length,
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

async function executeSearchAddresses(params: SearchAddressesParams, apiKey: string, turn: TurnContext): Promise<ToolResult> {
  try {
    if (!params?.role && /\bkaiser\b|\b(?:medical|health|surgery) (?:center|offices)\b/i.test(params?.user_query || '')) params = { ...params, role: 'destination' };
    const searchQuery = buildAddressQuery(params, turn);
    const departmentQuery = needsDepartmentVerification(searchQuery);
    if (departmentQuery && params.role !== 'pickup') {
      return { success: true, data: await verifyDestination({ ...params, user_query: searchQuery }, turn) };
    }
    const places = (await searchPlaces(searchQuery)).map((place) => ({
      name: place.name,
      address: place.address,
      location: { lat: place.lat, lng: place.lng },
      place_id: place.placeId,
      place_type: place.placeType,
      ...(params.role ? { role: params.role } : {}),
      selectable: selectablePlace(place) && (!/\bkaiser\b/i.test(searchQuery) || /\bkaiser\b/i.test(place.name)),
    }));
    const selectable = places.filter(place => place.selectable);
    if (params.role === 'destination' && !selectable.length && /\bkaiser\b/i.test(searchQuery)) {
      return { success: true, data: await verifyDestination({ ...params, user_query: searchQuery }, turn) };
    }
    if (params.role === 'destination') {
      turn.destinationVerification = { status: 'pending', query: searchQuery };
    }
    return { success: true, data: { places, query: searchQuery, ...(params.role ? { role: params.role } : {}),
      ...(selectable.length && params.role === 'destination' ? { status: 'confirmation_required', message: 'Ask the rider to choose a destination or enter another address. Do not search providers before confirmation.' } : {}),
      ...(selectable.length ? {} : { status: 'verification_required', message: 'No matching facility with a full street address was found. Road, city, and unrelated organization results are not confirmed destinations. Use verify_destination_address; never recommend either address or assume the driver knows.' }) } };
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
    const sanitized = providers.map(riderProviderDetails);
    const providerId = providers.length === 1 ? Number(providers[0].provider_id) : NaN;
    return { success: true, data: sanitized.length === 1 ? sanitized[0] : sanitized,
      ...(Number.isSafeInteger(providerId) ? { providerId } : {}) };
  } catch (error) {
    return { success: false, error: `Error getting provider info: ${error}` };
  }
}

async function executeGeneralProviderQuestion(params: GeneralProviderQuestionParams, turn: TurnContext): Promise<ToolResult> {
  if (!explicitlyRequestedWebSearch(turn) || turn.webSearchUsed) return { success: false, error: 'Use recorded provider information first. External web search is only available when the rider explicitly requests an online or official-source lookup, at most once per turn.' };
  try {
    const keys = await getApiKeys();
    const tavilyApiKey = keys.TAVILY_API_KEY;
    if (!tavilyApiKey) {
      return { success: false, error: 'Web search is not configured.', data: { query: params.question } };
    }

    turn.webSearchUsed = true;
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: AbortSignal.timeout(8_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: `paratransit transportation ${params.question}`,
        search_depth: 'basic',
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

function serviceAreaExplanation(provider: Record<string, unknown>, residence: unknown, origin: unknown, destination: unknown): string | null {
  const passed = (provider.match_criteria as { passed?: Array<{ label?: string }> } | undefined)?.passed;
  if (!Array.isArray(passed) || !['Origin inside service area', 'Destination inside service area'].every(label => passed.some(item => item?.label === label))) return null;
  let rawCities = provider.service_area_cities;
  if (typeof rawCities === 'string') {
    try { rawCities = JSON.parse(rawCities); } catch { return null; }
  }
  if (!Array.isArray(rawCities)) return null;
  const cities = rawCities.filter((city): city is string => typeof city === 'string' && /^[A-Za-z][A-Za-z .'-]{0,79}$/.test(city.trim())).map(city => city.trim());
  const words = (value: unknown) => ` ${String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const inText = (value: unknown, city: string) => words(value).includes(words(city));
  const namedCities = cities.filter(city => inText(providerName(provider), city));
  if (!namedCities.length) return null;
  const otherCities = cities.filter(city => !namedCities.some(named => words(named) === words(city)));
  const addressHasCity = (address: unknown, city: string) => typeof address === 'string' && address.split(',').some(part => words(part) === words(city));
  const city = otherCities.find(city => addressHasCity(origin, city) || addressHasCity(destination, city)) || otherCities.find(city => words(residence) === words(city));
  return city ? `Also serves ${city}. Your pickup and destination matched its recorded service area.` : null;
}

const RIDER_FACT_ORDER: RiderFact[] = [
  'residence_city',
  'age',
  'disabled',
  'veteran',
];

function nextEligibilityQuestion(
  assessments: EligibilityAssessment[],
  rider: RiderEligibility,
): { field: RiderFact; candidates_if_known: number; provider_names: string[]; why: string } | null {
  if (rider.declined) return null;
  const known: Record<RiderFact, boolean> = {
    age: Boolean(ageBounds(rider)),
    disabled: typeof rider.disabled === 'boolean',
    ada_paratransit_eligible: typeof rider.ada_paratransit_eligible === 'boolean',
    veteran: typeof rider.veteran === 'boolean',
    residence_city: Boolean(rider.residence_city?.trim()),
  };
  const byFact = new Map<RiderFact, string[]>();

  for (const assessment of assessments) {
    if (assessment.verdict !== 'verification_required' || !assessment.missing_fact) continue;
    // Older model outputs may still name ADA approval as a missing fact. It is
    // a provider verification requirement, never a question for the rider.
    if (assessment.missing_fact === 'ada_paratransit_eligible') continue;
    if (known[assessment.missing_fact] || rider.declined_facts?.includes(assessment.missing_fact)) continue;
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
  const requiredQuestion = requiredRiderQuestion(turn.riderEligibility);
  if (requiredQuestion) return { success: false, error: requiredQuestion };
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
  if (assessedNames.size !== assessments.length) {
    return { success: false, error: 'Each candidate must have exactly one verdict; remove duplicate assessments.' };
  }
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
  const excluded: Record<string, unknown>[] = Array.isArray(turn.lastSearch.result.excluded_providers)
    ? [...turn.lastSearch.result.excluded_providers] : [];

  const effectiveAssessments: EligibilityAssessment[] = [];
  for (const originalAssessment of assessments) {
    let assessment = originalAssessment;
    const provider = candidateByName.get(providerNameKey(assessment.provider_name))!;
    const declined = turn.riderEligibility.declined_facts || [];
    if ((assessment.missing_fact && declined.includes(assessment.missing_fact)) ||
        (assessment.exclusion_basis === 'disability' && declined.includes('disabled')) ||
        (assessment.exclusion_basis === 'veteran' && declined.includes('veteran'))) {
      assessment = { ...assessment, verdict: 'verification_required', missing_fact: null,
        reason: 'The rider chose not to share this information. Eligibility remains unknown; confirm the relevant requirements directly with the provider.' };
    }
    // Enforce the policy even for stale candidates or an incorrect model verdict.
    if (turn.riderEligibility.disabled === false && isAdaParatransit(provider)) {
      assessment = { ...assessment, verdict: 'ineligible', missing_fact: null, exclusion_basis: 'disability',
        reason: 'ADA Paratransit is excluded because the rider stated they are not disabled.' };
    } else if (turn.riderEligibility.disabled === true && assessment.verdict === 'ineligible' &&
      (!assessment.exclusion_basis || ['disability', 'ada_approval'].includes(assessment.exclusion_basis))) {
      assessment = { ...assessment, verdict: 'verification_required', missing_fact: null,
        reason: 'Retained as an option for a rider with a disability. The provider must confirm remaining requirements and any application steps.' };
    }
    if (ageBounds(turn.riderEligibility) && !(turn.riderEligibility.disabled === false && isAdaParatransit(provider))) {
      const ageCheck = providerAgeCheck(provider.eligibility_requirement || provider.eligibility_reqs, turn.riderEligibility);
      if (ageCheck === 'below') {
        assessment = { ...assessment, verdict: 'ineligible', exclusion_basis: 'age', missing_fact: null,
          reason: 'The rider\'s age information is below the explicit age minimum for each applicable eligibility category.' };
      } else if (ageCheck === 'overlaps' && assessment.verdict === 'eligible') {
        assessment = { ...assessment, verdict: 'verification_required', missing_fact: null,
          reason: 'The provider age cutoff falls within the selected range. The provider must confirm whether this age requirement is met; an exact age is not required in this chat.' };
      } else if (ageCheck === 'unspecified' && assessment.verdict === 'eligible') {
        assessment = { ...assessment, verdict: 'verification_required', missing_fact: null,
          reason: 'The provider lists Senior eligibility without a numeric age cutoff. The provider must confirm its age requirement.' };
      } else if (ageCheck === 'possible' && assessment.verdict === 'ineligible' && assessment.exclusion_basis === 'age') {
        assessment = { ...assessment, verdict: 'verification_required', missing_fact: null,
          reason: 'The rider\'s age information does not rule out all age eligibility pathways. The provider must confirm remaining eligibility requirements.' };
      }
    }
    effectiveAssessments.push(assessment);
    const decorated = {
      ...provider,
      eligibility_status: assessment.verdict,
      eligibility_reason: assessment.reason,
      service_area_explanation: serviceAreaExplanation(provider, turn.riderEligibility.residence_city, turn.lastSearch.result.source_address, turn.lastSearch.result.destination_address),
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

  const nextQuestion = nextEligibilityQuestion(effectiveAssessments, turn.riderEligibility);
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
    case 'clarify_trip_time': return clarifyTripTime(toolInput);
    case 'open_route_planner': return routePlanner(toolInput);
    case 'ask_yes_no': {
      const question = registerQuestion(turn, (toolInput as { question?: unknown })?.question);
      return question ? { success: true, data: { questions: [question], options: YES_NO_OPTIONS } }
        : { success: true, data: { questions: [], message: 'This question is already answered or is not a valid binary question. Continue without asking it again.' } };
    }
    case 'ask_age_range':
      return ageBounds(turn.riderEligibility)
        ? { success: true, data: { known: true, message: 'Age information is already known. Reuse it and ask only for remaining trip details.' } }
        : { success: true, data: ageChoiceData() };
    case 'find_providers':
      return executeFindProviders(toolInput as FindProvidersParams, googleMapsApiKey, turn);
    case 'assess_eligibility':
      return executeAssessEligibility(toolInput as AssessEligibilityParams, turn);
    case 'verify_destination_address':
      try { return { success: true, data: await verifyDestination(toolInput as AddressSearchInput, turn) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Invalid destination query.' }; }
    case 'search_addresses_from_user_query':
      return executeSearchAddresses(toolInput as SearchAddressesParams, googleMapsApiKey, turn);
    case 'get_provider_info':
      return executeGetProviderInfo(toolInput as GetProviderInfoParams);
    case 'general_provider_question':
      return executeGeneralProviderQuestion(toolInput as GeneralProviderQuestionParams, turn);
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
        const providerId = toolResult.providerId || null;
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
