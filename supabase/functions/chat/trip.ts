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

export type EligibilityStatus = "eligible" | "ineligible" | "verification_required";

export interface EligibilityEvaluation {
  status: EligibilityStatus;
  reason: string;
  requirement: string;
}

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

export const BAY_AREA_CITIES = [
  "Alameda",
  "Albany",
  "American Canyon",
  "Antioch",
  "Atherton",
  "Belmont",
  "Belvedere",
  "Benicia",
  "Berkeley",
  "Brentwood",
  "Brisbane",
  "Burlingame",
  "Calistoga",
  "Campbell",
  "Clayton",
  "Cloverdale",
  "Colma",
  "Concord",
  "Corte Madera",
  "Cotati",
  "Cupertino",
  "Daly City",
  "Danville",
  "Dixon",
  "Dublin",
  "East Palo Alto",
  "El Cerrito",
  "Emeryville",
  "Fairfax",
  "Fairfield",
  "Foster City",
  "Fremont",
  "Gilroy",
  "Half Moon Bay",
  "Hayward",
  "Healdsburg",
  "Hercules",
  "Hillsborough",
  "Lafayette",
  "Larkspur",
  "Livermore",
  "Los Altos",
  "Los Altos Hills",
  "Los Gatos",
  "Martinez",
  "Menlo Park",
  "Mill Valley",
  "Millbrae",
  "Milpitas",
  "Moraga",
  "Morgan Hill",
  "Mountain View",
  "Napa",
  "Newark",
  "Novato",
  "Oakland",
  "Oakley",
  "Orinda",
  "Pacifica",
  "Palo Alto",
  "Petaluma",
  "Piedmont",
  "Pinole",
  "Pittsburg",
  "Pleasant Hill",
  "Pleasanton",
  "Portola Valley",
  "Redwood City",
  "Richmond",
  "Rio Vista",
  "Rohnert Park",
  "Ross",
  "San Anselmo",
  "San Bruno",
  "San Carlos",
  "San Francisco",
  "San Jose",
  "San Leandro",
  "San Mateo",
  "San Pablo",
  "San Rafael",
  "San Ramon",
  "Santa Clara",
  "Santa Rosa",
  "Saratoga",
  "Sausalito",
  "Sebastopol",
  "Sonoma",
  "South San Francisco",
  "St. Helena",
  "Suisun City",
  "Sunnyvale",
  "Tiburon",
  "Union City",
  "Vacaville",
  "Vallejo",
  "Walnut Creek",
  "Windsor",
  "Woodside",
  "Yountville",
  "Bay Point",
  "El Sobrante",
  "Kensington",
  "North Richmond",
].sort((a, b) => b.length - a.length);

const CONTRA_COSTA_CITIES = new Set(
  [
    "Antioch",
    "Bay Point",
    "Brentwood",
    "Clayton",
    "Concord",
    "Danville",
    "El Cerrito",
    "El Sobrante",
    "Hercules",
    "Kensington",
    "Lafayette",
    "Martinez",
    "Moraga",
    "North Richmond",
    "Oakley",
    "Orinda",
    "Pinole",
    "Pittsburg",
    "Pleasant Hill",
    "Richmond",
    "San Pablo",
    "San Ramon",
    "Walnut Creek",
  ].map(normalizeCity),
);

function normalizeCity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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

function requirementText(requirements: unknown): string {
  if (requirements === null || requirements === undefined) return "";
  if (typeof requirements === "string") {
    const trimmed = requirements.trim();
    // The JSONB column holds either prose or a JSON-encoded list of rule objects.
    if (/^[[{]/.test(trimmed)) {
      try {
        return requirementText(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  // Separate structured rules are alternatives: matching any one of them qualifies.
  if (Array.isArray(requirements)) {
    return requirements.map(requirementText).filter(Boolean).join(" or ");
  }
  if (typeof requirements === "object") {
    const record = requirements as Record<string, unknown>;
    const nested = record.eligibility ?? record.eligibility_text ?? record.eligibility_reqs;
    if (nested !== undefined && nested !== null) return requirementText(nested);
    if (typeof record.type === "string" && record.type.trim()) return record.type.trim();
    return JSON.stringify(record);
  }
  return String(requirements);
}

/**
 * True when the requirement is decided by the rider's age. This mirrors the senior check in
 * `evaluateEligibility` — the only place an age is consulted — so the search never stops to ask
 * for an age that cannot change a verdict. A disability floor such as "Disabled (18+)" is decided
 * by disability status, not age.
 */
export function requiresRiderAge(requirements: unknown): boolean {
  const text = requirementText(requirements).toLowerCase();
  if (!text || /^(none|n\/a|no eligibility requirements?)\.?$/.test(text)) return false;
  if (/open to (the )?general public/.test(text)) return false;
  return /\bsenior\b/.test(text);
}

function hasKnownRiderFacts(rider: RiderEligibility): boolean {
  return (
    Number.isFinite(rider.age) ||
    typeof rider.disabled === "boolean" ||
    typeof rider.ada_certified === "boolean" ||
    typeof rider.veteran === "boolean" ||
    Boolean(rider.residence_city?.trim())
  );
}

function riderResidenceMatches(text: string, residenceCity: string): boolean | null {
  const normalizedResidence = normalizeCity(residenceCity);
  if (/contra costa county resident/.test(text)) return CONTRA_COSTA_CITIES.has(normalizedResidence);

  const namedCommunities = ["Rossmoor"];
  const mentionedCommunity = namedCommunities.find((community) =>
    new RegExp(`\\b${community}\\b`, "i").test(text)
  );
  if (mentionedCommunity) return normalizeCity(mentionedCommunity) === normalizedResidence;

  const mentionedCities = BAY_AREA_CITIES.filter((city) =>
    new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
  );
  if (mentionedCities.length === 0) return null;
  return mentionedCities.some((city) => normalizeCity(city) === normalizedResidence);
}

export function evaluateEligibility(requirements: unknown, rider: RiderEligibility = {}): EligibilityEvaluation {
  const requirement = requirementText(requirements);
  const text = requirement.toLowerCase();

  if (!text || /^(none|n\/a|no eligibility requirements?)\.?$/.test(text) || /open to (the )?general public/.test(text)) {
    return { status: "eligible", reason: "Open to the general public.", requirement: requirement || "None" };
  }

  if (rider.declined || !hasKnownRiderFacts(rider)) {
    return {
      status: "verification_required",
      reason: "Rider eligibility was not provided; verify the provider requirements before booking.",
      requirement,
    };
  }

  const categoryChecks: Array<{ label: string; value: boolean | null }> = [];
  const seniorMatch = text.match(/senior[^\d]{0,12}(\d{2})\s*\+/);
  if (/\bsenior\b/.test(text)) {
    const minimumAge = seniorMatch ? Number(seniorMatch[1]) : 60;
    categoryChecks.push({
      label: `age ${minimumAge}+`,
      value: Number.isFinite(rider.age) ? Number(rider.age) >= minimumAge : null,
    });
  }

  if (/\bveteran\b/.test(text)) {
    categoryChecks.push({ label: "veteran", value: typeof rider.veteran === "boolean" ? rider.veteran : null });
  }

  if (/\bdisabled|disability\b/.test(text)) {
    const requiresAda = /ada[- ]?(eligible|certif)|certification.*ada/.test(text);
    const value = requiresAda
      ? typeof rider.ada_certified === "boolean"
        ? rider.ada_certified
        : null
      : typeof rider.disabled === "boolean"
        ? rider.disabled || rider.ada_certified === true
        : typeof rider.ada_certified === "boolean"
          ? rider.ada_certified
          : null;
    categoryChecks.push({ label: requiresAda ? "ADA-certified disability" : "disability", value });
  }

  let categoryStatus: boolean | null = true;
  if (categoryChecks.length > 0) {
    const usesOr = /\bor\b/.test(text);
    if (usesOr) {
      categoryStatus = categoryChecks.some((check) => check.value === true)
        ? true
        : categoryChecks.some((check) => check.value === null)
          ? null
          : false;
    } else {
      categoryStatus = categoryChecks.some((check) => check.value === false)
        ? false
        : categoryChecks.some((check) => check.value === null)
          ? null
          : true;
    }
  }

  const requiresResidency = /\bresiden(?:t|ts|cy)\b/.test(text);
  let residencyStatus: boolean | null = true;
  if (requiresResidency) {
    residencyStatus = rider.residence_city?.trim()
      ? riderResidenceMatches(text, rider.residence_city)
      : null;
  }

  // Requirement text that states something but names no category or residency rule cannot be
  // decided here. Unknown must never read as eligible.
  if (categoryChecks.length === 0 && !requiresResidency) {
    return {
      status: "verification_required",
      reason: "This provider's eligibility requirement could not be interpreted automatically; confirm it with the provider.",
      requirement,
    };
  }

  if (categoryStatus === false || residencyStatus === false) {
    const failed: string[] = [];
    if (categoryStatus === false) failed.push(categoryChecks.map((check) => check.label).join(" or "));
    if (residencyStatus === false) failed.push("residency");
    return {
      status: "ineligible",
      reason: `The rider does not match the provider's ${failed.join(" and ")} requirement.`,
      requirement,
    };
  }

  if (categoryStatus === null || residencyStatus === null) {
    return {
      status: "verification_required",
      reason: "More information or provider verification is needed to confirm eligibility.",
      requirement,
    };
  }

  return {
    status: "eligible",
    reason: "The rider information matches the stated eligibility requirements.",
    requirement,
  };
}

export function extractBayAreaCity(value: string): string | null {
  const text = String(value || "");
  return (
    BAY_AREA_CITIES.find((city) =>
      new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    ) || null
  );
}

export function getLocationMismatch(
  requestedAddress: string,
  resolvedAddress: string,
): { requestedCity: string; resolvedCity: string; message: string } | null {
  const requestedCity = extractBayAreaCity(requestedAddress);
  const resolvedCity = extractBayAreaCity(resolvedAddress);
  if (!requestedCity || !resolvedCity || normalizeCity(requestedCity) === normalizeCity(resolvedCity)) return null;

  return {
    requestedCity,
    resolvedCity,
    message: `“${requestedAddress}” resolved to ${resolvedAddress}, which is in ${resolvedCity}, not ${requestedCity}. Please confirm the destination before I search providers.`,
  };
}
