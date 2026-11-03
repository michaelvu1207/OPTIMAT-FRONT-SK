# Rider-facing provider details — November 3, 2026

The chat previously rendered `provider_info` with `JSON.stringify` inside a disclosure. This exposed internal identifiers, database timestamps, imported notes, and large GeoJSON coordinate arrays when riders opened Provider details.

The disclosure is replaced with a plain-language service detail card. It displays the provider name, routing type, telephone, website, eligibility, fare, booking instructions, service hours, service-area cities, and public contact information. The existing application/booking component continues to distinguish application processing from reservation notice. Detail cards do not assert that a rider has qualified.

The provider-detail tool and its chat attachment boundary now use an explicit field projection. Internal IDs, raw imports, administrative flags, source notes, and map geometry are excluded, including unknown fields nested inside public objects. A provider ID remains server-side for the existing audit linkage; it is not included in detail data or model context. No provider records or database schema are changed.

The frontend also handles historical raw attachments defensively: it renders selected named fields rather than iterating over unknown fields. Single providers, multiple providers, and legacy serialized objects are supported. Contact links use appropriate telephone/email/web targets. Unsupported or missing values show a readable fallback. The general web-search fallback no longer prints raw objects; readable summaries and source links remain available. Structured eligibility on recommendation cards is formatted rather than stringified.

Validation:

- 80 backend tests passed, including nested field projection, legacy structures, unknown objects, and live-handler attachment sanitization with synthetic records.
- Backend and frontend type checks passed; Svelte reported zero errors/warnings. Static production build passed.
- `tests/chat/provider-details.mjs` tests desktop and 320px phone layouts with legacy raw geometry and internal-field sentinels. Assertions cover phone/email/website links, processing time, readable operating hours, multiple providers, no metadata text, and no raw-data `pre` element.
- Existing application-timeline browser tests check that application requirements, processing times, booking notice, and fixed-route behavior remain intact.

All automated browser/API cases use mocked external services. These changes are local and have not been deployed. After deployment, start a new chat and ask:

> I've never used Mobility Matters before. If I call seven days ahead, does that mean I can definitely get a ride, or do I need to apply first?

The answer and detail card should remain readable without displaying database records. Old conversations should likewise render historical provider attachments as cards after the updated frontend loads.
