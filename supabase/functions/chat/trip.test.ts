import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { citiesMatch, getServiceClockContext, resolveTravelDate } from "./trip.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("relative and incomplete dates use the service-timezone clock", () => {
  const clock = new Date("2026-07-09T19:00:00Z");
  assert(resolveTravelDate("tomorrow", clock).iso === "2026-07-10", "tomorrow should be July 10");
  assert(resolveTravelDate("July 21", clock).iso === "2026-07-21", "July 21 should stay in 2026");
  assert(resolveTravelDate("July 21ar", clock).iso === "2026-07-21", "minor suffix typo should still resolve");
  assert(resolveTravelDate("Tuesday", clock).iso === "2026-07-14", "Tuesday should mean the next Tuesday");
});

Deno.test("past explicit dates are rejected", () => {
  const result = resolveTravelDate("July 21, 2025", new Date("2026-07-09T19:00:00Z"));
  assert(!result.ok, "past date should fail");
  assert(result.error?.includes("already passed"), "past-date error should be actionable");
});

Deno.test("service clock is explicit about timezone", () => {
  const context = getServiceClockContext(new Date("2026-07-10T01:30:00Z"));
  assert(context.includes("July 9, 2026"), "UTC rollover must not change the California date");
  assert(context.includes("America/Los_Angeles"), "clock context should name the timezone");
});

Deno.test("dates spoken the way riders say them resolve correctly", () => {
  // Found by recording example conversations in a rider's own voice: every eval scenario had
  // used machine phrasing ("August 12, 2026"), so none of this was exercised.
  const clock = new Date("2026-07-27T19:00:00Z");

  // "the Nth of Month" previously failed outright.
  assertEquals(resolveTravelDate("the 12th of August", clock).iso, "2026-08-12");
  assertEquals(resolveTravelDate("the 11th of August", clock).iso, "2026-08-11");

  // Worse than failing: a named weekday used to beat the day of the month, so a rider asking
  // for August 11 was quietly given July 28.
  assertEquals(resolveTravelDate("Tuesday the 11th of August", clock).iso, "2026-08-11");
  assertEquals(resolveTravelDate("Wednesday the 12th", clock).iso, "2026-08-12");

  // A bare day of the month means its next occurrence.
  assertEquals(resolveTravelDate("the 3rd", clock).iso, "2026-08-03");
  assertEquals(resolveTravelDate("the 29th", clock).iso, "2026-07-29");

  // Weekday-only phrasing is unchanged.
  assertEquals(resolveTravelDate("Sunday", clock).iso, "2026-08-02");
  assertEquals(resolveTravelDate("next Tuesday", clock).iso, "2026-08-04");
  assertEquals(resolveTravelDate("tomorrow", clock).iso, "2026-07-28");
});

Deno.test("dates counted forward from today resolve", () => {
  // Reported from a live session: "3 days from now" fell through every calendar pattern and the
  // assistant asked the rider to convert it to a calendar date themselves.
  const clock = new Date("2026-07-27T19:00:00Z"); // Monday, July 27

  assertEquals(resolveTravelDate("3 days from now", clock).iso, "2026-07-30");
  assertEquals(resolveTravelDate("in 3 days", clock).iso, "2026-07-30");
  assertEquals(resolveTravelDate("three days from today", clock).iso, "2026-07-30");
  assertEquals(resolveTravelDate("in a week", clock).iso, "2026-08-03");
  assertEquals(resolveTravelDate("two weeks from now", clock).iso, "2026-08-10");
  assertEquals(resolveTravelDate("the day after tomorrow", clock).iso, "2026-07-29");

  // Anchored to a weekday rather than to today: the next Friday is July 31, a week past it is
  // August 7.
  assertEquals(resolveTravelDate("a week from Friday", clock).iso, "2026-08-07");

  // The count is a count, not a day of the month: "in 3 days" must not become the 3rd.
  assert(resolveTravelDate("in 3 days", clock).iso !== "2026-08-03", "a count is not a date");

  // Vague spans stay questions. Which day of next week, and how many is a few, are the rider's to
  // say — guessing puts them outside on the wrong morning.
  assertEquals(resolveTravelDate("next week", clock).ok, false);
  assertEquals(resolveTravelDate("in a few days", clock).ok, false);
  assertEquals(resolveTravelDate("in a couple of days", clock).ok, false);
});

Deno.test("a weekday that contradicts the date is asked about, not guessed", () => {
  const clock = new Date("2026-07-27T19:00:00Z");
  const contradiction = resolveTravelDate("Monday the 12th of August", clock);
  assertEquals(contradiction.ok, false, "August 12 is a Wednesday, so this cannot be resolved silently");
  assertStringIncludes(contradiction.error || "", "is a Wednesday, not a Monday");

  // Agreement is accepted without complaint.
  assertEquals(resolveTravelDate("Wednesday, August 12, 2026", clock).iso, "2026-08-12");
});

Deno.test("a city is confirmed by comparing two authoritative names, not by scanning a list", () => {
  // Google's locality for the matched place against the city the rider actually named.
  assert(citiesMatch("Antioch", "Pleasant Hill") === false, "a genuine mismatch is still caught");
  assert(citiesMatch("Richmond", "Richmond"), "an agreeing pair passes");
  assert(citiesMatch("St. Helena", "St Helena"), "punctuation and case are not a mismatch");

  // The regression this replaced: the old check scanned a 105-entry city list longest-name-first,
  // so a street named after another town won. Asking for Danville and correctly landing on
  // "2601 San Ramon Valley Blvd, Danville" was reported as a San Ramon mismatch, and the search
  // was abandoned on a perfectly good address.
  assert(citiesMatch("Danville", "Danville"), "a street named after another city is not a mismatch");

  // Unincorporated communities were invisible to the old list, so nothing about them could be
  // checked at all. They compare like anywhere else now.
  assert(citiesMatch("Alamo", "Alamo"), "Alamo is a place");
  assert(citiesMatch("Rodeo", "Crockett") === false, "two different communities still disagree");

  // Nothing to compare is not a contradiction: riders often name no city, and Google returns no
  // locality for some rural matches. Neither should block a search.
  assert(citiesMatch(null, "Concord"), "an unstated city cannot disagree");
  assert(citiesMatch("Concord", null), "a missing locality cannot disagree");
});
