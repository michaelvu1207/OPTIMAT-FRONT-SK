# One Seat recommendation policy — November 16, 2026

The current user request restores One-Seat Regional Ride as a recommendation with booking details like LINK. This supersedes the August retirement behavior. The attached November 9 transcript is supporting context, not an instruction to perform its unrelated meeting action items.

One Seat is the cross-agency product in OPTIMAT. LINK remains a single-agency option. Trips between cities within one jurisdiction do not qualify. Mobility Matters covering both endpoints does not suppress a regional One Seat option.

The matching policy uses stored service polygons to identify west, central, east, and Tri-Valley jurisdictions. West includes the Richmond and San Pablo municipal coverage polygons per the requested west-to-central scenario. These polygons establish a regional recommendation, not a guarantee that the One Seat operator serves every pickup. The card explicitly calls for confirmation of exact pickup coverage and both trip legs. Inactive or absent One Seat records are not synthesized or reactivated.

The program retains ADA eligibility assessment and ordinary schedule filtering. Age 65+ and San Pablo residence alone do not establish ADA eligibility. Unknown hours remain subject to verification. Booking is (925) 680-2134; the old imported flat $3 fare is replaced with origin-dependent fare guidance. Sources checked November 16: https://oneseatride.org/how-to-ride/ and https://oneseatride.org/faq/ . The public site lists County Connection, Tri Delta, WestCAT, and LAVTA; expanded Richmond pickup coverage must be confirmed with the operator.

Both Lambda and Supabase search paths, provider lookup/roster, and import filtering implement restoration. Policy modules are mirrored with a parity regression check. Existing historical QA reports remain historical.

Regression coverage includes the Richmond-to-Walnut Creek scenario and reverse direction using synthetic polygons, a cross-city LINK trip, overlapping jurisdictions, unknown endpoint coverage, inactive/missing records, all four regions, volunteer-provider coexistence, and conditional ADA eligibility. The subsequent user-authorized production deployment and live API tests are recorded in [release verification](qa/one-seat-release-2026-11-16.md). No provider database mutation was performed.
