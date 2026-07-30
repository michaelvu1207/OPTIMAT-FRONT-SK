# OPTIMAT Public API

Production base URL: `https://api.optimat.us`

The public API uses HTTPS and JSON. Public operations require no API key. Browser access is enabled with `Access-Control-Allow-Origin: *`. API Gateway applies a sustained limit of 25 requests per second and a burst limit of 50.

Machine-readable OpenAPI 3.1 documentation: `https://api.optimat.us/openapi.json`

## Quick start

```bash
curl https://api.optimat.us/health
curl 'https://api.optimat.us/providers/search?q=transit'
```

Find providers for a trip:

```bash
curl -X POST https://api.optimat.us/providers/filter \
  -H 'Content-Type: application/json' \
  -d '{
    "source_address": "Walnut Creek BART, Walnut Creek, CA",
    "destination_address": "Broadway Plaza, Walnut Creek, CA"
  }'
```

## Public route groups

- System: `/`, `/health`, `/openapi.json`
- Providers: `/providers`, `/providers/search`, `/providers/map`, `/providers/filter`, `/providers/{id}`, `/providers/{id}/service-zone`
- Location: `/geocode`, `/directions`
- Rider assistant: `/conversations`, `/messages`, `/chat`, `/tool-calls`
- Examples: `/chat-examples`, `/replay`
- Trip data: `/trip-records/*`, `/tri-delta-transit/*`
- Feedback: `/feedback`

The OpenAPI document defines methods, parameters, and request bodies for each supported public operation.

## Conversation privacy

Conversation UUIDs are bearer-like identifiers. Anyone with the UUID can retrieve the corresponding conversation, messages, and tool results. Do not publish these identifiers or submit secrets, payment data, or protected health information.

## Administrative operations

Provider updates, conversation listing/deletion, chat-example mutation, replay publication, and trip-data uploads are not public API operations. They require a server-held administrative credential and are intentionally omitted from the public OpenAPI document. Never embed the administrative credential in browser or client code.

## Errors

Errors use an appropriate HTTP status and a JSON payload similar to:

```json
{
  "error": "message",
  "success": false,
  "timestamp": "2026-07-30T00:00:00.000Z"
}
```
