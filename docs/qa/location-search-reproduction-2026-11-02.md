# Location search reproduction — November 2, 2026

## Scope

Eight live, read-only GET requests were sent to `https://api.optimat.us/geocode?address=...`. This endpoint calls the same `searchPlaces` helper used by chat address search, but requests only the first result. Chat searches request up to five results. These checks establish current first-result behavior, not what a fresh model conversation would recommend or render. No application code, provider data, or destination directory was changed.

Automatic approval initially rejected a production conversation replay because it would persist age and location details. After the read-only checks, the user explicitly authorized replaying the original case. One labeled production QA conversation was created and the first 11 original user messages were replayed, through the final Kaiser-facility clarification and address confirmation request. The last original reply ("The top one") and subsequent provider recommendations were not replayed; they are beyond this address-search check. No rider booking or provider-data mutation occurred.

## Observed results

| Query | First result | Finding |
|---|---|---|
| Kaiser Concord | Kaiser Quarry Rd, Concord, CA 94521 | Road returned for a facility-style query. |
| Kaiser in Concord | Concord, CA | City returned instead of a facility. |
| Kaiser Optometrists Danville California | Danville Optometric Group, 3464 Camino Tassajara | A different organization; not a verified Kaiser match. |
| Kaiser optometry Shadelands Walnut Creek | Kaiser Park Shadelands, 370 Lennon Ln | Relevant campus label; department address still requires verification. |
| Kaiser Shadelands Walnut Creek | Kaiser Park Shadelands, 370 Lennon Ln | Same campus result. |
| Danville Senior Center address | Danville Brewing, 115 E Prospect Ave | Incorrect venue label, although the street address agrees with the town's Senior Center page. |
| Shadelands Medical Center Danville California | Shadelands Surgery Center, 100 N Wiget Ln, Walnut Creek | Does not establish the intended Kaiser facility. |
| Shadelands Medical Center Walnut Creek California | Shadelands Surgery Center, 100 N Wiget Ln, Walnut Creek | Adding the correct city alone does not resolve an ambiguous campus name. |

## Official checks

- [Town of Danville Senior Center](https://danville.ca.gov/Facilities/Facility/Details/-37) lists 115 East Prospect Avenue. The search's venue identity is wrong; the test does not demonstrate a different street address.
- [Kaiser Vision Essentials — Optometry at Park Shadelands](https://healthy.kaiserpermanente.org/northern-california/facilities/Park-Shadelands-Medical-Offices-100343/departments/vision-care-dlp-102926) lists Building 4 — Shasta, 320 Lennon Ln, left side of building, Walnut Creek. The 370 Lennon Ln search result must not automatically be treated as the confirmed optometry entrance.

## Interpretation

The supplied historical conversation shows the model adding the pickup city Danville to the destination search before the rider specified Walnut Creek. This is a query-context issue distinct from the place service returning a road or a misleading venue name. Matching a campus name also does not establish a department's exact address.

First investigate query construction and facility/result validation. A small verified destination directory could supplement those fixes, but these tests do not establish that a new directory or database table is the only solution. Preserve uncertain results as unconfirmed and never replace a specific named organization with an unrelated result without clarification.

Raw first-result observations are in `location-search-readonly-2026-11-02.json`; transient place identifiers are omitted.

## Authorized live conversational replay

The production chat was tested, not a mocked local response. It does not include the pending local question-cleanup changes, which have not been deployed.

Observed behavior:

1. The Senior Center answer initially supplied 115 E Prospect Ave, a street address that agrees with the town's official page. Its attachment retained the misleading Danville Brewing venue label. When asked "is that correct", the assistant withdrew confidence without performing a new lookup and asked the rider to find the address elsewhere.
2. The destination query was `Shadelands Medical Center Danville California`, demonstrating that the pickup city was added to the destination query.
3. The reply to `I am near the community center and want to go next week to an apt` treated `apt` as apartment. The conversation had previously established a medical destination, so this assumption disrupted context. A clarification is appropriate when the abbreviation remains uncertain.
4. After the user said `Kaiser optometrists`, the assistant asked about an apartment versus Kaiser rather than searching. Later eye-doctor queries used `eye doctor optometrist Shadelands Walnut Creek`, omitting the explicitly supplied Kaiser name, and returned the surgery/endoscopy facilities instead.
5. At the final Kaiser clarification, the response presented Danville Community Center, 420 Front St, and Kaiser Park Shadelands, 370 Lennon Ln, for confirmation. The specific optometry address remains unverified by this campus result; the official department page lists 320 Lennon Ln.
6. The assistant asked six intake questions in some turns and asked again about a one-way versus round trip after an explicit one-way answer. These are consistent with the previously identified question-cleanup work, but this run does not validate the undeployed changes.
7. The final reply labeled November 5, 2026 as Wednesday. That date is Thursday. This is a separate observed date-consistency issue, not an address-directory defect.

The full transient API replay is saved locally in `/tmp/optimat-location-chat-replay-2026-11-02.json`. Conversation IDs are not published in this report.

Prioritize preserving named organizations and trip roles in search queries, clarifying ambiguous abbreviations, rejecting roads/cities as facility matches, and verifying specific department destinations. A curated directory remains an optional supplement rather than a proven prerequisite.
