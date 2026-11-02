// Eligibility boundaries in the provider CSV supplied on 2026-11-02.
// See docs/qa/age-ranges-2026-11-02.md for provenance and limitations.
export const AGE_RANGES = [
  { id: 'under_18', label: 'Under 18', min: 0, max: 17 },
  { id: '18_49', label: '18–49', min: 18, max: 49 },
  { id: '50_54', label: '50–54', min: 50, max: 54 },
  { id: '55_59', label: '55–59', min: 55, max: 59 },
  { id: '60_64', label: '60–64', min: 60, max: 64 },
  { id: '65_plus', label: '65+', min: 65, max: null },
] as const;

export type AgeRangeId = typeof AGE_RANGES[number]['id'];
export type AgeFacts = { age?: number | null; age_range?: AgeRangeId | null };

export function getAgeRange(id: unknown) {
  return AGE_RANGES.find(range => range.id === id) || null;
}

export function ageBounds(facts: AgeFacts): { min: number; max: number } | null {
  if (Number.isInteger(facts.age) && Number(facts.age) >= 0 && Number(facts.age) <= 120) {
    return { min: Number(facts.age), max: Number(facts.age) };
  }
  const range = getAgeRange(facts.age_range);
  return range ? { min: range.min, max: range.max ?? Infinity } : null;
}

export function mergeAgeFacts<T extends AgeFacts>(stored: T, incoming: T): T {
  const merged = { ...stored, ...incoming };
  if (getAgeRange(incoming.age_range)) delete merged.age;
  else if (Number.isInteger(incoming.age) && Number(incoming.age) >= 0 && Number(incoming.age) <= 120) delete merged.age_range;
  return merged;
}

// Only explicit, supported ranges are recognized here. Broader descriptions such
// as "in my 60s" remain unknown until the rider chooses a more useful range.
export function ageRangeFromMessage(message: string): AgeRangeId | null {
  const normalized = message.toLowerCase().replace(/[–—]/g, '-').trim();
  const canonical = normalized.replace(/[.!]$/, '').replace(/\s+to\s+/g, '-').replace(/\s*-\s*/g, '-');
  const bareRange = AGE_RANGES.some(range => range.label.toLowerCase().replace('–', '-') === canonical) || /^65\s+(?:or|and)\s+(?:older|over|above)$/.test(canonical);
  const prefix = bareRange ? canonical : /(?:\bmy age(?: range)? is|\bi(?:'m| am)(?: in (?:the )?(?:age )?(?:range|group))?|\bage(?: range)?\s*[:=])\s+(.*)/.exec(normalized)?.[1];
  if (!prefix) return null;
  if (/^under\s+18\b/.test(prefix)) return 'under_18';
  if (/^65\s*(?:\+|(?:or|and)\s+(?:older|over|above))/.test(prefix)) return '65_plus';
  for (const range of AGE_RANGES) {
    if (range.max !== null && new RegExp(`^${range.min}\\s*(?:-|to)\\s*${range.max}\\b`).test(prefix)) return range.id;
  }
  return null;
}

export function exactAgeFromMessage(message: string): number | null {
  const match = /\b(?:my age is|i(?:'m| am)(?: aged)?)\s+(\d{1,3})(?!\s+(?:or|and)\s+(?:older|over|above))(?:\s+years?\s+old\b|(?=\s*(?:[,.!?]|$|\band\b)))/i.exec(message);
  const age = match ? Number(match[1]) : NaN;
  return Number.isInteger(age) && age >= 0 && age <= 120 ? age : null;
}

export const AGE_RANGE_QUESTION = 'Which age range are you in? We use it to check provider age requirements; you do not need to share your exact age.';

export function ageChoiceData() {
  return { question: AGE_RANGE_QUESTION, options: AGE_RANGES.map(({ id, label }) => ({ id, label })) };
}

// These are comparisons against explicit numeric thresholds, never representative
// ages. A future provider cutoff inside a band must stay unresolved.
export function compareMinimumAge(facts: AgeFacts, minimum: number): 'meets' | 'below' | 'overlaps' | 'unknown' {
  const bounds = ageBounds(facts);
  if (!bounds) return 'unknown';
  if (bounds.min >= minimum) return 'meets';
  if (bounds.max < minimum) return 'below';
  return 'overlaps';
}

/** Only interpret explicit age-category clauses in the supplied provider format.
 * Residence, proof, and unrecognized clauses remain the eligibility assessor's job.
 * An unrecognized rule is never converted to an exclusion here.
 */
export function providerAgeCheck(requirement: unknown, rider: AgeFacts & { disabled?: boolean | null; veteran?: boolean | null }): 'below' | 'possible' | 'overlaps' | 'unspecified' | 'unknown' {
  if (typeof requirement !== 'string' || !ageBounds(rider)) return 'unknown';
  const category = requirement.split(/\bproof\s*:|\.\s*and\b|\band must\b/i)[0];
  if (/^(?:["']?eligibil(?:ity|iity)\s*:\s*)?seniors?\.?\s*$/i.test(category.trim())) return 'unspecified';
  const checks: Array<ReturnType<typeof compareMinimumAge>> = [];
  for (const branch of category.split(/\bor\b/i)) {
    const senior = /\bseniors?\s*\((\d+)\s*\+\)/i.exec(branch);
    const disabled = /\bdisabled\b/i.test(branch);
    if (senior) checks.push(compareMinimumAge(rider, Number(senior[1])));
    else if (disabled) {
      if (rider.disabled !== false) {
        const minimum = /\bdisabled\s*\((\d+)\s*\+\)/i.exec(branch);
        checks.push(compareMinimumAge(rider, minimum ? Number(minimum[1]) : 0));
      }
    } else if (/\bveterans?\b/i.test(branch)) {
      if (rider.veteran !== false) checks.push('meets');
    } else return 'unknown';
  }
  if (!checks.length || checks.includes('unknown')) return 'unknown';
  if (checks.every(check => check === 'below')) return 'below';
  if (checks.includes('meets')) return 'possible';
  return 'overlaps';
}
