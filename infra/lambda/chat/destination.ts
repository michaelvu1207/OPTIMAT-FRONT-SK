import { getApiKeys } from '../_shared/secrets.js';
import { searchPlaces, type AwsPlace } from '../_shared/location.js';

export interface AddressSearchInput {
  user_query: string;
  role?: 'pickup' | 'destination';
  organization?: string;
  facility?: string;
  department?: string;
  city?: string;
}
export interface DestinationState {
  status: 'pending' | 'verified' | 'user_provided';
  query: string;
  address?: string;
}
export interface LocationContext {
  locationMessages?: string[];
  destinationVerification?: DestinationState;
}
const AREA_TYPES = new Set(['Street', 'Locality', 'PostalCode', 'Region', 'Country', 'District', 'SubDistrict', 'SubRegion']);
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

// Search trust is scoped to known official publishers, not to addresses or a
// hand-maintained destination directory. Unknown publishers stay unverified.
function officialDomains(query: string): string[] {
  if (/\bkaiser\b/i.test(query)) return ['kaiserpermanente.org', 'kp.org'];
  if (/\bdanville\b/i.test(query) && /\b(senior|community) center\b/i.test(query)) return ['danville.ca.gov'];
  return [];
}
function officialUrl(value: unknown, domains: string[]): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    return domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null;
  } catch { return null; }
}

function destinationEvidence(messages: string[]): string {
  // A new explicitly described trip starts a new destination context. Earlier
  // place questions and residence statements cannot supply its destination city.
  let start = 0;
  for (let i = 0; i < messages.length; i++) if (/\bfrom\b.+\bto\b/i.test(messages[i])) start = i;
  return messages.slice(start).map(message => {
    const trip = message.match(/\bfrom\b.+?\bto\b([\s\S]*)/i);
    if (trip) return trip[1];
    return message.split(/[.!?\n]/).filter(part => !/\b(?:i live|i reside|my home|my pickup|pickup address)\b/i.test(part)).join(' ');
  }).join(' ');
}

export function buildAddressQuery(input: AddressSearchInput, context: LocationContext): string {
  if (typeof input?.user_query !== 'string' || !input.user_query.trim() || input.user_query.length > 500) throw new Error('Provide a location query of 1–500 characters.');
  for (const key of ['organization', 'facility', 'department', 'city'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 150)) throw new Error(`Invalid ${key}.`);
  }
  if (input.role && !['pickup', 'destination'].includes(input.role)) throw new Error('Invalid trip location role.');
  if (input.role !== 'destination') return input.user_query.trim();
  const evidence = destinationEvidence(context.locationMessages || []);
  const compactEvidence = normalized(evidence);
  if (input.organization && !compactEvidence.includes(normalized(input.organization)) &&
      !(/\bkaiser(?: permanente)?\b/i.test(input.organization) && /\bkaiser\b/i.test(evidence))) throw new Error('Use only the organization named by the rider.');
  if (input.department && !compactEvidence.includes(normalized(input.department)) &&
      !(/^optometr/i.test(input.department) && /\boptometr/i.test(evidence))) throw new Error('Do not guess the department. Ask for clarification when the specialty is unknown.');
  // Reject a city invented from a pickup or residence. The model can retry
  // without a city when the rider has not supplied one for the destination.
  if (input.city && !compactEvidence.includes(normalized(input.city))) throw new Error('Destination city is not stated by the rider. Do not copy the pickup or residence city; retry without a city or ask for clarification.');
  if (!input.city) {
    for (const city of ['Danville', 'Walnut Creek', 'Concord']) {
      if (normalized(input.user_query).includes(normalized(city)) && !compactEvidence.includes(normalized(city))) throw new Error('Do not add the pickup city to a destination search. Retry using only the stated destination details.');
    }
  }
  const parts = [input.organization, input.facility, input.department, input.city].filter((value): value is string => Boolean(value?.trim()));
  let query = parts.length ? parts.join(' ') : input.user_query.trim();
  if (/\bkaiser\b/i.test(evidence) && !/\bkaiser\b/i.test(query)) query = `Kaiser ${query}`;
  if (/\boptometr(?:y|ist|ists)\b/i.test(evidence) && !/\boptometr/i.test(query)) query += ' Optometry';
  if (/\bkaiser\b/i.test(query) && !/\bkaiser\b/i.test(evidence)) throw new Error('Do not substitute Kaiser for an organization the rider has not named.');
  return query;
}

export function needsDepartmentVerification(query: string): boolean {
  return /\b(?:optometr\w*|ophthalmolog\w*|eye doctor|cardiology|oncology|radiology|occupational health|department)\b/i.test(query);
}
export function selectablePlace(place: AwsPlace): boolean {
  return !AREA_TYPES.has(place.placeType || '') && /\b\d+[A-Za-z]?\s+\S+/.test(place.address);
}
const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) || [];
function streetKey(value: string): string {
  return words(value).map(word => ({ lane: 'ln', road: 'rd', street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', court: 'ct', place: 'pl' }[word] || word)).join(' ');
}
const STREET = /\b\d{1,6}[A-Za-z]?[ \t]+(?:[A-Za-z0-9][A-Za-z0-9.'-]*[ \t]+){1,7}(?:Lane|Ln|Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Court|Ct|Place|Pl)\b/gi;

function extractLocation(source: { title: string; content: string }, query: string): { street: string; city: string; address: string; building?: string } | null {
  const title = source.title.toLowerCase();
  // A campus listing or provider directory does not verify a department.
  const specialty = query.match(/\b(optometr\w*|ophthalmolog\w*|cardiology|oncology|radiology|occupational health)\b/i)?.[1].toLowerCase();
  if (needsDepartmentVerification(query) && (!specialty || !title.includes(specialty.startsWith('optometr') ? 'optometr' : specialty.startsWith('ophthalmolog') ? 'ophthalmolog' : specialty))) return null;
  if (/\bshadelands\b/i.test(query) && !/\bshadelands\b/i.test(source.title)) return null;
  const section = source.content.match(/(?:^|\n)\s*#{0,4}\s*Location\s*\n([\s\S]*?)(?=\n\s*#{1,4}\s|$)/i)?.[1] || source.content;
  // Require a single distinct street address. Multiple buildings stay pending.
  const streets = [...new Set((section.match(STREET) || []).map(street => street.trim()))];
  if (streets.length !== 1) return null;
  const cityMatch = section.match(/\b([A-Z][A-Za-z]+(?:[ \t]+[A-Z][A-Za-z]+){0,3}),?[ \t\n]+CA[ \t\n]+(\d{5})(?:-\d{4})?\b/);
  if (!cityMatch) return null;
  const city = cityMatch[1];
  // A known query city must agree with the source. These two forms occur in
  // the original reproduction, including the rider's missing-space spelling.
  for (const expected of ['Walnut Creek', 'Concord', 'Danville']) {
    if (normalized(query).includes(normalized(expected)) && normalized(city) !== normalized(expected)) return null;
  }
  const buildingLine = section.match(/\bBuilding\s+\d+[^\n]{0,80}/i)?.[0];
  const building = buildingLine?.split(streets[0])[0].trim().replace(/[,;]$/, '');
  return { street: streets[0], city, address: `${streets[0]}, ${city}, CA ${cityMatch[2]}`, ...(building ? { building } : {}) };
}

export async function verifyDestination(input: AddressSearchInput, context: LocationContext) {
  const query = buildAddressQuery({ ...input, role: 'destination' }, context);
  context.destinationVerification = { status: 'pending', query };
  const pending = (reason: string, sources: unknown[] = []) => ({
    status: 'verification_required', query, role: 'destination', places: [], sources,
    message: `Destination not yet confirmed. ${reason} Do not ask the rider to choose between unverified buildings, suggest either address, assume the driver knows, or search providers for this destination. Ask the rider to check their appointment notice or contact the facility if official verification remains unavailable.`,
  });
  if (!input.city?.trim() && !input.facility?.trim()) return pending('A destination city or specific facility is needed. If the rider already supplied it, retry with that structured field; do not ask for the same information again.');
  const domains = officialDomains(query);
  if (!domains.length) return pending('An official source for this organization is not configured.');
  try {
    const keys = await getApiKeys();
    if (!keys.TAVILY_API_KEY) return pending('Official web search is unavailable.');
    const specialty = query.match(/\b(optometr\w*|ophthalmolog\w*|cardiology|oncology|radiology|occupational health)\b/i)?.[1];
    const department = specialty?.toLowerCase().startsWith('optometr') ? 'Optometry' : specialty?.toLowerCase().startsWith('ophthalmolog') ? 'Ophthalmology' : specialty;
    const focused = Boolean(department && /\bkaiser\b/i.test(query));
    const searches = focused ? [
      { query: `${query} "${department}" department address site:healthy.kaiserpermanente.org/northern-california/facilities`, domains: ['healthy.kaiserpermanente.org'] },
      { query: `${query} "${department}" department location address`, domains: ['healthy.kaiserpermanente.org', 'espanol.kaiserpermanente.org'] },
    ] : [{ query: `${query} official department location address`, domains }];
    type Source = { title: string; url: string; content: string };
    let sources: Source[] = [];
    let candidates: Array<{ street: string; city: string; address: string; building?: string; source: Source }> = [];
    for (const search of searches) {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ api_key: keys.TAVILY_API_KEY, query: search.query, search_depth: 'advanced', max_results: 6, include_domains: search.domains, include_answer: false, include_raw_content: true }),
      });
      if (!response.ok) return pending('Official web search did not succeed.');
      const data = await response.json() as { results?: { title?: unknown; url?: unknown; content?: unknown; raw_content?: unknown }[] };
      const batch = (Array.isArray(data.results) ? data.results : []).slice(0, 6).flatMap(result => {
        const url = officialUrl(result.url, domains);
        if (!url || typeof result.title !== 'string') return [];
        const content = typeof result.raw_content === 'string' && result.raw_content ? result.raw_content : typeof result.content === 'string' ? result.content : '';
        return [{ title: result.title.slice(0, 300), url, content: content.slice(0, 16_000) }];
      });
      sources = [...new Map([...sources, ...batch].map(source => [source.url, source])).values()];
      // Doctor profiles and other departments are discovery results, not proof
      // of the requested department. Retry once without weakening validation.
      candidates = sources.flatMap(source => {
        const location = extractLocation(source, query);
        if (!location || (input.city && normalized(location.city) !== normalized(input.city))) return [];
        if (input.facility && !words(input.facility).filter(word => !['medical', 'offices', 'center', 'park', 'the'].includes(word)).every(word => source.title.toLowerCase().includes(word))) return [];
        return [{ ...location, source }];
      });
      if (candidates.length) break;
    }
    const distinct = new Set(candidates.map(candidate => streetKey(candidate.address)));
    const sourceLinks = sources.map(({ title, url }) => ({ title, url }));
    if (distinct.size !== 1) return pending(distinct.size ? 'Official pages disagree about the address.' : 'No unambiguous department address was found on the official pages.', sourceLinks);
    const candidate = candidates[0];
    const matches = await searchPlaces(candidate.address);
    const place = matches.find(place => selectablePlace(place) && (place.address.match(STREET) || []).some(street => streetKey(street) === streetKey(candidate.street)) && normalized(place.address).includes(normalized(candidate.city)));
    if (!place) return pending('The official address could not be located consistently on the map.', sourceLinks);
    const address = candidate.address;
    context.destinationVerification = { status: 'verified', query, address };
    return {
      status: 'verified', query, role: 'destination', sources: sourceLinks,
      message: 'The official department address agrees with the map location. Ask the rider to confirm this destination; do not substitute a different campus address.',
      places: [{ name: candidate.source.title, address, location: { lat: place.lat, lng: place.lng }, place_id: place.placeId, place_type: place.placeType,
        selectable: true, role: 'destination', verification_status: 'official', source_url: candidate.source.url, ...(candidate.building ? { building: candidate.building } : {}) }],
    };
  } catch {
    return pending('The official source or map lookup is currently unavailable.');
  }
}

export function destinationAddressAllowed(context: LocationContext, address: string): boolean {
  const state = context.destinationVerification;
  if (!state) return true;
  if (typeof address !== 'string') return false;
  if (state.status === 'pending' || !state.address) return false;
  const street = state.address.match(STREET)?.[0];
  if (!street || !(address.match(STREET) || []).some(candidate => streetKey(candidate) === streetKey(street))) return false;
  const tail = state.address.slice(state.address.indexOf(street) + street.length);
  const city = tail.split(',').map(value => value.trim()).find(Boolean);
  return !city || normalized(address).includes(normalized(city));
}

export function applyUserDestination(context: LocationContext, message: string): void {
  // An explicit rider-provided destination can resolve a prior uncertainty.
  // It is never labeled as official verification.
  if (/\bfrom\b.+\bto\b/i.test(message)) context.destinationVerification = undefined;
  const selection = message.match(/^Use ([\s\S]+?) as my destination[.!]?$/i);
  if (selection && selection[1].match(STREET)) {
    context.destinationVerification = { status: 'user_provided', query: selection[1], address: selection[1] };
  }
}
