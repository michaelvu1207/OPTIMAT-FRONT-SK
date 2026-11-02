import { isFixedRouteProvider, tryParseJson } from './providerFields';

export const PROCESSING_UNITS = [
  { value: 'calendar_days', label: 'Calendar days', singular: 'calendar day' },
  { value: 'business_days', label: 'Business days', singular: 'business day' },
  { value: 'weeks', label: 'Weeks', singular: 'week' },
  { value: 'months', label: 'Months', singular: 'month' },
] as const;

export type ProcessingUnit = typeof PROCESSING_UNITS[number]['value'];
export type ProcessingTime =
  | { kind: 'same_day' }
  | { kind: 'estimate' | 'up_to' | 'at_least'; value: number; unit: ProcessingUnit }
  | { kind: 'range'; minimum: number; maximum: number; unit: ProcessingUnit };

export interface ApplicationInfo {
  required?: boolean;
  processing_time?: string | ProcessingTime;
  instructions?: string;
  source_type?: string;
  source_url?: string;
  source_notes?: string;
  verified_at?: string;
}

type ProcessingForm = {
  kind: string;
  value?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  unit?: string;
};

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function processingTimeFromForm(form: ProcessingForm): { data?: ProcessingTime; error: string | null } {
  if (form.kind === 'unknown') return { error: null };
  if (form.kind === 'same_day') return { data: { kind: 'same_day' }, error: null };
  const unit = PROCESSING_UNITS.find(option => option.value === form.unit)?.value;
  if (!unit) return { error: 'Choose a time unit.' };
  if (form.kind === 'range') {
    const minimum = positiveInteger(form.minimum);
    const maximum = positiveInteger(form.maximum);
    if (minimum === null || maximum === null) return { error: 'Enter positive whole numbers for the minimum and maximum.' };
    if (maximum < minimum) return { error: 'The maximum must be at least the minimum.' };
    return { data: { kind: 'range', minimum, maximum, unit }, error: null };
  }
  if (!['estimate', 'up_to', 'at_least'].includes(form.kind)) return { error: 'Choose a processing time format.' };
  const value = positiveInteger(form.value);
  if (value === null) return { error: 'Enter a positive whole number, or choose Same day or Not yet confirmed.' };
  return { data: { kind: form.kind as 'estimate' | 'up_to' | 'at_least', value, unit }, error: null };
}

export function formatProcessingTime(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  const input = objectValue(value);
  const result = processingTimeFromForm(input as ProcessingForm);
  if (!result.data || result.error) return null;
  const time = result.data;
  if (time.kind === 'same_day') return 'Same day';
  const unit = PROCESSING_UNITS.find(option => option.value === time.unit)!;
  const amount = time.kind === 'range' ? time.maximum : time.value;
  const label = amount === 1 ? unit.singular : unit.label.toLowerCase();
  if (time.kind === 'range') return `${time.minimum}–${time.maximum} ${label}`;
  const prefix = { estimate: 'About', up_to: 'Up to', at_least: 'At least' }[time.kind];
  return `${prefix} ${time.value} ${label}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = tryParseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requirementText(value: unknown): string {
  const parsed = tryParseJson(value);
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) return parsed.map(requirementText).join(' ');
  if (parsed && typeof parsed === 'object') return Object.values(parsed).map(requirementText).join(' ');
  return '';
}

export function providerTimeline(provider: Record<string, unknown>) {
  const booking = objectValue(provider?.booking);
  const schedule = objectValue(provider?.schedule_type);
  const application = objectValue(booking.application);
  const requirements = requirementText(provider?.eligibility_reqs || provider?.eligibility_requirement).replace(/\s+/g, ' ');
  const explicitRequired = typeof application.required === 'boolean' ? application.required : null;
  // Only infer from an explicit application instruction. Missing proof, ADA
  // classification, or a reservation window does not establish an application.
  const sentences = requirements.split(/[.!?]/).map(part => part.trim().replace(/^["']|["']$/g, ''));
  const noApplication = sentences.some(sentence => /^(?:(?:eligibility|proof):\s*)?(?:no application (?:is )?(?:needed|required)|application (?:is )?not required)$/i.test(sentence));
  const requiresApplication = sentences.some(sentence =>
    !/\b(?:no|not|optional|may|if|already)\b/i.test(sentence) &&
    /\b(?:complete|submit|fill out)\b[^.!?]{0,140}\bapplication\b|\bregistration\s*\/\s*application\b|\bapplication (?:is )?required\b/i.test(sentence)
  );
  const required = explicitRequired ?? (noApplication ? false : requiresApplication ? true : null);
  const method = text(booking.method);
  const notice = text(schedule.advance_notice);
  const source = text(application.source_url);
  return {
    fixedRoute: isFixedRouteProvider(provider),
    required,
    processingTime: required === false ? null : formatProcessingTime(application.processing_time),
    instructions: text(application.instructions),
    sourceType: text(application.source_type),
    sourceNotes: text(application.source_notes),
    sourceUrl: source && /^https?:\/\//i.test(source) ? source : null,
    verifiedAt: text(application.verified_at),
    bookingNotice: notice || (method === 'none' ? 'No advance booking required.' : 'Contact the provider to confirm booking notice.'),
    regionalNotice: text(schedule.regional_advance_notice),
  };
}

/** Preserve existing booking keys and application metadata during form edits. */
export function buildBookingValue(base: unknown, method: string, details: string, fields: ApplicationInfo): Record<string, unknown> | null {
  const result = { ...objectValue(base) };
  if (method) result.method = method;
  else delete result.method;
  if (method !== 'none' && details.trim()) result.details = details.trim();
  else delete result.details;
  const application = { ...objectValue(result.application) };
  for (const key of ['required', 'processing_time', 'instructions', 'source_type', 'source_url', 'source_notes', 'verified_at'] as const) {
    const value = fields[key];
    const present = key === 'required' ? typeof value === 'boolean' : key === 'processing_time' ? Boolean(formatProcessingTime(value)) : Boolean(text(value));
    if (present) application[key] = value;
    else delete application[key];
  }
  if (Object.keys(application).length) result.application = application;
  else delete result.application;
  return Object.keys(result).length ? result : null;
}
