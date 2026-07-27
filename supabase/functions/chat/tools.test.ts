import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeCheckTripCoverage,
  executeFindProviders,
  executeResolveTripDate,
  parseTimeToMinutes,
  type Provider,
} from "./tools.ts";

const EAST_BAY_ZONE = {
  type: "Polygon",
  coordinates: [[
    [-122.40, 37.70],
    [-121.65, 37.70],
    [-121.65, 38.20],
    [-122.40, 38.20],
    [-122.40, 37.70],
  ]],
};

function fakeDatabase(providers: Provider[]) {
  return {
    from() {
      return {
        select() {
          return Promise.resolve({ data: providers, error: null });
        },
      };
    },
  };
}

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: Number(overrides.id || 1),
    provider_name: "Test Provider",
    eligibility_reqs: "Open to the general public",
    service_zone: EAST_BAY_ZONE,
    service_hours: {
      hours: [{ day: "1111111", start: "0000", end: "2400" }],
    },
    ...overrides,
  };
}

function placesResult(query: string) {
  const normalized = query.toLowerCase();
  if (normalized.includes("dvc") || normalized.includes("diablo valley")) {
    return {
      formattedAddress: "Diablo Valley College, 321 Golf Club Rd, Pleasant Hill, CA 94523, USA",
      displayName: { text: "Diablo Valley College" },
      location: { latitude: 37.9685, longitude: -122.0711 },
    };
  }
  if (normalized.includes("san francisco")) {
    return {
      formattedAddress: "San Francisco, CA, USA",
      displayName: { text: "San Francisco" },
      location: { latitude: 37.7749, longitude: -122.4194 },
    };
  }
  if (normalized.includes("walnut creek")) {
    return {
      formattedAddress: "Walnut Creek, CA, USA",
      displayName: { text: "Walnut Creek" },
      location: { latitude: 37.9101, longitude: -122.0652 },
    };
  }
  if (normalized.includes("richmond")) {
    return {
      formattedAddress: "Richmond, CA, USA",
      displayName: { text: "Richmond" },
      location: { latitude: 37.9358, longitude: -122.3477 },
    };
  }
  if (normalized.includes("antioch")) {
    return {
      formattedAddress: "Antioch, CA, USA",
      displayName: { text: "Antioch" },
      location: { latitude: 38.0049, longitude: -121.8058 },
    };
  }
  return {
    formattedAddress: "Bay Point, CA, USA",
    displayName: { text: "Bay Point" },
    location: { latitude: 38.0291, longitude: -121.9616 },
  };
}

async function withGoogleFetch<T>(run: (directionUrls: string[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const directionUrls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("places.googleapis.com")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const biasRadius = body.locationBias?.circle?.radius;
      if (typeof biasRadius === "number" && biasRadius > 50_000) {
        return Response.json({ error: { message: "location bias radius exceeds API limit" } }, { status: 400 });
      }
      return Response.json({ places: [placesResult(body.textQuery || "")] });
    }
    if (url.includes("maps.googleapis.com/maps/api/directions")) {
      directionUrls.push(url);
      return Response.json({
        status: "OK",
        routes: [{
          summary: "Transit test route",
          overview_polyline: { points: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" },
          bounds: {
            northeast: { lat: 38.5, lng: -121.9 },
            southwest: { lat: 37.8, lng: -122.4 },
          },
          legs: [{
            distance: { text: "5 mi", value: 8047 },
            duration: { text: "30 mins", value: 1800 },
            departure_time: { text: "12:00 PM" },
            arrival_time: { text: "12:30 PM" },
            start_address: "Origin",
            end_address: "Destination",
            steps: [{
              html_instructions: "Walk to the station",
              travel_mode: "WALKING",
              polyline: { points: "_p~iF~ps|U_ulLnnqC" },
            }],
          }],
        }],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    return await run(directionUrls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("time parsing accepts common rider wording and rejects invalid values", () => {
  assertEquals(parseTimeToMinutes("noon"), 720);
  assertEquals(parseTimeToMinutes("midnight"), 0);
  assertEquals(parseTimeToMinutes("12pm"), 720);
  assertEquals(parseTimeToMinutes("9:15 AM"), 555);
  assertEquals(parseTimeToMinutes("25:00"), null);
});

Deno.test("standalone date resolution uses the California clock before search", () => {
  const clock = new Date("2026-07-13T19:00:00Z");
  const typo = executeResolveTripDate({ travel_date_raw: "July 21ar" }, clock).data as Record<string, unknown>;
  const tomorrow = executeResolveTripDate({ travel_date_raw: "tomorrow" }, clock).data as Record<string, unknown>;
  assertEquals(typo.travel_date, "2026-07-21");
  assertEquals(typo.travel_date_display, "Tuesday, July 21, 2026");
  assertEquals(tomorrow.travel_date, "2026-07-14");
});

Deno.test("named-place city contradiction stops before provider search", async () => {
  await withGoogleFetch(async () => {
    const result = await executeCheckTripCoverage(
      { source_address: "Bay Point", destination_address: "DVC in Antioch" },
      fakeDatabase([]),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    assertEquals(result.success, true);
    assertEquals(data.status, "clarification_required");
    assertEquals(data.reason_code, "location_city_mismatch");
    assertStringIncludes(String(data.message), "Pleasant Hill");
    assertStringIncludes(String(data.message), "not Antioch");
  });
});

Deno.test("coverage check reports cross-service-area failure immediately", async () => {
  await withGoogleFetch(async () => {
    const result = await executeCheckTripCoverage(
      { source_address: "Walnut Creek", destination_address: "San Francisco" },
      fakeDatabase([provider({ provider_name: "East Bay Only" })]),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    assertEquals(data.status, "not_covered");
    assertEquals(data.geography_match_count, 0);
    assertStringIncludes(String(data.message), "Changing the time will not fix");
  });
});

Deno.test("fixed-route agencies remain a public-transit fallback, not a direct ride match", async () => {
  await withGoogleFetch(async () => {
    const result = await executeCheckTripCoverage(
      { source_address: "Bay Point", destination_address: "Antioch" },
      fakeDatabase([provider({ provider_name: "Tri Delta Transit", provider_type: "Fixed Route" })]),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    assertEquals(data.status, "not_covered");
    assertEquals(data.geography_match_count, 0);
    assertEquals(data.fixed_route_fallback_count, 1);
  });
});

Deno.test("one-way search needs no return time and excludes ineligible providers", async () => {
  await withGoogleFetch(async (directionUrls) => {
    const result = await executeFindProviders(
      {
        source_address: "Bay Point",
        destination_address: "Antioch",
        departure_time: "noon",
        trip_type: "one_way",
        travel_date_raw: "July 21, 2099",
        outbound_time_intent: "arrive_by",
        rider_eligibility: {
          age: 35,
          disabled: false,
          ada_certified: false,
          veteran: false,
          residence_city: "Bay Point",
        },
      },
      fakeDatabase([
        provider({
          id: 3,
          provider_name: "Tri Delta Transit",
          provider_type: "Fixed Route",
          eligibility_reqs: "none",
        }),
        provider({
          id: 1,
          provider_name: "One Seat Ride",
          eligibility_reqs: "Contra Costa County residents who are seniors 60+ or veterans or disabled",
        }),
        provider({
          id: 2,
          provider_name: "Mobility Matters",
          eligibility_reqs: "Contra Costa County residents with a disability",
        }),
      ]),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    assertEquals(result.success, true);
    assertEquals(data.trip_type, "one_way");
    assertEquals(data.return_time, null);
    assertEquals(data.total_found, 0);
    assertEquals(data.total_options_found, 1);
    assertEquals(data.public_transit_available, true);
    assertEquals(
      (data.public_transit as Record<string, unknown>).overview_polyline,
      "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
    );
    assertEquals((data.excluded_providers as unknown[]).length, 2);
    assertEquals((data.diagnostics as Record<string, unknown>).fixed_route_fallback_count, 1);
    assertEquals(directionUrls.length, 1);
    assertStringIncludes(directionUrls[0], "arrival_time=");
  });
});

const SENIOR_VAN_REQUIREMENT = "Eligibility: Senior (55+). Proof: No proof required.";

function seniorVanSearch(riderEligibility: Record<string, unknown>) {
  return executeFindProviders(
    {
      source_address: "Bay Point",
      destination_address: "Antioch",
      departure_time: "noon",
      trip_type: "one_way",
      travel_date_raw: "July 21, 2099",
      outbound_time_intent: "depart_at",
      rider_eligibility: riderEligibility,
    } as Parameters<typeof executeFindProviders>[0],
    fakeDatabase([
      provider({ id: 1, provider_name: "Senior Express Van (San Ramon)", eligibility_reqs: SENIOR_VAN_REQUIREMENT }),
    ]),
    "test-key",
  );
}

Deno.test("an unknown age returns the provider with the age question, instead of stalling", async () => {
  await withGoogleFetch(async () => {
    // Previously this stopped the search dead and returned only a question, so a rider who
    // would not give an age got no list at all. Now the search completes and says what it needs.
    const result = await seniorVanSearch({ disabled: false, ada_certified: false, veteran: false });
    const data = result.data as Record<string, unknown>;
    assertEquals(result.success, true);
    assertEquals(data.status, "complete");

    const verification = data.verification_required as Array<Record<string, unknown>>;
    assertEquals(verification.length, 1);
    assertEquals(verification[0].provider_name, "Senior Express Van (San Ramon)");
    assertEquals(verification[0].missing_facts, ["age"]);

    const question = data.next_question as Record<string, unknown>;
    assertEquals(question.field, "age");
    assertStringIncludes(String(question.question), "exact age");
  });
});

Deno.test("an exact age recommends the senior provider instead of hiding it", async () => {
  await withGoogleFetch(async () => {
    const result = await seniorVanSearch({ age: 68, disabled: false, ada_certified: false, veteran: false });
    const data = result.data as Record<string, unknown>;
    assertEquals(data.status, "complete");
    assertEquals(data.total_found, 1);
    assertEquals((data.data as Array<Record<string, unknown>>)[0].provider_name, "Senior Express Van (San Ramon)");
    assertEquals((data.verification_required as unknown[]).length, 0);
  });
});

Deno.test("a rider who declines age still gets the provider as verification required", async () => {
  await withGoogleFetch(async () => {
    const result = await seniorVanSearch({ declined: true });
    const data = result.data as Record<string, unknown>;
    assertEquals(data.status, "complete");
    assertEquals(data.total_found, 0);
    const verification = data.verification_required as Array<Record<string, unknown>>;
    assertEquals(verification.length, 1);
    assertEquals(verification[0].provider_name, "Senior Express Van (San Ramon)");
  });
});

Deno.test("providers without an age rule do not trigger the age question", async () => {
  await withGoogleFetch(async () => {
    const result = await executeFindProviders(
      {
        source_address: "Bay Point",
        destination_address: "Antioch",
        departure_time: "noon",
        trip_type: "one_way",
        travel_date_raw: "July 21, 2099",
        outbound_time_intent: "depart_at",
        rider_eligibility: { disabled: true, ada_certified: true, veteran: false },
      },
      fakeDatabase([
        provider({ id: 1, provider_name: "One-Seat Regional Ride", eligibility_reqs: "Eligibility: Disabled (18+)." }),
      ]),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    assertEquals(data.status, "complete");
    assertEquals(data.total_found, 1);
  });
});

Deno.test("Richmond provider result stays compact and does not return service geometry", async () => {
  await withGoogleFetch(async () => {
    const providers = Array.from({ length: 6 }, (_, index) => provider({
      id: index + 1,
      provider_name: `Richmond Provider ${index + 1}`,
      description: "x".repeat(25_000),
    }));
    const result = await executeFindProviders(
      {
        source_address: "Richmond City Hall",
        destination_address: "Kaiser Richmond",
        departure_time: "12pm",
        trip_type: "one_way",
        travel_date_raw: "July 21, 2099",
        rider_eligibility: {
          age: 68,
          disabled: false,
          ada_certified: false,
          veteran: false,
          residence_city: "Richmond",
        },
      },
      fakeDatabase(providers),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    const returnedProviders = data.data as Array<Record<string, unknown>>;
    assertEquals(result.success, true);
    assertEquals(returnedProviders.length, 6);
    assert(returnedProviders.every((item) => !("service_zone" in item)));
    assert(returnedProviders.every((item) => !("description" in item)));
    assert(JSON.stringify(data).length < 25_000);
  });
});

// ─── Relaxation search ──────────────────────────────────────────────────────

const WEEKDAY_ONLY_HOURS = { hours: [{ day: "1111100", start: "0800", end: "1700" }] };
const SF_ZONE = {
  type: "Polygon",
  coordinates: [[
    [-122.52, 37.70],
    [-122.35, 37.70],
    [-122.35, 37.84],
    [-122.52, 37.84],
    [-122.52, 37.70],
  ]],
};

function relaxationSearch(providers: Provider[], overrides: Record<string, unknown> = {}) {
  return executeFindProviders(
    {
      source_address: "Bay Point",
      destination_address: "Antioch",
      departure_time: "10:00 AM",
      trip_type: "one_way",
      // 2099-07-19 is a Sunday, outside a Monday-to-Friday service pattern.
      travel_date_raw: "July 19, 2099",
      outbound_time_intent: "depart_at",
      rider_eligibility: { age: 68, disabled: false, ada_certified: false, veteran: false, residence_city: "Bay Point" },
      ...overrides,
    } as Parameters<typeof executeFindProviders>[0],
    fakeDatabase(providers),
    "test-key",
  );
}

Deno.test("a request outside service hours reports the days that would work", async () => {
  await withGoogleFetch(async () => {
    const result = await relaxationSearch([
      provider({ id: 1, provider_name: "Weekday Van", service_hours: WEEKDAY_ONLY_HOURS }),
    ]);
    const data = result.data as Record<string, unknown>;
    const alternatives = data.alternatives as Array<Record<string, unknown>>;

    assertEquals(data.total_found, 0);
    assertEquals((data.diagnostics as Record<string, number>).schedule_match_count, 0);

    const otherDay = alternatives.find((alternative) => alternative.change === "other_day");
    assert(otherDay, `expected an other_day alternative, got ${JSON.stringify(alternatives)}`);
    assertStringIncludes(String(otherDay.description), "Monday");
    assertStringIncludes(String(otherDay.description), "Friday");
    assertEquals(otherDay.providers, ["Weekday Van"]);
  });
});

Deno.test("a time outside the service window suggests a nearby time", async () => {
  await withGoogleFetch(async () => {
    const result = await relaxationSearch(
      [provider({ id: 1, provider_name: "Daytime Van", service_hours: { hours: [{ day: "1111111", start: "0800", end: "1700" }] } })],
      { departure_time: "6:00 AM" },
    );
    const alternatives = (result.data as Record<string, unknown>).alternatives as Array<Record<string, unknown>>;
    const shift = alternatives.find((alternative) => alternative.change === "shift_time");
    assert(shift, `expected a shift_time alternative, got ${JSON.stringify(alternatives)}`);
    assertStringIncludes(String(shift.description), "8:00 AM");
  });
});

Deno.test("a round trip that fails only on the return leg is reported as such", async () => {
  await withGoogleFetch(async () => {
    const result = await relaxationSearch(
      [provider({ id: 1, provider_name: "Daytime Van", service_hours: { hours: [{ day: "1111111", start: "0800", end: "1700" }] } })],
      { trip_type: "round_trip", return_time: "9:00 PM", departure_time: "10:00 AM" },
    );
    const alternatives = (result.data as Record<string, unknown>).alternatives as Array<Record<string, unknown>>;
    const oneWay = alternatives.find((alternative) => alternative.change === "one_way_instead");
    assert(oneWay, `expected a one_way_instead alternative, got ${JSON.stringify(alternatives)}`);
    assertStringIncludes(String(oneWay.description), "return time is what falls outside");
  });
});

Deno.test("no coverage reports which end of the trip each provider can reach", async () => {
  await withGoogleFetch(async () => {
    // DVC to San Francisco: the reported zero-coverage trip. One provider covers each end,
    // and neither covers both.
    const result = await executeFindProviders(
      {
        source_address: "Diablo Valley College",
        destination_address: "San Francisco",
        departure_time: "9:00 AM",
        trip_type: "one_way",
        travel_date_raw: "July 21, 2099",
        outbound_time_intent: "depart_at",
        rider_eligibility: { age: 70, disabled: false, ada_certified: false, veteran: false, residence_city: "Pleasant Hill" },
      } as Parameters<typeof executeFindProviders>[0],
      fakeDatabase([
        provider({ id: 1, provider_name: "Pleasant Hill Van Service" }),
        provider({ id: 2, provider_name: "SF Only Shuttle", service_zone: SF_ZONE }),
      ]),
      "test-key",
    );
    const data = result.data as Record<string, unknown>;
    const alternatives = data.alternatives as Array<Record<string, unknown>>;
    const diagnostics = data.diagnostics as Record<string, number>;

    assertEquals(diagnostics.geography_match_count, 0);
    assertEquals(diagnostics.geography_origin_only_count, 1);
    assertEquals(diagnostics.geography_destination_only_count, 1);

    const origin = alternatives.find((alternative) => alternative.change === "partial_coverage_origin");
    const destination = alternatives.find((alternative) => alternative.change === "partial_coverage_destination");
    assertEquals(origin?.providers, ["Pleasant Hill Van Service"]);
    assertEquals(destination?.providers, ["SF Only Shuttle"]);

    // Nothing about the date or time can fix coverage, so no schedule variants are offered.
    assert(!alternatives.some((alternative) => String(alternative.change).startsWith("shift")));
  });
});

Deno.test("an eligibility mismatch names the category that would qualify", async () => {
  await withGoogleFetch(async () => {
    const result = await relaxationSearch(
      [
        provider({ id: 1, provider_name: "Veterans Ride", eligibility_reqs: "Eligibility: Veteran." }),
        provider({ id: 2, provider_name: "ADA Paratransit Only", eligibility_reqs: "Eligibility: ADA-certified disability." }),
      ],
      { travel_date_raw: "July 21, 2099", rider_eligibility: { age: 40, disabled: false, ada_certified: false, veteran: false } },
    );
    const data = result.data as Record<string, unknown>;
    const alternatives = data.alternatives as Array<Record<string, unknown>>;

    assertEquals(data.total_found, 0);
    const veteran = alternatives.find((alternative) => String(alternative.description).includes("veteran"));
    const ada = alternatives.find((alternative) => String(alternative.description).includes("ADA-certified"));
    assertEquals(veteran?.providers, ["Veterans Ride"]);
    assertEquals(ada?.providers, ["ADA Paratransit Only"]);
    // Phrased as a property of the rule, never as a claim about this rider.
    assertStringIncludes(String(veteran?.description), "would qualify");
  });
});

Deno.test("a healthy result does not pay for relaxation variants", async () => {
  await withGoogleFetch(async () => {
    const result = await relaxationSearch([
      provider({ id: 1, provider_name: "Open Van One" }),
      provider({ id: 2, provider_name: "Open Van Two" }),
    ], { travel_date_raw: "July 21, 2099" });
    const data = result.data as Record<string, unknown>;
    assertEquals(data.total_found, 2);
    assertEquals((data.alternatives as unknown[]).length, 0);
  });
});

Deno.test("alternatives stay inside the payload budget", async () => {
  await withGoogleFetch(async () => {
    const providers = Array.from({ length: 40 }, (_, index) =>
      provider({
        id: index + 1,
        provider_name: `Weekday Van ${index + 1}`,
        service_hours: WEEKDAY_ONLY_HOURS,
      }));
    const result = await relaxationSearch(providers);
    const data = result.data as Record<string, unknown>;
    const alternatives = data.alternatives as Array<Record<string, unknown>>;

    assert(alternatives.length <= 6, `alternatives were not capped: ${alternatives.length}`);
    for (const alternative of alternatives) {
      assert((alternative.providers as string[]).length <= 5, "provider names per alternative were not capped");
    }
    assert(JSON.stringify(data).length < 100_000, "relaxation pushed the payload past the ceiling");
  });
});

Deno.test("providers with no service hours on file are reported as unverified, not available", async () => {
  await withGoogleFetch(async () => {
    // Every provider row in production currently has service_hours = null, so the schedule
    // filter passes them through unchecked. The result must say so.
    const result = await relaxationSearch([
      provider({ id: 1, provider_name: "No Hours Van", service_hours: undefined }),
    ], { departure_time: "5:00 AM" });
    const data = result.data as Record<string, unknown>;
    const diagnostics = data.diagnostics as Record<string, number>;

    assertEquals(data.total_found, 1);
    assertEquals(diagnostics.providers_without_service_hours, 1);
    const returned = (data.data as Array<Record<string, unknown>>)[0];
    assert(!("service_hours_known" in returned), "a provider with no hours must not claim known hours");
    assertStringIncludes(
      JSON.stringify(returned.match_criteria),
      "Service hours are not on file",
    );
  });
});

Deno.test("a provider dropped on the requested day is explained even when others matched", async () => {
  await withGoogleFetch(async () => {
    // The live gap this covers: a Sunday trip returned one open provider, while a weekday-only
    // service was silently dropped instead of being offered for Monday.
    const result = await relaxationSearch([
      provider({ id: 1, provider_name: "Always Open Van" }),
      provider({ id: 2, provider_name: "Weekday Van", service_hours: WEEKDAY_ONLY_HOURS }),
    ]);
    const data = result.data as Record<string, unknown>;
    const alternatives = data.alternatives as Array<Record<string, unknown>>;

    assertEquals(data.total_found, 1, "the open provider is still returned");
    const otherDay = alternatives.find((alternative) => alternative.change === "other_day");
    assert(otherDay, `expected the weekday-only provider to be explained, got ${JSON.stringify(alternatives)}`);
    assertEquals(otherDay.providers, ["Weekday Van"]);
    assert(
      !String(otherDay.description).includes("Sunday"),
      "the requested day must not be offered back as an alternative to itself",
    );
  });
});

Deno.test("a provider outside hours on both day and time is still explained by its own window", async () => {
  await withGoogleFetch(async () => {
    // The live gap: a 7am Sunday request against a Monday-Thursday 9:30am-3pm service. No
    // same-time-other-day or same-day-shifted-time variant reaches it, but its hours say it all.
    const result = await relaxationSearch(
      [provider({
        id: 1,
        provider_name: "Easy Ride Paratransit",
        service_hours: { hours: [{ day: "1111000", start: "0930", end: "1500" }] },
      })],
      { departure_time: "7:00 AM" },
    );
    const data = result.data as Record<string, unknown>;
    const alternatives = data.alternatives as Array<Record<string, unknown>>;

    assertEquals(data.total_found, 0);
    const window = alternatives.find((alternative) => alternative.change === "provider_schedule");
    assert(window, `expected the provider's own hours, got ${JSON.stringify(alternatives)}`);
    assertStringIncludes(String(window.description), "Easy Ride Paratransit");
    assertStringIncludes(String(window.description), "Monday-Thursday");
    assertStringIncludes(String(window.description), "9:30 AM");
    assertStringIncludes(String(window.description), "3 PM");
  });
});
