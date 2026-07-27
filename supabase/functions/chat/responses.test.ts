import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCoverageResponse,
  buildDateResolutionResponse,
  buildNoProviderResponse,
  ensurePublicTransitProviderSummary,
  ensureVerificationSummary,
} from "./responses.ts";

Deno.test("providers needing verification are stated even when the model omits them", () => {
  const providerSearch = {
    status: "complete",
    data: [{ provider_name: "Go San Ramon!" }],
    verification_required: [{ provider_name: "Senior Express Van (San Ramon)" }],
  };

  const response = ensureVerificationSummary("I found 1 provider: Go San Ramon!.", providerSearch);
  assertStringIncludes(response, "Senior Express Van (San Ramon)");
  assertStringIncludes(response, "eligibility verification");

  // Nothing is appended when the model already named them, or when there are none.
  const mentioned = "Senior Express Van (San Ramon) needs eligibility verification.";
  assertEquals(ensureVerificationSummary(mentioned, providerSearch), mentioned);
  assertEquals(
    ensureVerificationSummary("No verification needed.", { status: "complete", verification_required: [] }),
    "No verification needed.",
  );
});

Deno.test("coverage failure names the binding constraint before asking for times", () => {
  const response = buildCoverageResponse({
    status: "not_covered",
    source_address: "Walnut Creek, CA, USA",
    destination_address: "San Francisco, CA, USA",
  });

  assertStringIncludes(response || "", "service area covers both locations");
  assertStringIncludes(response || "", "Changing the date or time will not fix this coverage constraint");
  assertStringIncludes(response || "", "won't ask you for unnecessary return-trip details");
});

Deno.test("location contradiction is returned as a clarification", () => {
  assertEquals(
    buildCoverageResponse({
      status: "clarification_required",
      message: "DVC's main campus is in Pleasant Hill, not Antioch. Which destination did you mean?",
    }),
    "DVC's main campus is in Pleasant Hill, not Antioch. Which destination did you mean?",
  );
});

Deno.test("eligibility exclusions explain why restricted providers were withheld", () => {
  const response = buildNoProviderResponse({
    status: "ok",
    total_found: 0,
    source_address: "Bay Point, CA, USA",
    destination_address: "Antioch, CA, USA",
    diagnostics: {
      geography_match_count: 2,
      schedule_match_count: 2,
      verification_required_count: 0,
    },
    excluded_providers: [
      {
        provider_name: "One Seat Ride",
        reason: "This program is limited to seniors, veterans, and disabled riders.",
      },
      {
        provider_name: "Mobility Matters",
        reason: "This program requires a qualifying mobility limitation.",
      },
    ],
  });

  assertStringIncludes(response || "", "none match the eligibility information provided");
  assertStringIncludes(response || "", "One Seat Ride: This program is limited");
  assertStringIncludes(response || "", "Mobility Matters: This program requires");
});

Deno.test("missing required trip detail returns the deterministic tool clarification", () => {
  assertEquals(
    buildNoProviderResponse({
      status: "clarification_required",
      message: "What date would you like to travel?",
    }),
    "What date would you like to travel?",
  );
});

Deno.test("public transit is presented as a found provider option", () => {
  const response = buildNoProviderResponse({
    status: "complete",
    total_found: 0,
    source_address: "Bay Point, CA, USA",
    destination_address: "Antioch, CA, USA",
    diagnostics: {
      geography_match_count: 0,
      schedule_match_count: 0,
    },
    public_transit: {
      duration_text: "42 mins",
      overview_polyline: "encoded-route",
    },
  });

  assertStringIncludes(response || "", "found 1 transportation provider option: Public Transit");
  assertStringIncludes(response || "", "display the transit route on the map");
});

Deno.test("public transit is counted with direct providers in assistant summaries", () => {
  const response = ensurePublicTransitProviderSummary("Direct provider details.", {
    status: "complete",
    data: [{ provider_name: "R-Transit" }, { provider_name: "Mobility Matters" }],
    public_transit: { duration_text: "15 mins" },
  });

  assertStringIncludes(response, "found 3 transportation provider options, including Public Transit");
  assertStringIncludes(response, "Direct provider details.");
});

Deno.test("standalone date acknowledgment cannot substitute the wrong weekday or year", () => {
  assertEquals(
    buildDateResolutionResponse({
      status: "resolved",
      travel_date_raw: "July 21ar",
      travel_date: "2026-07-21",
      travel_date_display: "Tuesday, July 21, 2026",
    }),
    "I resolved “July 21ar” as Tuesday, July 21, 2026 using the California service clock, and I'll use that date.\n" +
      "Please provide any remaining trip details I asked for, such as one-way or round trip, the outbound time and whether it means depart at or arrive by, and rider eligibility.",
  );
});
