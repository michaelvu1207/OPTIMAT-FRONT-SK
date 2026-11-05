// Keep enrollment uncertainty separate from the recorded reservation window.
// This bounded path answers named-provider timeline questions, not trip searches.
export function timelineProviderQuestion(message: string): string | null {
  if (!/\b(?:apply|application|enroll(?:ed|ment)?|processing|book\w* in advance|advance booking)\b/i.test(message)) return null;
  if (/\b(?:from .+ to |compare|versus|search (?:for )?(?:rides|providers)|find (?:me )?(?:a ride|providers))\b/i.test(message)) return null;
  const names = ['Mobility Matters', 'LINK Paratransit', 'Walnut Creek Lyft Self Access Pass', 'Walnut Creek Lyft Concierge Pass'];
  const normalized = message.toLowerCase().replace(/[-–]/g, ' ');
  const matches = names.filter(name => normalized.includes(name.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function processingTime(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  const time = object(value);
  if (time.kind === 'same_day') return 'same day';
  const units: Record<string, string> = { calendar_days: 'calendar days', business_days: 'business days', weeks: 'weeks', months: 'months' };
  const unit = units[String(time.unit)];
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (!unit) return null;
  if (time.kind === 'range' && positive(time.minimum) && positive(time.maximum) && time.maximum >= time.minimum) return `${time.minimum}–${time.maximum} ${unit}`;
  const prefix: Record<string, string> = { estimate: 'about', up_to: 'up to', at_least: 'at least' };
  return prefix[String(time.kind)] && positive(time.value) ? `${prefix[String(time.kind)]} ${time.value} ${time.value === 1 ? unit.replace(/s$/, '') : unit}` : null;
}

export function bookingGuidance(message: string, value: unknown): string | null {
  if (!timelineProviderQuestion(message) || Array.isArray(value)) return null;
  const provider = object(value);
  if (provider.provider_name !== timelineProviderQuestion(message)) return null;
  const booking = object(provider.booking);
  const application = object(booking.application);
  const schedule = object(provider.schedule_type);
  const notice = text(schedule.advance_notice);
  let reservation = notice ? `Recorded advance booking notice: ${notice}.` : 'Advance booking notice is not recorded; confirm it with the provider.';
  // Only interpret an unambiguous day count/range. Never infer notice from
  // enrollment, application duration, service hours, or an ambiguous window.
  const days = notice?.match(/^(?:at least\s+)?(\d+)(?:\s*[-–]\s*\d+)?\s*(?:calendar\s+)?days?$/i);
  if (/\btomorrow\b/i.test(message)) {
    reservation += days && Number(days[1]) > 1
      ? ' Do not expect a ride tomorrow, even if you are already enrolled; the provider must confirm availability.'
      : ' Contact the provider to confirm whether a ride tomorrow is possible; enrollment does not guarantee availability.';
  }
  const requirement = application.required === true ? 'An application is required before your first ride.'
    : application.required === false ? 'No initial application is required according to the recorded information.'
    : 'Confirm first-ride application or enrollment requirements with the provider.';
  const duration = processingTime(application.processing_time);
  const processing = application.required === false ? '' : duration
    ? ` Recorded application processing time: ${duration}; this is separate from booking notice.`
    : ' Application processing time is not recorded; confirm it with the provider.';
  const contacts = Array.isArray(provider.contacts) ? provider.contacts.map(object) : [];
  const phone = [provider.phone, booking.phone, booking.method === 'call' ? booking.details : null, ...contacts.map(contact => contact.phone)]
    .map(text).find(value => value && /^[+()\d\s.−-]+$/.test(value) && value.replace(/\D/g, '').length >= 10);
  const website = text(application.source_url) || text(provider.website);
  const contact = phone ? `Call ${phone} to confirm requirements and availability.`
    : website && /^https:\/\//i.test(website) ? `Contact the provider through [its website](${website}) to confirm requirements and availability.`
    : 'Contact the provider directly to confirm requirements and availability.';
  return `- **Booking:** ${reservation}\n- **Before your first ride:** ${requirement}${processing}\n- **Next step:** ${contact}`;
}
