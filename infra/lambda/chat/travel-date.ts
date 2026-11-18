export interface TravelDateState { raw: string; iso: string | null; display: string | null; error: string | null }
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const weekday = days.join('|');
const month = months.map(m => `${m}|${m.slice(0, 3)}\\.?`).join('|');
const calendarPattern = `(?:(?:${weekday})\\s*,?\\s+)?(?:\\d{4}-\\d{1,2}-\\d{1,2}|(?:${month})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}/\\d{1,2}/\\d{4})`;
const localToday = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const format = (date: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
const calendar = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
};

/** Resolve only the date phrase, never numbers from street addresses or pickup times. */
export function resolveTravelDate(raw: string, now = new Date()): TravelDateState {
  const result: TravelDateState = { raw, iso: null, display: null, error: null };
  const today = new Date(`${localToday(now)}T00:00:00Z`);
  const text = raw.trim().replace(/^(?:on|for)\s+/i, '').replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  const namedDay = days.findIndex(d => new RegExp(`\\b${d}\\b`, 'i').test(text));
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const named = text.match(new RegExp(`\\b(${month})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, 'i'));
  let date: Date | null = null;
  if (iso) date = calendar(+iso[1], +iso[2], +iso[3]);
  else if (numeric) date = calendar(+numeric[3], +numeric[1], +numeric[2]);
  else if (named) {
    const monthIndex = months.findIndex(m => m.toLowerCase().startsWith(named[1].replace('.', '').toLowerCase()));
    const year = named[3] ? +named[3] : today.getUTCFullYear();
    date = calendar(year, monthIndex + 1, +named[2]);
    if (!named[3] && date && date < today) date = calendar(year + 1, monthIndex + 1, +named[2]);
  } else {
    date = new Date(today);
    let offset: number | null = /^today$/i.test(text) ? 0 : /^tomorrow$/i.test(text) ? 1 : /^the day after tomorrow$/i.test(text) ? 2 : null;
    const inDays = text.match(/^in (\d{1,3}) days?$/i);
    if (inDays) offset = +inDays[1];
    if (namedDay >= 0 && new RegExp(`^(?:(?:next|this|coming)\\s+)?(?:${weekday})$`, 'i').test(text)) {
      offset = (namedDay - today.getUTCDay() + 7) % 7;
      // "next Friday" is the next occurrence, not an extra week later.
      if (offset === 0 && !/^this /i.test(text)) offset = 7;
    }
    if (offset === null) date = null;
    else date.setUTCDate(date.getUTCDate() + offset);
  }
  if (!date) return { ...result, error: 'Please provide a valid travel date, including month, day, and year.' };
  if (namedDay >= 0 && date.getUTCDay() !== namedDay) return { ...result, error: `${format(date)} is the calendar date you entered. Did you mean that date or ${days[namedDay]}?` };
  return { ...result, iso: date.toISOString().slice(0, 10), display: format(date) };
}

export function dateFromMessage(message: string, now = new Date()): TravelDateState | undefined {
  const explicit = [...message.matchAll(new RegExp(`\\b${calendarPattern}\\b`, 'gi'))].map(m => m[0]);
  const relative = [...message.matchAll(new RegExp(`\\b(?:the day after tomorrow|today|tomorrow|in \\d{1,3} days?|(?:next|this|coming|on|for) (?:${weekday})(?!\\s+(?:Street|St|Road|Rd|Lane|Ln)\\b))\\b`, 'gi'))].map(m => m[0]);
  const bare = message.trim().match(new RegExp(`^(?:on |for )?(${weekday})[.!]?$`, 'i'))?.[1];
  // Explicit dates take precedence over conversational references such as "today".
  const phrases = explicit.length ? explicit : relative.length ? relative : bare ? [bare] : [];
  if (!phrases.length) return undefined;
  const resolved = phrases.map(raw => resolveTravelDate(raw, now));
  if (new Set(resolved.map(r => r.iso || r.raw)).size > 1) return { raw: phrases.join('; '), iso: null, display: null, error: 'You mentioned more than one travel date. Which date should I use for this trip?' };
  return resolved[0];
}

export function travelDateBlock(date?: TravelDateState): string {
  if (!date) return 'No server-resolved travel date yet. Use resolve_trip_date with the rider’s exact date phrase before searching; never calculate a weekday yourself.';
  if (date.error) return `Travel date needs clarification: ${date.error} Do not search until the rider clarifies.`;
  return `AUTHORITATIVE TRAVEL DATE: ${date.iso} (${date.display}), resolved from "${date.raw}" by the server in America/Los_Angeles. Use this exact date in every trip summary and find_providers call, even when older assistant messages disagree. Do not challenge its weekday. A date-only correction does not change other trip details.`;
}

/** Detect impossible weekday/date claims and conflicting trip-date labels before publishing. */
export function invalidDateResponse(message: string, date?: TravelDateState): boolean {
  for (const match of message.matchAll(new RegExp(`\\b${calendarPattern}\\b`, 'gi'))) {
    const parsed = resolveTravelDate(match[0]);
    if (parsed.error) return true;
    const before = message.slice(Math.max(0, match.index! - 30), match.index).replace(/\*/g, '');
    if (date?.iso && /(?:trip|travel)?\s*date\s*:\s*$/i.test(before) && parsed.iso !== date.iso) return true;
    const after = message.slice(match.index! + match[0].length);
    const assertion = after.match(new RegExp(`^\\s+is (?:a |an )?(${weekday})\\b`, 'i'));
    if (assertion && parsed.display && !parsed.display.toLowerCase().startsWith(assertion[1].toLowerCase())) return true;
  }
  return false;
}
