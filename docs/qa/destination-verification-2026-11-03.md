# Address choices and optional official lookup — November 3, 2026

## Final behavior

Amazon Location is the primary address service. Medical department searches preserve the rider's organization, campus and destination city, then offer specific AWS map matches as candidates. Multiple candidates remain available for the rider to select; a map match is not represented as proof of the appointment's department or building. Road-only and city-only results have no selection action.

The rider can choose an address or select **None of these — enter an address**. When no candidate exists, **Enter an address** opens the same form. The form accepts a full street address and city, with a pickup/destination selector and an explicit confirmation button. Choosing an address preserves any draft in the main chat input. Candidate display and official-source results never imply rider confirmation. Destination-dependent provider searches remain blocked until explicit rider confirmation; confirmation records the selected or manually supplied address as user-provided.

Tavily is optional. A normal address question makes no third-party request, even when a key is configured. Available AWS candidates suppress external lookup even when the rider asks for official verification. Only when AWS finds no specific candidate and the latest rider message explicitly requests checking an official website, online research or department-address verification can the service make one basic Tavily request. General provider web lookup has the same explicit-request requirement; both tools share a one-request-per-turn budget. Provider database information remains the first source for provider questions. There is no extraction API, advanced search, new paid service, destination database, or database migration. Missing credentials, exhausted credits and search failures leave manual entry available.

If the optional official lookup succeeds, the department title, stated city, unambiguous street address and AWS map result must agree. The official source and building instructions accompany the candidate, and the rider must still confirm it. Unsupported official publishers fall back to AWS choices or manual entry. The existing trust registry supports Kaiser Permanente and Town of Danville. Official page bodies and API credentials are never shown in the chat.

## Validation

Backend tests cover zero external calls during normal address search, multiple AWS candidates, disabled road results, manual confirmation, official results requiring rider confirmation, the optional single basic search, query grounding, conflicting source addresses, wrong cities/buildings, and shared web-search gating. Browser regression checks desktop (1280px) and mobile (320px), including manual entry, source/building display, independent pickup/destination roles, keyboard confirmation, draft preservation and New Chat reset.

## Manual comparison

Start a new chat:

> I need a ride from downtown Danville to Kaiser optometry in Shadelands, Walnut Creek. I don't know the address. Can you find it?

Expect specific AWS address candidates when available, with destination buttons and the option to enter a different address. The assistant must not choose a building or search providers automatically. Selecting an address confirms that trip role. An official lookup, if explicitly requested when there are no AWS candidates, remains a suggestion requiring the same confirmation.
