export const DEFAULT_UPDATED_PROVIDERS_CSV =
  '/Users/maikyon/Downloads/OPTIMAT Provider Validation Updated Providers (3).csv';

export const MANUAL_NAME_MAP = {
  'County Connection': 'County Connection',
  'County Connection (weekday)': 'County Connection',
  'County Connection (weekend)': '__MERGE_WITH_WEEKDAY__',
  'Richmond R-Transit': 'R-Transit (Richmond)',
  'El Cerrito Easy Ride Paratransit Services': 'Easy Ride Paratransit Services (El Cerrito)',
  'Lamorinda Sprint': 'Lamorinda Spirit',
  'San Ramon Go San Ramon': 'Go San Ramon!',
  'San Ramon Senior Express Van': 'Senior Express Van (San Ramon)',
  'Orinda Seniors Around Town': 'Seniors Around Town (Orinda)',
  'County Connection LINK': 'LINK Paratransit',
  'Walnut Creek Seniors Club Mini-Bus': "Walnut Creek Senior's Club Mini-Bus",
  'WestCAT Senior Dial-A-Ride': null,
  'Wheels Go Tri-Valley': null,
  'Richmond Moves': null,
  'Rossmoor Dial-A-Bus': null,
  'Walnut Creek Lyft Self Access Pass': null,
  'Walnut Creek Lyft Concierge Pass': null,
};

export const PROVIDER_ID_NAME_ALIASES = {
  'Walnut Creek Mini Bus': "Walnut Creek Senior's Club Mini-Bus",
  'WestCAT Senior Dial-A-Ride': 'WestCAT Dial-A-Ride',
  'Wheels Go Tri-Valley': 'LAVTA (Wheels)',
};

export const MANUAL_PROVIDER_DEFAULTS = {
  'Concord Senior Center Shuttle': {
    provider_type: 'Non-ADA Paratransit',
    routing_type: 'door-to-door',
    schedule_type: { type: 'in-advance-book' },
    provider_org: 'City of Concord',
    round_trip_booking: true,
    investigated: true,
  },
  'Walnut Creek Lyft Self Access Pass': {
    provider_type: 'Volunteer Driver or TNC',
    routing_type: 'door-to-door',
    schedule_type: { type: 'real-time-book' },
    booking: { method: 'app', details: 'Lyft app' },
    provider_org: 'City of Walnut Creek',
    round_trip_booking: true,
    investigated: true,
  },
  'Walnut Creek Lyft Concierge Pass': {
    provider_type: 'Volunteer Driver or TNC',
    routing_type: 'door-to-door',
    schedule_type: { type: 'in-advance-book' },
    booking: { method: 'call', details: 'Walnut Creek Lyft concierge scheduling' },
    provider_org: 'City of Walnut Creek',
    round_trip_booking: true,
    investigated: true,
  },
  'Walnut Creek Mini Bus': {
    provider_org: 'City of Walnut Creek',
    investigated: true,
  },
};

export function getArgValue(args, flagName) {
  const idx = args.indexOf(flagName);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

export function resolveCanonicalProviderName(csvName) {
  if (Object.hasOwn(MANUAL_NAME_MAP, csvName)) {
    const mapped = MANUAL_NAME_MAP[csvName];
    if (mapped === null) return csvName;
    return mapped;
  }
  return csvName;
}

export function parseEligibility(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, ' ').replace(/,+$/, '').trim();
  if (!trimmed || /^missing$/i.test(trimmed)) return null;
  return trimmed;
}

export function parseFare(text, existingFare) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || /^(none|missing|missing website)$/i.test(trimmed)) return null;
  if (/^free\??$/i.test(trimmed)) return { type: 'free' };
  if (/^fixed(\s+rate)?$/i.test(trimmed)) return { type: 'fixed' };

  const hasComplexFareText = /membership|rider pays|cover up to|additional charges|free trips|per month|per ride|each way|trip/i.test(trimmed);
  if (hasComplexFareText) {
    const fare = { type: /free/i.test(trimmed) && !/\$/.test(trimmed) ? 'free' : 'fixed', cost: trimmed };
    if (existingFare?.payment) fare.payment = existingFare.payment;
    return fare;
  }

  const dollarMatch = trimmed.match(/\$(\d+(?:\.\d+)?)/);
  if (dollarMatch) {
    const fare = { type: 'fixed', cost: `$${dollarMatch[1]}` };
    if (existingFare?.payment) fare.payment = existingFare.payment;
    return fare;
  }

  const bareNumberMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (bareNumberMatch) {
    const fare = { type: 'fixed', cost: `$${bareNumberMatch[1]}` };
    if (existingFare?.payment) fare.payment = existingFare.payment;
    return fare;
  }

  return { type: 'fixed', cost: trimmed };
}

export function parseCityNames(text) {
  if (!text) return [];
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^fixed\s+route\s*\(?/i, '')
    .replace(/^fixed\s*\(/i, '')
    .replace(/\)\s*$/, '')
    .replace(/\.$/, '')
    .trim();

  return cleaned
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((city) => city.replace(/[()]/g, '').replace(/\.$/, '').trim())
    .filter((city) => city.length > 1 && !/^(none|missing|fixed|fixed route)$/i.test(city));
}

export function shouldSkipProvider(csvName) {
  return MANUAL_NAME_MAP[csvName] === '__MERGE_WITH_WEEKDAY__';
}

export function getDbLookupName(csvName, providerName) {
  return PROVIDER_ID_NAME_ALIASES[csvName] ?? providerName;
}

export function applyManualProviderDefaults(provider) {
  const defaults = MANUAL_PROVIDER_DEFAULTS[provider.provider_name];
  if (!defaults) return provider;
  return {
    ...provider,
    ...Object.fromEntries(
      Object.entries(defaults).filter(([, value]) => value !== undefined)
    ),
  };
}
