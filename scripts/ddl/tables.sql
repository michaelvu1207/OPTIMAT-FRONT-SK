-- =============================================================================
-- OPTIMAT Database DDL — Aurora PostgreSQL
-- =============================================================================
-- This script creates all tables, indexes, and constraints for the OPTIMAT
-- transportation platform. It is idempotent (safe to re-run).
--
-- Schemas:
--   optimat  — core application tables (providers, conversations, chat, trips)
--   public   — legacy/imported tables (tri_delta_transit, transit_driving_driving)
-- =============================================================================

-- Required extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Application schema
CREATE SCHEMA IF NOT EXISTS optimat;


-- =============================================================================
-- 1. providers — Transit/paratransit service providers
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.providers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id     INTEGER UNIQUE,
    provider_name   TEXT NOT NULL,
    provider_type   TEXT,
    routing_type    TEXT,
    schedule_type   JSONB,
    planning_type   TEXT,
    eligibility_reqs JSONB,
    booking         JSONB,
    fare            JSONB,
    service_hours   JSONB,
    service_zone    JSONB,          -- GeoJSON FeatureCollection
    service_area_geojson JSONB,
    service_area_cities TEXT[],
    service_area_source TEXT,
    service_area_notes TEXT,
    website         TEXT,
    provider_org    TEXT,
    provider_software TEXT,
    contacts        JSONB,
    round_trip_booking BOOLEAN,
    investigated    BOOLEAN,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE optimat.providers IS 'Transit and paratransit service providers with geographic service zones';
COMMENT ON COLUMN optimat.providers.service_zone IS 'GeoJSON FeatureCollection defining the provider service area';
COMMENT ON COLUMN optimat.providers.service_area_geojson IS 'Custom provider service-area GeoJSON imported from curated provider files or authoritative provider feeds';
COMMENT ON COLUMN optimat.providers.service_area_cities IS 'Normalized city names used to generate a provider service area when no custom GeoJSON is available';
COMMENT ON COLUMN optimat.providers.service_area_source IS 'How service_zone was derived: custom_geojson, city_list, existing_preserved, unresolved, or manual';
COMMENT ON COLUMN optimat.providers.service_area_notes IS 'Import notes for provider service-area provenance or unresolved city names';
COMMENT ON COLUMN optimat.providers.provider_software IS 'Provider scheduling/dispatch software noted in the provider validation workbook';
COMMENT ON COLUMN optimat.providers.provider_id IS 'Legacy integer identifier used by external systems';

CREATE INDEX IF NOT EXISTS idx_providers_service_area_cities
    ON optimat.providers USING GIN (service_area_cities);

CREATE INDEX IF NOT EXISTS idx_providers_provider_software
    ON optimat.providers (provider_software)
    WHERE provider_software IS NOT NULL;


-- =============================================================================
-- 2. conversations — Chat conversation sessions
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ
);

COMMENT ON TABLE optimat.conversations IS 'Chat conversation sessions between users and the AI assistant';


-- =============================================================================
-- 3. messages — Individual chat messages within conversations
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES optimat.conversations(id) ON DELETE CASCADE,
    role            TEXT,           -- user, assistant, system
    content         TEXT,
    attachments     JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
    ON optimat.messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON optimat.messages(created_at);

COMMENT ON TABLE optimat.messages IS 'Individual messages within a conversation (user, assistant, or system role)';


-- =============================================================================
-- 4. chat_examples — Curated example conversations for the demo/replay feature
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.chat_examples (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES optimat.conversations(id) ON DELETE CASCADE,
    title           TEXT,
    description     TEXT,
    tags            TEXT[],
    category        TEXT DEFAULT 'general',
    is_active       BOOLEAN,
    replay_config   JSONB,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_examples_conversation_id
    ON optimat.chat_examples(conversation_id);

CREATE INDEX IF NOT EXISTS idx_chat_examples_is_active
    ON optimat.chat_examples(is_active);

COMMENT ON TABLE optimat.chat_examples IS 'Curated example conversations used for the demo replay feature';
COMMENT ON COLUMN optimat.chat_examples.replay_config IS 'Configuration for replay playback (autoAdvance, delayMs, showTypewriter, etc.)';


-- =============================================================================
-- 5. conversation_states — Step-by-step replay states for example conversations
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.conversation_states (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES optimat.conversations(id) ON DELETE CASCADE,
    example_id      UUID REFERENCES optimat.chat_examples(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    state_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
    ui_hints        JSONB NOT NULL DEFAULT '{}'::jsonb,
    show_providers  BOOLEAN DEFAULT false,
    show_addresses  BOOLEAN DEFAULT false,
    map_action      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),

    UNIQUE (conversation_id, sequence_number),
    UNIQUE (example_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_conversation_states_conversation
    ON optimat.conversation_states(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversation_states_example
    ON optimat.conversation_states(example_id);

CREATE INDEX IF NOT EXISTS idx_conversation_states_sequence
    ON optimat.conversation_states(example_id, sequence_number);

COMMENT ON TABLE optimat.conversation_states IS 'Stores replay states for conversations to enable step-by-step playback';
COMMENT ON COLUMN optimat.conversation_states.sequence_number IS 'Order of the state in the replay sequence';
COMMENT ON COLUMN optimat.conversation_states.state_snapshot IS 'Complete state at this point including providers, addresses, etc.';
COMMENT ON COLUMN optimat.conversation_states.ui_hints IS 'UI hints for frontend display (show_providers, map_action, etc.)';


-- =============================================================================
-- 6. find_providers_calls — Recorded find_providers tool invocations
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.find_providers_calls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID REFERENCES optimat.conversations(id),
    tool_call_id        UUID,
    source_address      TEXT,
    destination_address TEXT,
    provider_data       JSONB,
    public_transit_data JSONB,
    message_timestamp   TEXT,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_find_providers_calls_conversation_id
    ON optimat.find_providers_calls(conversation_id);

COMMENT ON TABLE optimat.find_providers_calls IS 'Logged invocations of the find_providers AI tool call';


-- =============================================================================
-- 7. search_addresses_calls — Recorded search_addresses tool invocations
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.search_addresses_calls (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   UUID REFERENCES optimat.conversations(id),
    tool_call_id      UUID,
    query_text        TEXT,
    places_data       JSONB,
    message_timestamp TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_addresses_calls_conversation_id
    ON optimat.search_addresses_calls(conversation_id);

COMMENT ON TABLE optimat.search_addresses_calls IS 'Logged invocations of the search_addresses AI tool call';


-- =============================================================================
-- 8. get_provider_info_calls — Recorded get_provider_info tool invocations
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.get_provider_info_calls (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   UUID REFERENCES optimat.conversations(id),
    tool_call_id      UUID,
    provider_id       INTEGER,
    provider_info     JSONB,
    message_timestamp TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_get_provider_info_calls_conversation_id
    ON optimat.get_provider_info_calls(conversation_id);

COMMENT ON TABLE optimat.get_provider_info_calls IS 'Logged invocations of the get_provider_info AI tool call';


-- =============================================================================
-- 9. general_question_calls — Recorded general_question tool invocations
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.general_question_calls (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   UUID REFERENCES optimat.conversations(id),
    tool_call_id      UUID,
    question          TEXT,
    search_results    JSONB,
    sources           JSONB,
    message_timestamp TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_general_question_calls_conversation_id
    ON optimat.general_question_calls(conversation_id);

COMMENT ON TABLE optimat.general_question_calls IS 'Logged invocations of the general_provider_question AI tool call';


-- =============================================================================
-- 10. tool_calls — Generic tool call log (unified view)
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.tool_calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES optimat.conversations(id),
    tool_name       TEXT,
    tool_input      JSONB,
    result_data     JSONB,
    parameters      JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_conversation_id
    ON optimat.tool_calls(conversation_id);

CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name
    ON optimat.tool_calls(tool_name);

COMMENT ON TABLE optimat.tool_calls IS 'Unified log of all AI tool call invocations';


-- =============================================================================
-- 11. trip_record_pairs_raw — Uploaded trip record data for pairing analysis
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.trip_record_pairs_raw (
    no_pk                   INTEGER,
    no_dp                   INTEGER,
    trip_id                 INTEGER,
    provider_id             INTEGER,
    pick_time               TIME,
    addr_pk                 TEXT,
    drop_time               TIME,
    addr_dp                 TEXT,
    no_return               INTEGER,
    psg_on_brd              INTEGER,
    trip_id_return          INTEGER,
    outgo_dura              INTERVAL,
    google_maps_route       TEXT,
    google_route_distance_m INTEGER,
    google_route_duration_s INTEGER,
    google_route_summary    TEXT
);

COMMENT ON TABLE optimat.trip_record_pairs_raw IS 'Raw uploaded trip record pairs for outbound/return route analysis';


-- =============================================================================
-- 12. demand_response_manifest_review — Manifest stop-level trip data
-- =============================================================================
CREATE TABLE IF NOT EXISTS optimat.demand_response_manifest_review (
    row_number      INTEGER,
    service_date    DATE,
    trip_id         TEXT,
    provider_id     INTEGER,
    route           TEXT,
    vehicle         TEXT,
    stop_type       TEXT,
    arrival_time    TIME,
    departure_time  TIME,
    address1        TEXT,
    city            TEXT
);

COMMENT ON TABLE optimat.demand_response_manifest_review IS 'Demand-response manifest data with stop-level detail for review';


-- =============================================================================
-- 13. tri_delta_transit — Historical Tri Delta Transit trip records (public schema)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.tri_delta_transit (
    "Trip ID"               INTEGER,
    "Origin Address"        TEXT,
    "Origin City"           TEXT,
    "Destination Address"   TEXT,
    "Destination City"      TEXT,
    "Duration (hours)"      NUMERIC,
    "Origin Latitude"       NUMERIC,
    "Origin Longitude"      NUMERIC,
    "Destination Latitude"  NUMERIC,
    "Destination Longitude" NUMERIC,
    "Origin Geometry"       TEXT,
    "Destination Geometry"  TEXT
);

COMMENT ON TABLE public.tri_delta_transit IS 'Historical Tri Delta Transit trip data with origin/destination coordinates';


-- =============================================================================
-- 14. transit_driving_driving — Cached Google route overlays (public schema)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.transit_driving_driving (
    trip_id                     INTEGER,
    driving_summary             TEXT,
    driving_distance_meters     INTEGER,
    driving_duration_seconds    INTEGER,
    driving_polyline            TEXT,
    driving_warnings            JSONB,
    transit_summary             TEXT,
    transit_distance_meters     INTEGER,
    transit_duration_seconds    INTEGER,
    transit_polyline            TEXT,
    transit_warnings            JSONB
);

COMMENT ON TABLE public.transit_driving_driving IS 'Cached driving and transit route data from Google Directions API';
