# Destination verification — November 3, 2026

The reproduced Kaiser case exposed two separate issues: destination queries lost the organization or borrowed the pickup city, and campus search results were treated as department addresses. A rider who did not know the building was repeatedly asked to guess between addresses.

## Behavior

- Trip address searches carry independent pickup/destination roles. Destination queries reuse the rider's named organization and specialty, and reject a structured city that was not supplied for the destination. The conversation instructions preserve medical appointment context and clarify ambiguous abbreviations rather than assuming an apartment.
- `verify_destination_address` searches official publishers using the existing Tavily key, without the general transportation-query prefix. It requires a structured destination city or facility, a matching department title where relevant, one unambiguous street address, and agreement with an Amazon Location result. Building instructions and the official source link accompany the destination card.
- The official publisher registry initially supports Kaiser Permanente (`kaiserpermanente.org`, `kp.org`) and Town of Danville (`danville.ca.gov`). This is a source-trust registry, not a destination-address database. It does not establish verified department support for every medical organization. Unsupported publishers, missing credentials, network failures, conflicting addresses, ambiguous departments, and inconsistent map locations remain unconfirmed.
- Roads, city results, and unrelated organizations are not selectable as the requested medical facility. Specific medical department searches invoke official verification instead of presenting generic campus results as verified departments.
- A pending destination prevents provider searches. A verified street address cannot be silently replaced by another building. An explicit rider-provided destination can resolve an uncertainty, but is labeled in state as user-provided rather than official verification. A clearly new trip clears the previous destination lock.
- A verified card offers the destination action, shows building information and the official link, and preserves draft text during confirmation. Independent pickup and destination attachments survive compaction, and a verified result is prioritized in the displayed choices.
- When verification fails, the chat states that the destination is unconfirmed and directs the rider to the appointment notice or facility. It does not claim either building is acceptable or that the driver will know. Raw official page content is used only for extraction, not as model instructions.

The minimal verification status is stored in the existing chat trip-state JSON. No provider-table change, new destination table, database migration, or stored official-page body is required. The address in the official source is not a guarantee of an individual patient's appointment; the rider still confirms it against appointment details.

## Validation

- Backend type check and 76 chat/location tests passed, covering query grounding, official source identity, specialty matching, conflicting buildings, wrong cities and street numbers, lookup failures, pending-state persistence, provider-search blocking, rider corrections, and independent attachments.
- Frontend type check completed with zero errors/warnings, and the static production build passed.
- `tests/chat/destination-verification.mjs` passed at 1280px and 320px, including pending state, disabled unsafe choices, official source/building display, role-specific buttons, keyboard confirmation, draft preservation, and reset.
- Existing address, age, and yes/no browser regressions passed at both widths. The regression run caught an unintended age-handler guard introduced during implementation; the guard was corrected and the original age test passed unchanged.
- External services were mocked for the new automated regressions. Fresh live Bedrock/Tavily behavior after deployment remains to be validated. These local changes have not been deployed.

## After-deployment comparison

Start a fresh chat:

> I need a ride from downtown Danville to Kaiser optometry in Shadelands, Walnut Creek. I don't know the address. Can you find it?

Then, if the department remains uncertain:

> I don't know which building. My appointment is with Kaiser Optometry at Park Shadelands. Can you verify the department's address instead of asking me to choose between these two locations?

The result should be a sourced official department address that agrees with geocoding, or a clear pending state without a forced choice. Separately test `What is the address of Kaiser in Concord?`; a road or city result must not be presented as a confirmed Kaiser facility.
