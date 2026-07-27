import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFactsBlock,
  deriveBindingConstraint,
  emptyTripState,
  updateTripStateFromTools,
  type ChatAttachment,
} from "./state.ts";

function attachment(toolName: string, data: unknown): ChatAttachment {
  return { type: "provider_search", data, metadata: { tool_name: toolName } };
}

const RICHMOND_SEARCH = {
  status: "complete",
  travel_date: "2026-08-12",
  travel_date_display: "Wednesday, August 12, 2026",
  departure_time: "12:00 PM",
  outbound_time_intent: "depart_at",
  return_time: null,
  trip_type: "one_way",
  source_address: "Richmond City Hall, 450 Civic Center Plaza, Richmond, CA, USA",
  destination_address: "Kaiser Permanente Richmond Medical Center, Richmond, CA, USA",
  rider_eligibility: { age: 68, disabled: false, ada_certified: false, veteran: false, residence_city: "Richmond" },
  data: [{ provider_name: "R-Transit (Richmond)", eligibility_reason: "Matches the stated requirements." }],
  verification_required: [
    { provider_name: "Richmond Moves", eligibility_reason: "More information is needed.", missing_facts: ["residence_city"] },
  ],
  excluded_providers: [
    { provider_name: "Mobility Matters", reason: "The rider does not match the provider's age 60+ requirement." },
  ],
  diagnostics: {
    geography_match_count: 3,
    schedule_match_count: 3,
    eligible_match_count: 1,
    verification_required_count: 1,
    ineligible_count: 1,
    providers_without_service_hours: 2,
  },
  public_transit: { duration_text: "27 mins" },
};

Deno.test("a completed search becomes the conversation's memory", () => {
  const state = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", RICHMOND_SEARCH)]);

  assertEquals(state.trip.travel_date, "2026-08-12");
  assertEquals(state.trip.trip_type, "one_way");
  assertEquals(state.trip.rider?.age, 68);
  assertEquals(state.trip.coverage, "covered");
  assertEquals(state.last_search?.eligible.map((note) => note.name), ["R-Transit (Richmond)"]);
  assertEquals(state.last_search?.verification[0].missing, ["residence_city"]);
  assertEquals(state.last_search?.excluded[0].name, "Mobility Matters");
  assertEquals(state.last_search?.public_transit?.available, true);
});

Deno.test("the facts block states what is known so it is never asked for twice", () => {
  const state = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", RICHMOND_SEARCH)]);
  const facts = buildFactsBlock(state);

  assertStringIncludes(facts, "do not re-ask");
  assertStringIncludes(facts, "Wednesday, August 12, 2026");
  assertStringIncludes(facts, "age 68");
  assertStringIncludes(facts, "one way");
  // The follow-up "which ones need checking, and why?" is answerable from this alone.
  assertStringIncludes(facts, "Richmond Moves");
  assertStringIncludes(facts, "decided by city of residence");
  assertStringIncludes(facts, "Mobility Matters");
  // Hours are missing from the data, so the requested time must not be presented as verified.
  assertStringIncludes(facts, "no operating hours on file");
  assertStringIncludes(facts, "do not state that the time is available");
});

Deno.test("an unrelated second trip does not inherit the first trip's details", () => {
  const first = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", RICHMOND_SEARCH)]);
  const second = updateTripStateFromTools(first, [attachment("check_trip_coverage", {
    status: "covered",
    source_address: "San Ramon City Hall, San Ramon, CA, USA",
    destination_address: "San Ramon Regional Medical Center, San Ramon, CA, USA",
  })]);

  assertEquals(second.trip.origin, "San Ramon City Hall, San Ramon, CA, USA");
  assertEquals(second.trip.travel_date, undefined, "the previous trip's date must not carry over");
  assertEquals(second.trip.departure_time, undefined, "the previous trip's time must not carry over");
  assertEquals(second.last_search, null, "the previous search result must not describe the new trip");
  // The rider is still the same person, so their eligibility answers survive.
  assertEquals(second.trip.rider?.age, 68);
});

Deno.test("re-searching the same trip updates rather than resets", () => {
  const first = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", RICHMOND_SEARCH)]);
  const second = updateTripStateFromTools(first, [attachment("find_providers", {
    ...RICHMOND_SEARCH,
    departure_time: "3:00 PM",
    data: [],
    verification_required: [],
    diagnostics: { ...RICHMOND_SEARCH.diagnostics, geography_match_count: 3, schedule_match_count: 0, eligible_match_count: 0 },
  })]);

  assertEquals(second.trip.departure_time, "3:00 PM");
  assertEquals(second.trip.origin, RICHMOND_SEARCH.source_address);
  assertEquals(second.last_search?.binding_constraint, "schedule");
});

Deno.test("rider facts accumulate across turns instead of overwriting", () => {
  const first = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", {
    ...RICHMOND_SEARCH,
    rider_eligibility: { disabled: false },
  })]);
  const second = updateTripStateFromTools(first, [attachment("find_providers", {
    ...RICHMOND_SEARCH,
    rider_eligibility: { age: 71 },
  })]);

  assertEquals(second.trip.rider?.age, 71);
  assertEquals(second.trip.rider?.disabled, false, "an earlier answer is not lost when a later turn omits it");
});

Deno.test("a coverage failure is remembered as the binding constraint", () => {
  const state = updateTripStateFromTools(emptyTripState(), [attachment("check_trip_coverage", {
    status: "not_covered",
    source_address: "Diablo Valley College, Pleasant Hill, CA, USA",
    destination_address: "San Francisco City Hall, San Francisco, CA, USA",
  })]);

  assertEquals(state.trip.coverage, "not_covered");
  assertStringIncludes(buildFactsBlock(state), "no provider service area covers both ends");
});

Deno.test("alternatives and the next question survive into the facts block", () => {
  const state = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", {
    ...RICHMOND_SEARCH,
    data: [],
    diagnostics: { ...RICHMOND_SEARCH.diagnostics, eligible_match_count: 0 },
    alternatives: [
      { change: "other_day", description: "the same trip is inside service hours on Tuesday, Wednesday", providers: ["Richmond Moves"], count: 1 },
    ],
    next_question: { field: "age", why: "2 providers can only be decided once this is known", candidates_if_known: 2 },
  })]);

  const facts = buildFactsBlock(state);
  assertStringIncludes(facts, "never as bookings");
  assertStringIncludes(facts, "inside service hours on Tuesday, Wednesday");
  assertStringIncludes(facts, "most useful thing to ask next: exact age");
});

Deno.test("an empty conversation produces no facts block at all", () => {
  assertEquals(buildFactsBlock(emptyTripState()), "");
});

Deno.test("the binding constraint reports the stage that actually stopped the search", () => {
  assertEquals(deriveBindingConstraint({ geography_match_count: 0, schedule_match_count: 0 }, 0), "geography");
  assertEquals(deriveBindingConstraint({ geography_match_count: 2, schedule_match_count: 0 }, 0), "schedule");
  assertEquals(deriveBindingConstraint({ geography_match_count: 2, schedule_match_count: 2 }, 0), "eligibility");
  assertEquals(deriveBindingConstraint({ geography_match_count: 2, schedule_match_count: 2 }, 1), null);
});

Deno.test("the facts block stays compact enough to sit in every turn", () => {
  const state = updateTripStateFromTools(emptyTripState(), [attachment("find_providers", RICHMOND_SEARCH)]);
  const facts = buildFactsBlock(state);
  assert(facts.length < 2_000, `facts block grew to ${facts.length} characters`);
});
