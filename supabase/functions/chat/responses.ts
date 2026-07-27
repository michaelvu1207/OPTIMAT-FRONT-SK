/**
 * Response verification.
 *
 * These functions used to *replace* the assistant's answer. A zero-result search discarded the
 * model's entire message and substituted a template, and two more functions prepended and
 * appended sentences on top — which is how a rider who said "I'd rather not give my age" got the
 * previous turn's date sentence back three times in a row, and how one message ended up claiming
 * both "3 transportation provider options" and "no providers".
 *
 * The server still owns the facts. It no longer owns the words: it checks the model's answer
 * against the facts, asks for one correction when they disagree, and only falls back to generated
 * prose if that also fails.
 */

import type { SearchDigest, TripState } from "./state.ts";

export interface ResponseProblem {
  code: string;
  detail: string;
}

const NUMBER_WORDS: Record<string, number> = {
  no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const BOOKING_CLAIM =
  /\b(i'?ll book|i will book|i'?ve booked|i have booked|i'?ve scheduled|i have scheduled|i'?ve arranged|i have arranged|your ride is (booked|scheduled|confirmed)|booking is (complete|confirmed)|i'?ll (send|forward) (your|this) (information|details) to)\b/i;

/**
 * Provider totals the message asserts. Counts qualified by "more", "additional" or "other" are
 * deliberately excluded: "2 providers can take you, 1 more needs verification" is correct, and
 * only an unqualified second total contradicts the first.
 */
export function statedProviderCounts(response: string): Array<{ value: number; phrase: string }> {
  const counts: Array<{ value: number; phrase: string }> = [];
  const pattern =
    /\b(\d{1,3}|no|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more\s+|additional\s+|other\s+|direct\s+|transportation\s+)*provider/gi;
  for (const match of response.matchAll(pattern)) {
    const token = match[1].toLowerCase();
    const value = token in NUMBER_WORDS ? NUMBER_WORDS[token] : Number(token);
    if (!Number.isFinite(value)) continue;
    if (/\b(more|additional|other)\b/i.test(match[0])) continue;
    counts.push({ value, phrase: match[0].trim() });
  }
  return counts;
}

/**
 * Check the assistant's answer against the server-verified facts.
 *
 * Deliberately narrow: every check here is something the server knows for certain. Judging
 * whether a provider name was invented needs the full provider vocabulary and is done in
 * tests/chat/eval.mjs, where a false positive costs a red row rather than a broken rider answer.
 */
export function verifyResponse(response: string, state: TripState): ResponseProblem[] {
  const problems: ResponseProblem[] = [];
  const text = String(response || "");

  if (!text.trim()) {
    problems.push({ code: "empty", detail: "The response was empty." });
    return problems;
  }

  const bookingClaim = text.match(BOOKING_CLAIM);
  if (bookingClaim) {
    problems.push({
      code: "booking_claim",
      detail: `The message claims to book or forward a ride ("${bookingClaim[0]}"). OPTIMAT never books; the rider contacts the provider themselves.`,
    });
  }

  const search: SearchDigest | null = state.last_search;
  if (!search) return problems;

  const counts = statedProviderCounts(text);
  const distinct = [...new Set(counts.map((count) => count.value))];
  if (distinct.length > 1) {
    problems.push({
      code: "contradictory_counts",
      detail: `The message states two different provider totals (${counts.map((count) => `"${count.phrase}"`).join(", ")}). State one total.`,
    });
  }

  // The ceiling is every provider the search touched, not only the usable ones. Counting just the
  // available ones rejected accurate sentences like "all three providers require ADA
  // certification" whenever those three had been ruled out — the rider then lost the model's
  // explanation and got generated prose instead. Inventing providers is still caught, because a
  // count above everything the search saw cannot come from the data.
  const maximumDiscussed = search.eligible.length + search.verification.length +
    search.excluded.length + (search.public_transit?.available ? 1 : 0);
  const overstated = counts.find((count) => count.value > maximumDiscussed);
  if (overstated) {
    problems.push({
      code: "overstated_count",
      detail: `The message says "${overstated.phrase}" but the search only found ${maximumDiscussed} provider(s) in total.`,
    });
  }

  if (search.verification.length > 0) {
    const named = search.verification.filter((note) => text.includes(note.name));
    if (named.length === 0) {
      problems.push({
        code: "verification_omitted",
        detail: `These providers match the trip but their eligibility is unconfirmed and none were mentioned: ${
          search.verification.map((note) => note.name).join(", ")
        }. They must never be dropped silently.`,
      });
    }
  }

  // A ruled-out provider may be discussed — explaining why it will not work is exactly what a
  // rider needs — so this only fires when the provider is named in something that reads as a
  // live recommendation with nothing anywhere nearby saying it is unavailable.
  //
  // The first version matched negation per line against a short word list, and rejected correct
  // answers such as "None of the three can take you — they all require ADA certification"
  // ("none" and "require" were both absent from the list). Every rejection costs the rider the
  // model's answer and substitutes generated prose, so this errs heavily toward accepting.
  const NEGATIVE =
    /\b(no|none|neither|nor|not|n'?t|never|cannot|unfortunately|rule[ds]? out|ruled out|exclude[ds]?|ineligible|require[sd]?|needs?|restricted|limited|only|unless|would need|doesn'?t qualify|isn'?t (?:an )?option|off the table)\b/i;
  const AFFIRMATIVE_RECOMMENDATION =
    /\b(call|phone|book|reserve|your best|i'?d recommend|recommend|can take you|will take you|use them|go with|best fit|easiest)\b/i;

  const paragraphs = text.split(/\n\s*\n/);
  for (const note of search.excluded) {
    const mentions = paragraphs.filter((paragraph) => paragraph.includes(note.name));
    const presentedAsAvailable = mentions.some(
      (paragraph) => AFFIRMATIVE_RECOMMENDATION.test(paragraph) && !NEGATIVE.test(paragraph),
    );
    if (presentedAsAvailable) {
      problems.push({
        code: "excluded_recommended",
        detail: `${note.name} was ruled out (${note.reason || "eligibility did not match"}) but is presented as if the rider could use it.`,
      });
    }
  }

  return problems;
}

/** The correction sent back to the model when its answer disagrees with the facts. */
export function buildCorrectionPrompt(problems: ResponseProblem[]): string {
  return [
    "Your previous answer did not match the verified search results:",
    ...problems.map((problem) => `- ${problem.detail}`),
    "",
    "Rewrite the answer for the rider. Keep your own wording and keep it short; just make it consistent with the facts above.",
  ].join("\n");
}

/**
 * Last-resort answer, generated from the facts when the model's own answer fails verification
 * twice. Plain and complete rather than well-written — it exists so a rider is never handed an
 * empty or self-contradictory message.
 */
export function buildFallbackResponse(state: TripState): string {
  const search = state.last_search;
  const lines: string[] = [];

  if (!search) {
    const missing: string[] = [];
    if (!state.trip.origin) missing.push("where the trip starts");
    if (!state.trip.destination) missing.push("where it is going");
    if (!state.trip.travel_date) missing.push("the travel date");
    if (!state.trip.departure_time) missing.push("the time");
    return missing.length > 0
      ? `I still need ${missing.join(", ")} before I can look for providers.`
      : "I ran into a problem putting that answer together. Could you tell me again what trip you need?";
  }

  const total = search.eligible.length;
  if (total > 0) {
    lines.push(`${total} provider${total === 1 ? "" : "s"} can serve this trip:`);
    for (const note of search.eligible) lines.push(`- ${note.name}`);
  } else if (search.binding_constraint === "geography") {
    lines.push("No provider's service area covers both ends of this trip, so changing the date or time would not help.");
  } else if (search.binding_constraint === "schedule") {
    lines.push("Providers cover this trip, but none operate at the date and time requested.");
  } else {
    lines.push("Providers cover this trip and time, but none match the eligibility details given so far.");
  }

  if (search.verification.length > 0) {
    lines.push(
      "",
      `${search.verification.length === 1 ? "One more provider serves" : `${search.verification.length} more providers serve`} this trip, but ${
        search.verification.length === 1 ? "its" : "their"
      } eligibility has to be confirmed with them directly: ${search.verification.map((note) => note.name).join(", ")}.`,
    );
  }

  if (search.alternatives.length > 0) {
    lines.push("", "Options that would work instead:");
    for (const alternative of search.alternatives) {
      lines.push(`- ${alternative.description}${alternative.providers.length > 0 ? ` (${alternative.providers.join(", ")})` : ""}`);
    }
  }

  if (search.public_transit?.available) {
    lines.push(
      "",
      `Public transit also covers this trip${search.public_transit.duration_text ? ` in about ${search.public_transit.duration_text}` : ""}, though it is not door-to-door.`,
    );
  }

  if (state.trip.origin && state.trip.destination) {
    lines.push("", `Pickup: ${state.trip.origin}`, `Destination: ${state.trip.destination}`);
  }

  return lines.join("\n");
}
