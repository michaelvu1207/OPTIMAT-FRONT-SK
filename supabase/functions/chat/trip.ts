export const SERVICE_TIME_ZONE = "America/Los_Angeles";

export type TripType = "one_way" | "round_trip";
export type TimeIntent = "depart_at" | "arrive_by";

export interface RiderEligibility {
  age?: number | null;
  disabled?: boolean | null;
  ada_certified?: boolean | null;
  veteran?: boolean | null;
  residence_city?: string | null;
  declined?: boolean;
}

/**
 * Who decides eligibility, and why it is no longer decided here.
 *
 * This module used to parse `eligibility_reqs` prose with regular expressions and return a
 * verdict. That worked on the common shape ("Senior (65+) or disabled (18+). And must be a
 * Concord resident.") and failed on everything that needed world knowledge. The clearest case:
 * Mobility Matters requires a "Contra Costa County resident", which was checked against a
 * hand-written set of city names — so a 70-year-old in Alamo or Rodeo, both plainly in Contra
 * Costa County, came back INELIGIBLE and was dropped from the results. No list of towns is ever
 * finished, and every gap silently denies a rider a ride they qualify for.
 *
 * The verdict now comes from the assistant, which reads the same prose and already knows which
 * communities are in the county. The server's job is narrower and enforceable: it decides which
 * providers are candidates (geography and service hours — real computation), then checks that
 * the assistant returned a verdict for every one of them. See `assess_eligibility` in tools.ts.
 */
export type EligibilityStatus = "eligible" | "ineligible" | "verification_required";

/** Rider facts an eligibility rule can turn on. */
export type RiderFact = "age" | "disabled" | "ada_certified" | "veteran" | "residence_city";

export const RIDER_FACTS: RiderFact[] = ["age", "disabled", "ada_certified", "veteran", "residence_city"];

export interface ResolvedTravelDate {
  ok: boolean;
  iso: string | null;
  display: string | null;
  error: string | null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const MONTH_ALIASES = new Map<string, number>([
  ...MONTHS.map((month, index) => [month, index + 1] as [string, number]),
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["sept", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function normalizeCity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Compare the city the rider named against the city the geocoder actually landed in.
 *
 * Both sides are now authoritative strings — the assistant reports the rider's own wording, and
 * Google reports the locality of the matched place — so this is a normalized equality test and
 * nothing more. It replaces a 105-entry city list that was scanned longest-name-first, which
 * meant a street named after another town won: asking for "Danville" and correctly resolving to
 * "2601 San Ramon Valley Blvd, Danville" reported a mismatch with San Ramon and stopped the
 * search. It also could not see Alamo, Rodeo, Crockett or Discovery Bay at all.
 */
export function citiesMatch(requested: string | null | undefined, resolved: string | null | undefined): boolean {
  const a = normalizeCity(String(requested || ""));
  const b = normalizeCity(String(resolved || ""));
  if (!a || !b) return true;
  return a === b;
}

function getServiceDateParts(now: Date, timeZone = SERVICE_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    time: `${parts.hour}:${parts.minute} ${parts.dayPeriod}`,
  };
}

function isoDate(year: number, month: number, day: number): string | null {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(year: number, month: number, day: number, amount: number) {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatTravelDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function getServiceClockContext(now = new Date(), timeZone = SERVICE_TIME_ZONE): string {
  const parts = getServiceDateParts(now, timeZone);
  return `${parts.weekday}, ${MONTHS[parts.month - 1][0].toUpperCase()}${MONTHS[parts.month - 1].slice(1)} ${parts.day}, ${parts.year} at ${parts.time} (${timeZone})`;
}

export function resolveTravelDate(
  rawValue: string,
  now = new Date(),
  timeZone = SERVICE_TIME_ZONE,
): ResolvedTravelDate {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return { ok: false, iso: null, display: null, error: "What date would you like to travel?" };
  }

  const serviceDate = getServiceDateParts(now, timeZone);
  const todayIso = isoDate(serviceDate.year, serviceDate.month, serviceDate.day)!;
  const normalized = raw.toLowerCase().replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1");
  let resolved: string | null = null;

  if (/\btoday\b/.test(normalized)) {
    resolved = todayIso;
  } else if (/\btomorrow\b/.test(normalized)) {
    const tomorrow = addDays(serviceDate.year, serviceDate.month, serviceDate.day, 1);
    resolved = isoDate(tomorrow.year, tomorrow.month, tomorrow.day);
  }

  if (!resolved) {
    const isoMatch = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (isoMatch) resolved = isoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  if (!resolved) {
    const numericMatch = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?\b/);
    if (numericMatch) {
      let year = numericMatch[3] ? Number(numericMatch[3]) : serviceDate.year;
      if (year < 100) year += 2000;
      const month = Number(numericMatch[1]);
      const day = Number(numericMatch[2]);
      let candidate = isoDate(year, month, day);
      if (!numericMatch[3] && candidate && candidate < todayIso) candidate = isoDate(year + 1, month, day);
      resolved = candidate;
    }
  }

  if (!resolved) {
    const monthPattern = Array.from(MONTH_ALIASES.keys()).sort((a, b) => b.length - a.length).join("|");
    const monthMatch = normalized.match(new RegExp(`\\b(${monthPattern})\\.?\\s+(\\d{1,2})(?:[^\\d]{0,4}(\\d{4}))?`, "i"));
    if (monthMatch) {
      const month = MONTH_ALIASES.get(monthMatch[1].toLowerCase())!;
      const day = Number(monthMatch[2]);
      const hasYear = Boolean(monthMatch[3]);
      let year = hasYear ? Number(monthMatch[3]) : serviceDate.year;
      let candidate = isoDate(year, month, day);
      if (!hasYear && candidate && candidate < todayIso) candidate = isoDate(year + 1, month, day);
      resolved = candidate;
    }
  }

  // "the 12th of August" — the way a date is more often spoken than written. Ordinal suffixes
  // have already been stripped above, so this sees "the 12 of august".
  if (!resolved) {
    const monthPattern = Array.from(MONTH_ALIASES.keys()).sort((a, b) => b.length - a.length).join("|");
    const ofMonthMatch = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+of\\s+(${monthPattern})\\.?(?:[^\\d]{0,4}(\\d{4}))?`, "i"));
    if (ofMonthMatch) {
      const day = Number(ofMonthMatch[1]);
      const month = MONTH_ALIASES.get(ofMonthMatch[2].toLowerCase())!;
      const hasYear = Boolean(ofMonthMatch[3]);
      const year = hasYear ? Number(ofMonthMatch[3]) : serviceDate.year;
      let candidate = isoDate(year, month, day);
      if (!hasYear && candidate && candidate < todayIso) candidate = isoDate(year + 1, month, day);
      resolved = candidate;
    }
  }

  // A bare day of the month — "the 12th" — means the next time that date comes around.
  if (!resolved) {
    const dayOnlyMatch = normalized.match(/\bthe\s+(\d{1,2})\b/);
    if (dayOnlyMatch) {
      const day = Number(dayOnlyMatch[1]);
      if (day >= 1 && day <= 31) {
        let candidate = isoDate(serviceDate.year, serviceDate.month, day);
        if (!candidate || candidate < todayIso) {
          const nextMonth = serviceDate.month === 12 ? 1 : serviceDate.month + 1;
          const nextYear = serviceDate.month === 12 ? serviceDate.year + 1 : serviceDate.year;
          candidate = isoDate(nextYear, nextMonth, day);
        }
        resolved = candidate;
      }
    }
  }

  // A weekday on its own. Checked last: a rider who says "Tuesday the 11th of August" is naming a
  // specific date and only incidentally its weekday, and resolving the weekday instead silently
  // produced a trip on the wrong day.
  if (!resolved) {
    const weekdayIndex = WEEKDAYS.findIndex((weekday) => new RegExp(`\\b${weekday}\\b`, "i").test(normalized));
    if (weekdayIndex >= 0) {
      const currentWeekday = WEEKDAYS.indexOf(serviceDate.weekday.toLowerCase());
      let daysAhead = (weekdayIndex - currentWeekday + 7) % 7;
      if (daysAhead === 0 || /\bnext\b/.test(normalized)) daysAhead += 7;
      const target = addDays(serviceDate.year, serviceDate.month, serviceDate.day, daysAhead);
      resolved = isoDate(target.year, target.month, target.day);
    }
  }

  // When a rider names both a weekday and a date that disagree, one of them is a mistake and
  // guessing which would put them in a vehicle on the wrong day. Ask instead.
  if (resolved) {
    const namedWeekday = WEEKDAYS.findIndex((weekday) => new RegExp(`\\b${weekday}\\b`, "i").test(normalized));
    if (namedWeekday >= 0) {
      const [year, month, day] = resolved.split("-").map(Number);
      const actualWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      if (actualWeekday !== namedWeekday) {
        const capitalize = (value: string) => value[0].toUpperCase() + value.slice(1);
        return {
          ok: false,
          iso: null,
          display: null,
          error: `${formatTravelDate(resolved)} is a ${capitalize(WEEKDAYS[actualWeekday])}, not a ${
            capitalize(WEEKDAYS[namedWeekday])
          }. Which did you mean?`,
        };
      }
    }
  }

  if (!resolved) {
    return {
      ok: false,
      iso: null,
      display: null,
      error: `I couldn't determine the travel date from “${raw}.” What exact date would you like to travel?`,
    };
  }

  if (resolved < todayIso) {
    return {
      ok: false,
      iso: null,
      display: null,
      error: `${formatTravelDate(resolved)} has already passed. What future date would you like to travel?`,
    };
  }

  return { ok: true, iso: resolved, display: formatTravelDate(resolved), error: null };
}

