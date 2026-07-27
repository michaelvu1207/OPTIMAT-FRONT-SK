import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateEligibility,
  getLocationMismatch,
  getServiceClockContext,
  nextQuestion,
  resolveTravelDate,
} from "./trip.ts";

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

Deno.test("general resident is ineligible for restricted Bay Point providers", () => {
  const rider = {
    age: 35,
    disabled: false,
    ada_certified: false,
    veteran: false,
    residence_city: "Bay Point",
  };
  const oneSeat = evaluateEligibility("Eligibility: Disabled (18+). Proof: No proof mentioned on website.", rider);
  const mobility = evaluateEligibility(
    "Eligibility: Senior (60+) or veteran. And must be a Contra Costa County resident.",
    rider,
  );
  assert(oneSeat.status === "ineligible", "One-Seat should be excluded");
  assert(mobility.status === "ineligible", "Mobility Matters should be excluded");
});

Deno.test("eligible and declined riders receive distinct statuses", () => {
  const richmondSenior = evaluateEligibility(
    "Eligibility: Senior (55+) or disabled (18+). And must be a resident of Richmond, North Richmond, El Sobrante or Kensington.",
    { age: 65, disabled: false, veteran: false, residence_city: "Richmond" },
  );
  assert(richmondSenior.status === "eligible", "Richmond senior should match R-Transit");

  const declined = evaluateEligibility("Eligibility: Disabled (18+).", { declined: true });
  assert(declined.status === "verification_required", "declined eligibility should not be labeled eligible");
});

Deno.test("community-specific residency does not treat the containing city as membership", () => {
  const requirement = "Eligibility: Rossmoor community Resident (Rossmoor ID).";
  const walnutCreekResident = evaluateEligibility(requirement, {
    age: 42,
    disabled: true,
    ada_certified: true,
    veteran: false,
    residence_city: "Walnut Creek",
  });
  const rossmoorResident = evaluateEligibility(requirement, {
    age: 68,
    disabled: false,
    ada_certified: false,
    veteran: false,
    residence_city: "Rossmoor",
  });
  assert(walnutCreekResident.status === "ineligible", "Walnut Creek alone should not satisfy Rossmoor membership");
  assert(rossmoorResident.status === "eligible", "Rossmoor residency should satisfy the community requirement");
});

// Production requirement text, copied from the live providers table.
const SAN_RAMON_SENIOR_VAN = "Eligibility: Senior (55+). Proof: No proof required.";
const ORINDA_SENIOR = "Eligibility: Senior. Proof: No proof required.";

Deno.test("provider minimum ages need an exact rider age, not senior status", () => {
  const senior = { age: 68, disabled: false, ada_certified: false, veteran: false, residence_city: "San Ramon" };
  assert(
    evaluateEligibility(SAN_RAMON_SENIOR_VAN, senior).status === "eligible",
    "a 68-year-old meets the San Ramon 55+ rule",
  );

  // The reported bug: "I'm a senior" with no age hid this provider from the results entirely.
  const ageUnknown = { disabled: false, ada_certified: false, veteran: false, residence_city: "San Ramon" };
  const undecided = evaluateEligibility(SAN_RAMON_SENIOR_VAN, ageUnknown);
  assert(undecided.status === "verification_required", "an unknown age cannot decide an age rule");
  assertEquals(undecided.missing_facts, ["age"], "the search must know it is the age that is missing");

  // A disability floor is decided by disability status, so no age question is worth asking.
  assertEquals(evaluateEligibility("Eligibility: Disabled (18+).", ageUnknown).missing_facts, []);
  assertEquals(evaluateEligibility("none", ageUnknown).missing_facts, []);
});

Deno.test("the next question is the one that decides the most providers", () => {
  const rider = { disabled: false, ada_certified: false, veteran: false };
  const question = nextQuestion([
    { provider_name: "Senior Express Van (San Ramon)", missing_facts: ["age"] },
    { provider_name: "Seniors Around Town (Orinda)", missing_facts: ["age"] },
    { provider_name: "Mobility Matters", missing_facts: ["residence_city"] },
  ], rider);

  assertEquals(question?.field, "age", "two providers hinge on age against one on residency");
  assertEquals(question?.candidates_if_known, 2);
  assertStringIncludes(question?.why || "", "Senior Express Van (San Ramon)");
});

Deno.test("a fact the rider already gave is never asked for again", () => {
  const question = nextQuestion(
    [{ provider_name: "Senior Express Van (San Ramon)", missing_facts: ["age"] }],
    { age: 68 },
  );
  assertEquals(question, null, "age is known, so there is nothing worth asking");
});

Deno.test("an ADA-only candidate set is never asked about senior status", () => {
  const question = nextQuestion(
    [
      { provider_name: "East Bay Paratransit", missing_facts: ["ada_certified"] },
      { provider_name: "LINK Paratransit", missing_facts: ["ada_certified"] },
    ],
    {},
  );
  assertEquals(question?.field, "ada_certified");
});

Deno.test("a rider who declined is not asked anything further", () => {
  assertEquals(
    nextQuestion([{ provider_name: "Senior Express Van (San Ramon)", missing_facts: ["age"] }], { declined: true }),
    null,
  );
  // Their eligibility still cannot be asserted — it goes to the provider to confirm.
  const declined = evaluateEligibility(SAN_RAMON_SENIOR_VAN, { declined: true });
  assertEquals(declined.status, "verification_required");
  assertEquals(declined.missing_facts, [], "no rider answer is coming, so nothing is pending");
});

Deno.test("a bare senior rule uses the 60+ default", () => {
  const base = { disabled: false, ada_certified: false, veteran: false, residence_city: "Orinda" };
  assertEquals(evaluateEligibility(ORINDA_SENIOR, { ...base, age: 62 }).status, "eligible");
  assertEquals(evaluateEligibility(ORINDA_SENIOR, { ...base, age: 58 }).status, "ineligible");
});

Deno.test("structured eligibility rules are alternatives, not combined requirements", () => {
  // Historical rows store rule objects instead of prose; each entry is its own qualifying category.
  const requirement = [
    { type: "Disabled", proof: "id-certified" },
    { type: "Senior", proof: "id-certified" },
  ];
  const senior = { age: 68, disabled: false, ada_certified: false, veteran: false, residence_city: "San Pablo" };
  assertEquals(
    evaluateEligibility(requirement, senior).status,
    "eligible",
    "a senior qualifies for a senior-or-disabled provider without being disabled",
  );
  assertEquals(
    evaluateEligibility(JSON.stringify(requirement), senior).status,
    "eligible",
    "the same rules encoded as a JSON string behave identically",
  );
  assertEquals(
    evaluateEligibility(requirement, { age: 40, disabled: true, ada_certified: false, veteran: false }).status,
    "eligible",
    "a disabled rider also qualifies",
  );
  assertEquals(
    evaluateEligibility(requirement, { age: 40, disabled: false, ada_certified: false, veteran: false }).status,
    "ineligible",
    "a rider matching neither category is excluded",
  );
});

Deno.test("uninterpretable requirement text is never treated as eligible", () => {
  const rider = { age: 68, disabled: false, ada_certified: false, veteran: false, residence_city: "Richmond" };
  // Live data carries junk in this column for at least one provider ("regular on-demand").
  assertEquals(evaluateEligibility("regular on-demand", rider).status, "verification_required");
  assertEquals(evaluateEligibility("none", rider).status, "eligible");
  assertEquals(evaluateEligibility("Open to the general public", rider).status, "eligible");
});

Deno.test("DVC city conflict is detected before provider search", () => {
  const mismatch = getLocationMismatch(
    "DVC in Antioch, California",
    "Diablo Valley College, 321 Golf Club Rd, Pleasant Hill, CA 94523, USA",
  );
  assert(mismatch?.requestedCity === "Antioch", "requested city should be Antioch");
  assert(mismatch?.resolvedCity === "Pleasant Hill", "resolved city should be Pleasant Hill");
});

Deno.test("Richmond defaults do not create a false city mismatch", () => {
  const mismatch = getLocationMismatch("Richmond City Hall", "450 Civic Center Plaza, Richmond, CA 94804, USA");
  assert(mismatch === null, "Richmond, California should remain in service context");
});
