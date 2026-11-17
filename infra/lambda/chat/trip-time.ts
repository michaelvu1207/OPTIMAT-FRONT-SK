export interface TripTimeState {
  local_date: string;
  route?: string;
  date_hint?: string;
  pending?: string;
  pickup?: string;
  arrival?: string;
}
export interface TripTimeContext { tripTime?: TripTimeState }

const CLOCK = '(?:noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|\\d{1,2}:\\d{2})';
function clockKey(value: string): number | null {
  const time = value.trim().toLowerCase().replace(/\./g, '');
  if (time === 'noon') return 720;
  if (time === 'midnight') return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(time);
  if (!match || (!match[3] && !time.includes(':'))) return null;
  const hour = Number(match[1]); const minute = Number(match[2] || 0);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  return (match[3] ? hour % 12 + (match[3] === 'pm' ? 12 : 0) : hour) * 60 + minute;
}

// Scope hints only decide when to discard an answer; they never supply a route,
// travel date, pickup time, or eligibility fact to a provider search.
function scopeHints(message: string) {
  const route = /\bfrom\s+(.{1,300}?)\s+to\s+(.{1,300}?)(?=\s+(?:today|tomorrow|on|at|with|for|departing|leaving)\b|[.!?\n]|$)/i.exec(message);
  const date = /\b(?:day after tomorrow|today|tomorrow|(?:(?:next|this)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?)\b/i.exec(message);
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  return { route: route ? normalize(`${route[1]} -> ${route[2]}`) : undefined, date_hint: date ? normalize(date[0]) : undefined };
}

export function updateTripTime(turn: TripTimeContext, message: string, now = new Date()): void {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const hints = scopeHints(message);
  const previous = turn.tripTime;
  const newTrip = /\b(?:new|another|different|separate|next)\s+(?:trip|ride|journey)\b|\bstart (?:a )?new (?:trip|ride|journey)\b|\bstart over\b/i.test(message);
  const changed = !previous || previous.local_date !== localDate || newTrip ||
    Boolean(hints.route && previous.route !== hints.route) ||
    Boolean(hints.date_hint && previous.date_hint !== hints.date_hint);
  const state: TripTimeState = changed ? { local_date: localDate, ...hints } : { ...previous, ...Object.fromEntries(Object.entries(hints).filter(([, value]) => value)) };
  turn.tripTime = state;

  let meaning: 'pickup' | 'arrival' | undefined;
  let time: string | undefined;
  const pickup = new RegExp(`^(${CLOCK}) is my requested pickup time[.!]?$`, 'i').exec(message.trim()) ||
    new RegExp(`^(?:actually[, ]+)?(?:my (?:requested )?pickup time is|please pick me up at|i (?:need|want) to (?:leave|depart) at)\\s+(${CLOCK})[.!]?$`, 'i').exec(message.trim());
  const arrival = new RegExp(`^(?:actually[, ]+)?(?:i (?:need|want) to arrive (?:by|at)|my arrival time is|my appointment is at)\\s+(${CLOCK})(?:\\. This is not my pickup time)?[.!]?$`, 'i').exec(message.trim());
  if (pickup) { meaning = 'pickup'; time = pickup[1]; }
  else if (arrival) { meaning = 'arrival'; time = arrival[1]; }
  else if (state.pending && /^(?:i mean )?(?:my )?(pickup|arrival)(?: time)?[.!]?$/i.test(message.trim())) {
    meaning = /pickup/i.test(message) ? 'pickup' : 'arrival'; time = state.pending;
  }
  if (!meaning || !time || clockKey(time) === null) return;
  const other = meaning === 'pickup' ? 'arrival' : 'pickup';
  if (state[other] && clockKey(state[other]!) === clockKey(time)) delete state[other];
  state[meaning] = time.trim();
  delete state.pending;
}

export function knownTripTime(turn: TripTimeContext, time: string): 'pickup' | 'arrival' | null {
  const key = clockKey(time);
  if (key === null) return null;
  for (const meaning of ['pickup', 'arrival'] as const) {
    const stored = turn.tripTime?.[meaning];
    if (stored && clockKey(stored) === key) return meaning;
  }
  return null;
}

export function tripTimeFactsBlock(turn: TripTimeContext): string {
  const state = turn.tripTime;
  const facts = { pickup: state?.pickup, arrival: state?.arrival };
  return `Explicitly clarified times for the current trip: ${JSON.stringify(facts)}. Reuse these meanings without asking again. An arrival time does not supply a pickup time; ask for the desired pickup time if it is missing. Do not invent a travel-time buffer.`;
}
