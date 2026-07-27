import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCorrectionPrompt, buildFallbackResponse, statedProviderCounts, verifyResponse } from "./responses.ts";
import type { SearchDigest, TripState } from "./state.ts";

function digest(overrides: Partial<SearchDigest> = {}): SearchDigest {
  return {
    eligible: [],
    verification: [],
    excluded: [],
    public_transit: { available: false },
    binding_constraint: null,
    alternatives: [],
    next_question: null,
    diagnostics: null,
    ...overrides,
  };
}

function state(search: SearchDigest | null, trip: TripState["trip"] = {}): TripState {
  return { trip, last_search: search };
}

const codes = (problems: ReturnType<typeof verifyResponse>) => problems.map((problem) => problem.code);

Deno.test("a well-formed answer passes verification untouched", () => {
  const search = digest({
    eligible: [{ name: "Go San Ramon!" }],
    verification: [{ name: "Senior Express Van (San Ramon)", missing: ["age"] }],
  });
  const response =
    "Go San Ramon! can take you — call (925) 973-2650 at least a day ahead. Senior Express Van (San Ramon) also serves this trip, but you'd need to confirm with them whether you qualify.";
  assertEquals(verifyResponse(response, state(search)), []);
});

Deno.test("two different provider totals in one message are rejected", () => {
  // The live failure: a prepended summary claiming 3 options ahead of the model's own count.
  const problems = verifyResponse(
    "I found 3 transportation provider options.\n\nUnfortunately no providers can serve this trip.",
    state(digest({ eligible: [{ name: "R-Transit (Richmond)" }] })),
  );
  assert(codes(problems).includes("contradictory_counts"), `expected contradictory counts, got ${codes(problems)}`);
});

Deno.test("qualified counts describing different buckets are not a contradiction", () => {
  const search = digest({
    eligible: [{ name: "Go San Ramon!" }, { name: "Walnut Creek Mini Bus" }],
    verification: [{ name: "Mobility Matters" }],
  });
  const response = "2 providers can take you today. 1 more provider serves the trip but needs eligibility confirmed: Mobility Matters.";
  assertEquals(codes(verifyResponse(response, state(search))), []);
});

Deno.test("claiming more providers than were found is rejected", () => {
  const problems = verifyResponse(
    "I found 5 providers for your trip.",
    state(digest({ eligible: [{ name: "Go San Ramon!" }] })),
  );
  assert(codes(problems).includes("overstated_count"));
});

Deno.test("a booking claim is rejected even with no search on record", () => {
  for (const claim of [
    "I'll book that ride for you now.",
    "Your ride is scheduled for Tuesday.",
    "I've arranged the pickup.",
    "I'll send your information to Mobility Matters.",
  ]) {
    assert(codes(verifyResponse(claim, state(null))).includes("booking_claim"), `should reject: ${claim}`);
  }
  // Describing how the rider books is not a booking claim.
  assertEquals(codes(verifyResponse("Call (925) 284-6161 to book at least 7 days ahead.", state(null))), []);
});

Deno.test("dropping providers that need eligibility verification is rejected", () => {
  const search = digest({
    eligible: [{ name: "Go San Ramon!" }],
    verification: [{ name: "Senior Express Van (San Ramon)", missing: ["age"] }],
  });
  const problems = verifyResponse("Go San Ramon! can take you. Call (925) 973-2650.", state(search));
  assert(codes(problems).includes("verification_omitted"));
  assertStringIncludes(problems[0].detail, "Senior Express Van (San Ramon)");
});

Deno.test("a ruled-out provider cannot be presented as available", () => {
  const search = digest({
    eligible: [{ name: "Go San Ramon!" }],
    excluded: [{ name: "Mobility Matters", reason: "Requires a Contra Costa resident aged 60+." }],
  });

  const problems = verifyResponse(
    "Go San Ramon! can take you. Mobility Matters offers free volunteer drivers.",
    state(search),
  );
  assert(codes(problems).includes("excluded_recommended"));

  // Explaining why it was ruled out is fine.
  assertEquals(
    codes(verifyResponse(
      "Go San Ramon! can take you. Mobility Matters is limited to riders 60 and over, so it is not an option here.",
      state(search),
    )),
    [],
  );
});

Deno.test("the correction prompt names each discrepancy and asks for a rewrite", () => {
  const prompt = buildCorrectionPrompt([
    { code: "contradictory_counts", detail: "The message states two different provider totals." },
    { code: "booking_claim", detail: "The message claims to book a ride." },
  ]);
  assertStringIncludes(prompt, "two different provider totals");
  assertStringIncludes(prompt, "claims to book a ride");
  assertStringIncludes(prompt, "Keep your own wording");
});

Deno.test("the fallback answer names the binding constraint and the alternatives", () => {
  const response = buildFallbackResponse(state(
    digest({
      binding_constraint: "geography",
      alternatives: [{
        change: "partial_coverage_origin",
        description: "covers the pickup area but not the destination",
        providers: ["Pleasant Hill Van Service"],
        count: 1,
      }],
    }),
    { origin: "Diablo Valley College, Pleasant Hill, CA", destination: "San Francisco, CA" },
  ));

  assertStringIncludes(response, "service area covers both ends");
  assertStringIncludes(response, "would not help");
  assertStringIncludes(response, "Pleasant Hill Van Service");
  assertStringIncludes(response, "Pickup: Diablo Valley College");
});

Deno.test("the fallback answer asks for what is missing when nothing has been searched", () => {
  const response = buildFallbackResponse(state(null, { origin: "Richmond City Hall, Richmond, CA" }));
  assertStringIncludes(response, "where it is going");
  assertStringIncludes(response, "the travel date");
});

Deno.test("provider counts are read from digits and words alike", () => {
  assertEquals(statedProviderCounts("I found 3 providers").map((count) => count.value), [3]);
  assertEquals(statedProviderCounts("no providers serve this trip").map((count) => count.value), [0]);
  assertEquals(statedProviderCounts("One provider can help").map((count) => count.value), [1]);
  assertEquals(statedProviderCounts("2 more providers need verification").length, 0);
});
