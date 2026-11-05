# Cross-city provider explanations — November 3, 2026

The second focus-group notes describe confusion when a city-named provider appears for another city. A provider name alone does not define its coverage or residence requirements.

The search and assessment results now include a short service-area explanation only when the existing geographic match confirms both trip locations, the recorded service-area city list contains a city named in the provider name, and a different recorded city matches a trip address or the rider's stated residence. The explanation is displayed on the recommendation card and is available to the chatbot. For example: "Also serves Concord. Your pickup and destination matched its recorded service area."

This uses existing provider records and geometry checks. It adds no database field, external API call, or geocoding request. It does not infer eligibility from a service-area city, change residence requirements, approve applications, promise ride availability, or change provider filtering. Missing city lists or geography evidence produce no explanation. City names in street names are not treated as address cities. Historical results without the new explanation continue to render normally.

Validation: 95 backend tests passed, including cross-city evidence requirements, legacy serialized city lists, absent or invalid data, a misleading street name, and unchanged eligibility/residence decisions. Backend and frontend type checks passed with zero Svelte errors or warnings. The browser regression in tests/chat/cross-city-coverage.mjs passed at 1280px and 320px, including readable wrapping and retention of the Confirm eligibility state. All external browser requests were mocked. These changes are local and have not been deployed.
