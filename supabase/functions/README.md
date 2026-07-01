# OPTIMAT Supabase Edge Functions

This directory contains Supabase Edge Functions for the OPTIMAT transportation platform, migrated from the OPTIMAT-FASTAPI service.

## Deployed Edge Function Endpoints (OPTIMAT)

Base URL: `https://htjohidcoyfuwfjecazu.supabase.co/functions/v1`

| Function | JWT verification | Example |
|----------|------------------|---------|
| `health` | off | `GET /health` |
| `providers` | off | `GET /providers` |
| `geocode` | off | `GET /geocode?address=...` |
| `directions` | off | `POST /directions` |
| `conversations` | off | `GET /conversations` |
| `messages` | off | `GET /messages?conversation_id=...` |
| `tool-calls` | off | `GET /tool-calls?conversation_id=...` |
| `replay` | off | `GET /replay?conversation_id=...` |
| `tri-delta-transit` | off | `GET /tri-delta-transit/trips` |
| `transcribe` | on | `POST /transcribe` |
| `chat` | on | `POST /chat` |
| `chat-examples` | on | `GET /chat-examples` |
| `trip-records` | on | `GET /trip-records/pairs` |

## Functions Overview

| Function | Description |
|----------|-------------|
| `/health` | Health check endpoint |
| `/providers` | Provider management with geographic filtering |
| `/geocode` | Address geocoding via Google Places API |
| `/directions` | Route directions via Google Directions API |
| `/trip-records` | Trip record pairs and statistics |
| `/tri-delta-transit` | Tri Delta Transit historical data |
| `/conversations` | Chat conversation management |
| `/chat` | AI chat functionality |
| `/transcribe` | Voice-to-text transcription for chatbot input |

## Detailed Function Documentation

### `/health`

Simple health probe for service monitoring.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{"status": "ok"}` |

---

### `/transcribe`

Server-side OpenAI audio transcription proxy for chatbot voice input. Requires
`OPENAI_API_KEY`; optionally set `OPENAI_TRANSCRIBE_MODEL` to override the
default `gpt-4o-mini-transcribe`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/transcribe` | Accepts multipart form data with a `file` audio part and returns `{ "text": "..." }` |

---

### `/providers`

Provider management API with geographic filtering capabilities.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/providers` | List all providers |
| POST | `/providers/filter` | Filter providers by location and criteria |
| GET | `/providers/search?q=query` | Search providers by name |
| GET | `/providers/map` | Get GeoJSON for map display |
| GET | `/providers/geocode?address=...` | Geocode an address |
| GET | `/providers/:id` | Get single provider by provider_id |
| GET | `/providers/:id/service-zone` | Get provider service zone GeoJSON |
| POST | `/providers` | Create or upsert provider |
| PUT | `/providers/:id` | Update provider |

#### Filter Payload Example

```json
{
  "source_address": "123 Main St, City, State",
  "destination_address": "456 Oak Ave, City, State",
  "provider_type": "Dial-a-Ride",
  "has_service_zone": true
}
```

---

### `/geocode`

Address geocoding using Google Places API (Text Search).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/geocode?address=...` | Geocode an address |

#### Response Example

```json
{
  "success": true,
  "formatted_address": "123 Main St, San Francisco, CA 94105",
  "lat": 37.7749,
  "lng": -122.4194,
  "place_id": "ChIJ..."
}
```

---

### `/directions`

Route directions using Google Directions API.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/directions` | Get driving or transit directions |

#### Request Body

```json
{
  "origin": "123 Main St, San Francisco, CA",
  "destination": "456 Market St, San Francisco, CA",
  "mode": "driving"
}
```

Mode options: `driving` (default), `transit`

---

### `/trip-records`

Trip record analysis for paired routes.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/trip-records/pairs` | List trip record pairs |
| GET | `/trip-records/pairs?provider_id=123` | Filter pairs by provider |
| GET | `/trip-records/pairs?mock=true` | Return pairs with mocked provider assignment |
| GET | `/trip-records/pairs-grouped` | Get grouped trip pairs (outbound/return) |
| GET | `/trip-records/stats` | Get trip record statistics |
| POST | `/trip-records/upload` | Upload trip records |
| GET | `/trip-records/manifest/pairs?service_date=YYYY-MM-DD` | List manifest trip record pairs |
| GET | `/trip-records/manifest/pair-summaries` | Get manifest daily summary statistics |

#### Upload Payload

```json
{
  "records": "raw .csv text",
  "provider_id": 123,
  "filename": "trips.csv"
}
```

---

### `/tri-delta-transit`

Tri Delta Transit historical data and route overlays.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tri-delta-transit/trips` | List historical trips |
| GET | `/tri-delta-transit/routes?mode=driving` | Get driving route overlays |
| GET | `/tri-delta-transit/routes?mode=transit` | Get transit route overlays |

---

## Shared Modules

### `_shared/cors.ts`

CORS headers utility providing:
- Standard CORS headers
- Dynamic origin handling
- Preflight request handling
- JSON response helpers (`jsonResponse`, `errorResponse`)

### `_shared/supabase.ts`

Supabase client helper providing:
- Anonymous client creation (`createAnonClient`)
- Service role client creation (`createServiceClient`)
- Request-based client for user context (`createClientFromRequest`)
- Provider data normalization (`normalizeProvider`)

## Development

### Local Development

```bash
# Start Supabase locally
supabase start

# Serve functions locally
supabase functions serve

# Or serve a specific function
supabase functions serve providers

# Serve with environment variables
supabase functions serve --env-file .env.local
```

### Deployment

```bash
# Deploy all functions
supabase functions deploy

# Deploy specific function
supabase functions deploy providers

# Deploy with secrets
supabase secrets set GOOGLE_MAPS_API_KEY=your_api_key
```

### Environment Variables

Required environment variables:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL (auto-set) |
| `SUPABASE_ANON_KEY` | Supabase anonymous key (auto-set) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (auto-set) |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key for geocoding/directions |

## Database Requirements

### Required Tables (optimat schema)

```sql
-- Providers table
CREATE TABLE optimat.providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id INTEGER UNIQUE,
  provider_name TEXT NOT NULL,
  provider_type TEXT,
  routing_type TEXT,
  schedule_type JSONB,
  planning_type TEXT,
  eligibility_reqs JSONB,
  booking JSONB,
  fare JSONB,
  service_hours JSONB,
  service_zone JSONB,  -- GeoJSON FeatureCollection
  website TEXT,
  provider_org TEXT,
  contacts JSONB,
  round_trip_booking BOOLEAN,
  investigated BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trip record pairs (uploaded trip data)
CREATE TABLE optimat.trip_record_pairs_raw (
  no_pk INTEGER,
  no_dp INTEGER,
  trip_id INTEGER,
  provider_id INTEGER,
  pick_time TIME,
  addr_pk TEXT,
  drop_time TIME,
  addr_dp TEXT,
  no_return INTEGER,
  psg_on_brd INTEGER,
  trip_id_return INTEGER,
  outgo_dura INTERVAL,
  google_maps_route TEXT,
  google_route_distance_m INTEGER,
  google_route_duration_s INTEGER,
  google_route_summary TEXT
);

-- Demand response manifest review
CREATE TABLE optimat.demand_response_manifest_review (
  row_number INTEGER,
  service_date DATE,
  trip_id TEXT,
  provider_id INTEGER,
  route TEXT,
  vehicle TEXT,
  stop_type TEXT,
  arrival_time TIME,
  departure_time TIME,
  address1 TEXT,
  city TEXT
);

-- Tri Delta Transit trips
CREATE TABLE tri_delta_transit (
  "Trip ID" INTEGER,
  "Origin Address" TEXT,
  "Origin City" TEXT,
  "Destination Address" TEXT,
  "Destination City" TEXT,
  "Duration (hours)" NUMERIC,
  "Origin Latitude" NUMERIC,
  "Origin Longitude" NUMERIC,
  "Destination Latitude" NUMERIC,
  "Destination Longitude" NUMERIC,
  "Origin Geometry" TEXT,
  "Destination Geometry" TEXT
);

-- Cached route data
CREATE TABLE transit_driving_driving (
  trip_id INTEGER,
  driving_summary TEXT,
  driving_distance_meters INTEGER,
  driving_duration_seconds INTEGER,
  driving_polyline TEXT,
  driving_warnings JSONB,
  transit_summary TEXT,
  transit_distance_meters INTEGER,
  transit_duration_seconds INTEGER,
  transit_polyline TEXT,
  transit_warnings JSONB
);
```

### Optional RPC Functions

For enhanced functionality, create these PostgreSQL functions:

- `search_providers(search_query TEXT)` - Full-text search
- `get_providers_geojson()` - Map GeoJSON data with centroids
- `filter_providers_by_location(...)` - PostGIS spatial filtering
- `geocode_address(address_text TEXT)` - Cached geocoding
- `get_trip_record_pairs(p_service_date DATE)` - Pre-computed pairs
- `get_trip_record_pair_summaries()` - Pre-computed summaries

## API Response Format

### Success Response

```json
{
  "data": [...],
  "success": true
}
```

### Error Response

```json
{
  "error": "Error message",
  "success": false,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Provider Filter Response

```json
{
  "data": [...],
  "source_address": "123 Main St",
  "destination_address": "456 Oak Ave",
  "origin": { "lat": 37.7749, "lon": -122.4194 },
  "destination": { "lat": 37.8044, "lon": -122.2712 },
  "public_transit": null
}
```

## CORS Configuration

By default, CORS is configured to allow all origins (`*`). For production, update the `ALLOWED_ORIGINS` array in `_shared/cors.ts` to restrict access to specific domains.

## Migration Notes

This Edge Functions implementation replaces the OPTIMAT-FASTAPI service. Key differences:

1. **Database Schema**: All tables are in the `optimat` schema
2. **Geocoding**: Uses Google Places API (Text Search) instead of legacy Geocoding API
3. **Authentication**: Uses Supabase service role for database operations
4. **Architecture**: Serverless functions instead of long-running FastAPI server

## Endpoint Mapping (FastAPI to Edge Functions)

| FastAPI Path | Edge Function Path |
|--------------|-------------------|
| `GET /health` | `GET /health` |
| `GET /providers` | `GET /providers` |
| `POST /providers/filter` | `POST /providers/filter` |
| `GET /providers/search` | `GET /providers/search` |
| `GET /providers/geocode` | `GET /providers/geocode` or `GET /geocode` |
| `GET /providers/{id}/service-zone` | `GET /providers/{id}/service-zone` |
| `GET /providers/map` | `GET /providers/map` |
| `PUT /providers/{id}` | `PUT /providers/{id}` |
| `POST /providers/routes/google-directions` | `POST /directions` |
| `POST /providers/routes/google-directions/transit` | `POST /directions` with `mode: "transit"` |
| `GET /tri-delta-transit/trips` | `GET /tri-delta-transit/trips` |
| `GET /tri-delta-transit/routes` | `GET /tri-delta-transit/routes` |
| `GET /trip-records/pairs` | `GET /trip-records/pairs` |
| `GET /trip-records/pair-summaries` | `GET /trip-records/manifest/pair-summaries` |
| `GET /trip-records/pairs-grouped` | `GET /trip-records/pairs-grouped` |
| `GET /trip-records/stats` | `GET /trip-records/stats` |
| `POST /trip-records/upload` | `POST /trip-records/upload` |
