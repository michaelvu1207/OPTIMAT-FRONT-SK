export type ScheduleTypeKind = 'fixed-schedules' | 'in-advance-book' | 'real-time-book';

export type AdvanceNotice = '1h' | '1d' | '2d' | '3d' | '1w';

export type BookingMethod = 'none' | 'call' | 'app';

export type FareType = 'fixed' | 'distance-based' | 'free';
export type FarePayment = 'cash' | 'ticket';

export type ProviderType =
  | 'ADA Paratransit'
  | 'Fixed Route'
  | 'Non-ADA Paratransit'
  | 'Volunteer Driver or TNC'
  | 'Volunteer Driver or TNC Programs';

export type RoutingType = '' | 'fixed-routes' | 'curb-to-curb' | 'door-to-door';

export interface ScheduleType {
  type: ScheduleTypeKind;
  advance_notice?: string;
  regional_advance_notice?: string;
  regional_advance_notice_note?: string;
  source_url?: string;
}

export interface Booking {
  method: string;
  details?: string;
}

export interface Fare {
  type: string;
  cost?: string;
  payment?: string;
}

export interface EligibilityRequirement {
  type: string;
  proof?: string;
}

export interface ProviderServiceAreaSummary {
  service_area_cities?: string[] | null;
  service_area_source?: string | null;
  service_area_notes?: string | null;
  service_zone?: unknown;
  has_service_zone?: boolean;
}

const SCHEDULE_LABELS: Record<string, string> = {
  'fixed-schedules': 'Fixed schedule',
  'in-advance-book': 'Book in advance',
  'real-time-book': 'Book on demand',
};

const BOOKING_LABELS: Record<string, string> = {
  none: 'No booking needed',
  call: 'Call',
  app: 'App',
};

const FARE_LABELS: Record<string, string> = {
  free: 'Free',
  fixed: 'Fixed fare',
  'distance-based': 'Distance-based fare',
};

const ELIGIBILITY_PROOF_LABELS: Record<string, string> = {
  'id-certified': 'ID or residency proof required',
  'ada-approved': 'ADA paratransit eligibility required',
};

const SERVICE_AREA_SOURCE_LABELS: Record<string, string> = {
  custom_geojson: 'Custom mapped service area',
  city_list: 'City boundary service area',
  existing_preserved: 'Existing mapped service area',
  unresolved: 'Service area needs review',
  manual: 'Manually curated service area',
};

export const PROVIDER_TYPE_OPTIONS: ReadonlyArray<{ value: ProviderType; label: string }> = [
  { value: 'ADA Paratransit', label: 'ADA Paratransit' },
  { value: 'Non-ADA Paratransit', label: 'Non-ADA Paratransit' },
  { value: 'Fixed Route', label: 'Fixed Route' },
  { value: 'Volunteer Driver or TNC', label: 'Volunteer Driver or TNC' },
  { value: 'Volunteer Driver or TNC Programs', label: 'Volunteer Driver or TNC Programs' },
];

export const ROUTING_TYPE_OPTIONS: ReadonlyArray<{ value: RoutingType; label: string }> = [
  { value: '', label: '—' },
  { value: 'fixed-routes', label: 'Fixed routes' },
  { value: 'curb-to-curb', label: 'Curb-to-curb' },
  { value: 'door-to-door', label: 'Door-to-door' },
];

export const SCHEDULE_TYPE_OPTIONS: ReadonlyArray<{ value: ScheduleTypeKind; label: string }> = [
  { value: 'fixed-schedules', label: 'Fixed schedules' },
  { value: 'in-advance-book', label: 'Book in advance' },
  { value: 'real-time-book', label: 'Book in real time' },
];

export const ADVANCE_NOTICE_OPTIONS: ReadonlyArray<{ value: AdvanceNotice; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '2d', label: '2 days' },
  { value: '3d', label: '3 days' },
  { value: '1w', label: '1 week' },
];

export const BOOKING_METHOD_OPTIONS: ReadonlyArray<{ value: BookingMethod; label: string }> = [
  { value: 'none', label: 'No booking needed' },
  { value: 'call', label: 'Call' },
  { value: 'app', label: 'App' },
];

export const FARE_TYPE_OPTIONS: ReadonlyArray<{ value: FareType; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'distance-based', label: 'Distance-based' },
  { value: 'free', label: 'Free' },
];

export const FARE_PAYMENT_OPTIONS: ReadonlyArray<{ value: FarePayment; label: string }> = [
  { value: 'cash', label: 'Cash' },
  { value: 'ticket', label: 'Ticket' },
];

export function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function formatScheduleType(value: unknown): string | null {
  const parsed = tryParseJson(value);
  if (!parsed) return null;

  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const type = typeof (parsed as Record<string, unknown>).type === 'string'
    ? ((parsed as Record<string, unknown>).type as string)
    : null;
  const advance = typeof (parsed as Record<string, unknown>).advance_notice === 'string'
    ? ((parsed as Record<string, unknown>).advance_notice as string)
    : null;
  const regionalAdvance = typeof (parsed as Record<string, unknown>).regional_advance_notice === 'string'
    ? ((parsed as Record<string, unknown>).regional_advance_notice as string)
    : null;

  if (!type) return null;

  if (type === 'in-advance-book') {
    const local = advance ? `${SCHEDULE_LABELS[type]} (${advance})` : SCHEDULE_LABELS[type];
    return regionalAdvance ? `${local}; regional trips: ${regionalAdvance}` : local;
  }
  if (SCHEDULE_LABELS[type]) return SCHEDULE_LABELS[type];
  return type;
}

export function formatRoutingType(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  return ROUTING_TYPE_OPTIONS.find((option) => option.value === raw)?.label ?? raw;
}

export function formatBooking(value: unknown): string | null {
  const parsed = tryParseJson(value);
  if (!parsed) return null;

  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const method = typeof obj.method === 'string' ? obj.method : '';
  const details = typeof obj.details === 'string' ? obj.details.trim() : '';

  if (!method) return null;
  const methodLabel = BOOKING_LABELS[method] ?? method;
  if (method === 'none') return methodLabel;
  if (details) return `${methodLabel}: ${details}`;
  if (methodLabel) return methodLabel;
  return details ? `${method}: ${details}` : method;
}

export function formatFare(value: unknown): string | null {
  const parsed = tryParseJson(value);
  if (!parsed) return null;

  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : '';
  const cost = typeof obj.cost === 'string' ? obj.cost.trim() : '';
  const payment = typeof obj.payment === 'string' ? obj.payment.trim() : '';

  if (!type) return null;
  if (type === 'free') return FARE_LABELS.free;
  if (type === 'distance-based') return FARE_LABELS['distance-based'];
  if (type === 'fixed') {
    const parts = [FARE_LABELS.fixed];
    if (cost) parts.push(cost);
    if (payment) parts.push(payment);
    return parts.join(' · ');
  }
  const parts = [type];
  if (cost) parts.push(cost);
  if (payment) parts.push(payment);
  return parts.join(' · ');
}

export function formatEligibilityReqs(value: unknown): string | null {
  const parsed = tryParseJson(value);
  if (!parsed) return null;

  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    return trimmed ? trimmed : null;
  }

  let arr: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const eligibility = typeof obj.eligibility === 'string'
      ? obj.eligibility.trim()
      : typeof obj.eligibility_text === 'string'
        ? obj.eligibility_text.trim()
        : '';
    const proof = typeof obj.proof === 'string'
      ? obj.proof.trim()
      : typeof obj.proof_process === 'string'
        ? obj.proof_process.trim()
        : '';
    if (eligibility || proof) {
      return [
        eligibility ? `Eligibility: ${eligibility}` : null,
        proof ? `Proof: ${proof}` : null,
      ].filter(Boolean).join('\n');
    }
    if (Array.isArray(obj.eligibility_reqs)) {
      arr = obj.eligibility_reqs as unknown[];
    }
  }

  if (!arr) return null;

  const lines = arr
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return String(entry);
      const type = typeof (entry as Record<string, unknown>).type === 'string'
        ? ((entry as Record<string, unknown>).type as string).trim()
        : '';
      const proof = typeof (entry as Record<string, unknown>).proof === 'string'
        ? ((entry as Record<string, unknown>).proof as string).trim()
        : '';
      const proofLabel = ELIGIBILITY_PROOF_LABELS[proof] ?? proof;
      if (type && proofLabel) return `${type}: ${proofLabel}`;
      if (type) return type;
      return null;
    })
    .filter(Boolean) as string[];

  return lines.length ? lines.join('\n') : null;
}

/** Fixed-route transit is open to the public and must not be presented as eligibility-based. */
export function isFixedRouteProvider(providerOrType: unknown): boolean {
  const type = typeof providerOrType === 'object' && providerOrType !== null
    ? (providerOrType as Record<string, unknown>).provider_type
    : providerOrType;
  return String(type ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'fixedroute';
}

export function formatServiceZone(value: unknown): string | null {
  const parsed = tryParseJson(value);
  if (!parsed) return null;

  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : null;
  const features = obj.features;
  const count = Array.isArray(features) ? features.length : null;
  if (type === 'FeatureCollection' && typeof count === 'number') {
    return `Mapped service area (${count} boundary${count === 1 ? '' : ' boundaries'})`;
  }
  if (type) return 'Mapped service area';
  return 'Mapped service area';
}

export function formatServiceAreaSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return SERVICE_AREA_SOURCE_LABELS[trimmed] ?? trimmed;
}

export function formatServiceAreaSummary(provider: ProviderServiceAreaSummary | null | undefined): string | null {
  if (!provider) return null;
  const source = formatServiceAreaSource(provider.service_area_source);
  const cities = Array.isArray(provider.service_area_cities)
    ? provider.service_area_cities.filter((city) => typeof city === 'string' && city.trim())
    : [];
  const mappedZone = formatServiceZone(provider.service_zone);

  const parts: string[] = [];
  if (source) parts.push(source);
  if (cities.length) {
    const shown = cities.slice(0, 6).join(', ');
    const extra = cities.length > 6 ? `, +${cities.length - 6} more` : '';
    parts.push(`Cities: ${shown}${extra}`);
  }
  if (!source && mappedZone) parts.push(mappedZone);
  if (!parts.length && provider.has_service_zone) parts.push('Mapped service area');
  if (!parts.length) parts.push('No mapped service area');
  return parts.join('\n');
}
