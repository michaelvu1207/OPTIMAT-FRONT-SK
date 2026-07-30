--
-- PostgreSQL database dump
--

\restrict 3CWSifjCxCsX8KC26OYdlI0JwJ6dwHubVCS5sbnc4oMQCXtzm7IaOWgB7aaV3ja

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: optimat; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA "optimat";


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: providers; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" integer,
    "provider_name" "text" NOT NULL,
    "provider_type" "text",
    "routing_type" "text",
    "schedule_type" "jsonb",
    "planning_type" "text",
    "eligibility_reqs" "jsonb" DEFAULT '[]'::"jsonb",
    "provider_org" "text",
    "contacts" "jsonb",
    "booking" "jsonb",
    "fare" "jsonb",
    "service_hours" "text",
    "service_zone" "jsonb",
    "website" "text",
    "round_trip_booking" boolean DEFAULT false,
    "investigated" boolean DEFAULT false,
    "is_operating" boolean,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "service_area_geojson" "jsonb",
    "service_area_cities" "text"[],
    "service_area_source" "text",
    "service_area_notes" "text",
    "provider_software" "text",
    "service_hours_source" "text",
    "service_hours_quote" "text",
    "service_hours_confidence" "text",
    "service_hours_verified_at" timestamp with time zone,
    "service_hours_notes" "text"
);


--
-- Name: COLUMN "providers"."service_area_geojson"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_area_geojson" IS 'Custom provider service-area GeoJSON imported from curated provider files or authoritative provider feeds.';


--
-- Name: COLUMN "providers"."service_area_cities"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_area_cities" IS 'Normalized city names used to generate a provider service area when no custom GeoJSON is available.';


--
-- Name: COLUMN "providers"."service_area_source"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_area_source" IS 'How service_zone was derived: custom_geojson, city_list, existing_preserved, unresolved, or manual.';


--
-- Name: COLUMN "providers"."service_area_notes"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_area_notes" IS 'Import notes for provider service-area provenance or unresolved city names.';


--
-- Name: COLUMN "providers"."provider_software"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."provider_software" IS 'Provider scheduling/dispatch software noted in the provider validation workbook.';


--
-- Name: COLUMN "providers"."service_hours_source"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_hours_source" IS 'URL of the page the service hours were read from. A row with service_hours set and no source should be treated as unverified.';


--
-- Name: COLUMN "providers"."service_hours_quote"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_hours_quote" IS 'Verbatim text from service_hours_source stating the hours, kept so a human can spot-check without re-researching.';


--
-- Name: COLUMN "providers"."service_hours_confidence"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_hours_confidence" IS 'high = clearly stated on an official page, medium = inferred from a schedule table or PDF.';


--
-- Name: COLUMN "providers"."service_hours_verified_at"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_hours_verified_at" IS 'When the hours were last confirmed against the source. Published hours drift; re-verify periodically.';


--
-- Name: COLUMN "providers"."service_hours_notes"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."providers"."service_hours_notes" IS 'Holidays, advance-notice requirements, appointment-only caveats, and other dispatcher-relevant exceptions.';


--
-- Name: filter_providers_by_location(double precision, double precision, double precision, double precision); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."filter_providers_by_location"("source_lat" double precision, "source_lng" double precision, "dest_lat" double precision DEFAULT NULL::double precision, "dest_lng" double precision DEFAULT NULL::double precision) RETURNS SETOF "optimat"."providers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'optimat', 'extensions', 'public'
    AS $$
BEGIN
    RETURN QUERY
    SELECT p.*
    FROM optimat.providers p
    WHERE
        -- Check if source point is within any service zone feature
        EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p.service_zone->'features') AS feature
            WHERE extensions.ST_Contains(
                extensions.ST_GeomFromGeoJSON(feature->'geometry'),
                extensions.ST_SetSRID(extensions.ST_MakePoint(source_lng, source_lat), 4326)
            )
        )
        AND (
            dest_lat IS NULL
            OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(p.service_zone->'features') AS feature
                WHERE extensions.ST_Contains(
                    extensions.ST_GeomFromGeoJSON(feature->'geometry'),
                    extensions.ST_SetSRID(extensions.ST_MakePoint(dest_lng, dest_lat), 4326)
                )
            )
        );
END;
$$;


--
-- Name: filter_providers_by_location("text", "text", "text", "text", "text", "text", "text", "text", "text", "text", boolean, "text", "text"); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."filter_providers_by_location"("p_source_address" "text", "p_destination_address" "text", "p_provider_type" "text" DEFAULT NULL::"text", "p_routing_type" "text" DEFAULT NULL::"text", "p_schedule_type" "text" DEFAULT NULL::"text", "p_planning_type" "text" DEFAULT NULL::"text", "p_eligibility_req_contains" "text" DEFAULT NULL::"text", "p_eligibility_type" "text" DEFAULT NULL::"text", "p_provider_org" "text" DEFAULT NULL::"text", "p_provider_name_contains" "text" DEFAULT NULL::"text", "p_has_service_zone" boolean DEFAULT NULL::boolean, "p_booking_method" "text" DEFAULT NULL::"text", "p_fare_type" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Return error indicating the Edge Function needs to handle geocoding
  -- The Edge Function should be modified to:
  -- 1. Geocode using Google Places API
  -- 2. Query providers directly OR call filter_providers_with_coords

  RETURN jsonb_build_object(
    'providers', '[]'::jsonb,
    'origin', NULL,
    'destination', NULL,
    'public_transit', NULL,
    'error', true,
    'message', 'This RPC function requires the Edge Function to be updated. The Edge Function should geocode addresses and query providers directly using PostGIS spatial filters.'
  );
END;
$$;


--
-- Name: filter_providers_with_coords(numeric, numeric, numeric, numeric, "text", "text", "text", "text", "text", "text", "text", "text", boolean, "text", "text"); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."filter_providers_with_coords"("p_origin_lat" numeric, "p_origin_lon" numeric, "p_dest_lat" numeric, "p_dest_lon" numeric, "p_provider_type" "text" DEFAULT NULL::"text", "p_routing_type" "text" DEFAULT NULL::"text", "p_schedule_type" "text" DEFAULT NULL::"text", "p_planning_type" "text" DEFAULT NULL::"text", "p_eligibility_req_contains" "text" DEFAULT NULL::"text", "p_eligibility_type" "text" DEFAULT NULL::"text", "p_provider_org" "text" DEFAULT NULL::"text", "p_provider_name_contains" "text" DEFAULT NULL::"text", "p_has_service_zone" boolean DEFAULT NULL::boolean, "p_booking_method" "text" DEFAULT NULL::"text", "p_fare_type" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_origin_point geometry;
  v_dest_point geometry;
  v_providers jsonb;
BEGIN
  -- Validate coordinates
  IF p_origin_lat IS NULL OR p_origin_lon IS NULL OR p_dest_lat IS NULL OR p_dest_lon IS NULL THEN
    RETURN jsonb_build_object(
      'providers', '[]'::jsonb,
      'error', true,
      'message', 'Invalid coordinates'
    );
  END IF;

  -- Create PostGIS points
  v_origin_point := ST_SetSRID(ST_MakePoint(p_origin_lon, p_origin_lat), 4326);
  v_dest_point := ST_SetSRID(ST_MakePoint(p_dest_lon, p_dest_lat), 4326);

  -- Query providers and build JSON array
  -- Use a subquery with ORDER BY, then aggregate
  SELECT jsonb_agg(provider_data)
  INTO v_providers
  FROM (
    SELECT jsonb_build_object(
      'provider_uuid', p.id::text,
      'provider_id', p.provider_id::text,
      'provider_name', p.provider_name,
      'provider_type', p.provider_type,
      'routing_type', p.routing_type,
      'schedule_type', p.schedule_type,
      'planning_type', p.planning_type,
      'eligibility_reqs', p.eligibility_reqs,
      'booking', p.booking,
      'fare', p.fare,
      'service_hours', p.service_hours,
      'service_zone', p.service_zone,
      'website', p.website,
      'provider_org', p.provider_org,
      'contacts', p.contacts,
      'phone', p.contacts->>'phone',
      'email', p.contacts->>'email',
      'latitude', NULL,
      'longitude', NULL,
      'is_operating', NULL,
      'has_service_zone', (p.service_zone IS NOT NULL),
      'round_trip_booking', p.round_trip_booking,
      'investigated', p.investigated,
      'created_at', p.created_at
    ) AS provider_data
    FROM optimat.providers p
    WHERE
      p.service_zone IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p.service_zone->'features') f
        WHERE ST_Contains(
          ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326),
          v_origin_point
        )
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p.service_zone->'features') f
        WHERE ST_Contains(
          ST_SetSRID(ST_GeomFromGeoJSON((f->'geometry')::text), 4326),
          v_dest_point
        )
      )
      AND (p_provider_type IS NULL OR p.provider_type = p_provider_type)
      AND (p_routing_type IS NULL OR p.routing_type = p_routing_type)
      AND (p_schedule_type IS NULL OR p.schedule_type->>'schedule_type' = p_schedule_type)
      AND (p_planning_type IS NULL OR p.planning_type = p_planning_type)
      AND (p_provider_org IS NULL OR p.provider_org = p_provider_org)
      AND (p_provider_name_contains IS NULL OR p.provider_name ILIKE '%' || p_provider_name_contains || '%')
      AND (p_booking_method IS NULL OR p.booking->>'method' = p_booking_method)
      AND (p_fare_type IS NULL OR p.fare->>'type' = p_fare_type)
      AND (p_has_service_zone IS NULL OR
           (p_has_service_zone = true AND p.service_zone IS NOT NULL) OR
           (p_has_service_zone = false AND p.service_zone IS NULL))
      AND (
        p_eligibility_req_contains IS NULL
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(
              CASE jsonb_typeof(p.eligibility_reqs)
                WHEN 'array' THEN p.eligibility_reqs
                ELSE p.eligibility_reqs->'eligibility_reqs'
              END,
              '[]'::jsonb
            )
          ) AS req(elem)
          WHERE req.elem ILIKE '%' || p_eligibility_req_contains || '%'
        )
      )
      AND (
        p_eligibility_type IS NULL
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            COALESCE(
              CASE jsonb_typeof(p.eligibility_reqs)
                WHEN 'array' THEN p.eligibility_reqs
                ELSE p.eligibility_reqs->'eligibility_reqs'
              END,
              '[]'::jsonb
            )
          ) AS req(elem)
          WHERE req.elem->>'eligibility_type' ILIKE '%' || p_eligibility_type || '%'
        )
      )
    ORDER BY p.provider_name
    LIMIT 200
  ) AS ordered_providers;

  RETURN jsonb_build_object(
    'providers', COALESCE(v_providers, '[]'::jsonb)
  );
END;
$$;


--
-- Name: FUNCTION "filter_providers_with_coords"("p_origin_lat" numeric, "p_origin_lon" numeric, "p_dest_lat" numeric, "p_dest_lon" numeric, "p_provider_type" "text", "p_routing_type" "text", "p_schedule_type" "text", "p_planning_type" "text", "p_eligibility_req_contains" "text", "p_eligibility_type" "text", "p_provider_org" "text", "p_provider_name_contains" "text", "p_has_service_zone" boolean, "p_booking_method" "text", "p_fare_type" "text"); Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON FUNCTION "optimat"."filter_providers_with_coords"("p_origin_lat" numeric, "p_origin_lon" numeric, "p_dest_lat" numeric, "p_dest_lon" numeric, "p_provider_type" "text", "p_routing_type" "text", "p_schedule_type" "text", "p_planning_type" "text", "p_eligibility_req_contains" "text", "p_eligibility_type" "text", "p_provider_org" "text", "p_provider_name_contains" "text", "p_has_service_zone" boolean, "p_booking_method" "text", "p_fare_type" "text") IS 'Filters providers based on geocoded coordinates using PostGIS spatial containment.
Returns JSON with providers array.';


--
-- Name: get_provider_geojson(integer); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."get_provider_geojson"("p_provider_id" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'optimat', 'public'
    AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'type', 'Feature',
        'properties', jsonb_build_object(
            'provider_id', p.provider_id,
            'provider_name', p.provider_name,
            'provider_type', p.provider_type,
            'routing_type', p.routing_type,
            'schedule_type', p.schedule_type,
            'eligibility_reqs', p.eligibility_reqs,
            'contacts', p.contacts,
            'booking', p.booking,
            'fare', p.fare,
            'service_hours', p.service_hours,
            'website', p.website,
            'is_operating', p.is_operating
        ),
        'geometry', COALESCE(
            p.service_zone->'features'->0->'geometry',
            '{"type": "Point", "coordinates": [0, 0]}'::jsonb
        )
    )
    INTO result
    FROM optimat.providers p
    WHERE p.provider_id = p_provider_id;

    RETURN result;
END;
$$;


--
-- Name: get_providers_geojson(); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."get_providers_geojson"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'optimat', 'public'
    AS $$
BEGIN
    RETURN jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'type', 'Feature',
                        'properties', jsonb_build_object(
                            'provider_id', p.provider_id,
                            'provider_name', p.provider_name,
                            'provider_type', p.provider_type,
                            'routing_type', p.routing_type,
                            'is_operating', p.is_operating,
                            'website', p.website,
                            'service_hours', p.service_hours
                        ),
                        'geometry', COALESCE(
                            p.service_zone->'features'->0->'geometry',
                            '{"type": "Point", "coordinates": [0, 0]}'::jsonb
                        )
                    )
                )
                FROM optimat.providers p
                WHERE p.service_zone IS NOT NULL
            ),
            '[]'::jsonb
        )
    );
END;
$$;


--
-- Name: purge_stale_chat_trip_state(); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."purge_stale_chat_trip_state"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'optimat', 'public'
    AS $$
DECLARE
    removed INTEGER;
BEGIN
    DELETE FROM optimat.chat_trip_state WHERE updated_at < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;


--
-- Name: FUNCTION "purge_stale_chat_trip_state"(); Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON FUNCTION "optimat"."purge_stale_chat_trip_state"() IS 'Deletes chat trip state older than 30 days. Scheduled via pg_cron when available; safe to call manually.';


--
-- Name: search_providers("text", integer); Type: FUNCTION; Schema: optimat; Owner: -
--

CREATE FUNCTION "optimat"."search_providers"("search_query" "text", "limit_count" integer DEFAULT 20) RETURNS SETOF "optimat"."providers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'optimat', 'extensions', 'public'
    AS $$
BEGIN
    RETURN QUERY
    SELECT p.*
    FROM optimat.providers p
    WHERE
        p.provider_name ILIKE '%' || search_query || '%'
        OR p.provider_org ILIKE '%' || search_query || '%'
    ORDER BY
        extensions.similarity(p.provider_name, search_query) DESC
    LIMIT limit_count;
END;
$$;


--
-- Name: get_conversation_with_messages("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_conversation_with_messages"("conv_id" "uuid") RETURNS TABLE("conversation" "jsonb", "messages" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_jsonb(c.*) as conversation,
        COALESCE(
            jsonb_agg(
                to_jsonb(m.*) ORDER BY m.sequence_number
            ) FILTER (WHERE m.id IS NOT NULL),
            '[]'::jsonb
        ) as messages
    FROM public.conversations c
    LEFT JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.id = conv_id
    GROUP BY c.id, c.title, c.user_id, c.created_at, c.updated_at;
END;
$$;


--
-- Name: get_next_sequence_number("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."get_next_sequence_number"("conv_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    next_seq INTEGER;
BEGIN
    SELECT COALESCE(MAX(sequence_number), 0) + 1
    INTO next_seq
    FROM public.messages
    WHERE conversation_id = conv_id;

    RETURN next_seq;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


--
-- Name: chat_examples; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."chat_examples" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "title" "text",
    "description" "text",
    "tags" "text"[],
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "category" "text" DEFAULT 'general'::"text",
    "replay_config" "jsonb"
);


--
-- Name: chat_feedback; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."chat_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid",
    "message_id" "uuid",
    "reviewer_name" "text",
    "comment" "text" NOT NULL,
    "rating" "text" DEFAULT 'down'::"text" NOT NULL,
    "transcript" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "context" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chat_feedback_rating_check" CHECK (("rating" = ANY (ARRAY['up'::"text", 'down'::"text"])))
);


--
-- Name: TABLE "chat_feedback"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON TABLE "optimat"."chat_feedback" IS 'Tester feedback submitted from the chat, with the conversation transcript as it read at submission time.';


--
-- Name: COLUMN "chat_feedback"."reviewer_name"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."chat_feedback"."reviewer_name" IS 'Name the tester typed. Used to weight internal testers (Josh, Sofia) against external ones.';


--
-- Name: COLUMN "chat_feedback"."transcript"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."chat_feedback"."transcript" IS 'Auto-saved copy of the conversation at submission: array of {role, content, created_at}.';


--
-- Name: COLUMN "chat_feedback"."context"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."chat_feedback"."context" IS 'Submission context such as page URL, user agent, and the providers shown when feedback was given.';


--
-- Name: chat_feedback_review; Type: VIEW; Schema: optimat; Owner: -
--

CREATE VIEW "optimat"."chat_feedback_review" AS
 SELECT "id",
    "created_at",
    "reviewer_name",
    "rating",
    "comment",
    "conversation_id",
    ( SELECT ("t"."m" ->> 'content'::"text")
           FROM "jsonb_array_elements"("f"."transcript") WITH ORDINALITY "t"("m", "ord")
          WHERE (("t"."m" ->> 'role'::"text") = ANY (ARRAY['human'::"text", 'user'::"text"]))
          ORDER BY "t"."ord" DESC
         LIMIT 1) AS "last_rider_message",
    ( SELECT ("t"."m" ->> 'content'::"text")
           FROM "jsonb_array_elements"("f"."transcript") WITH ORDINALITY "t"("m", "ord")
          WHERE (("t"."m" ->> 'role'::"text") = ANY (ARRAY['ai'::"text", 'assistant'::"text"]))
          ORDER BY "t"."ord" DESC
         LIMIT 1) AS "last_assistant_message",
    "jsonb_array_length"("transcript") AS "transcript_length",
    "context"
   FROM "optimat"."chat_feedback" "f"
  ORDER BY "created_at" DESC;


--
-- Name: VIEW "chat_feedback_review"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON VIEW "optimat"."chat_feedback_review" IS 'Reviewer-facing flattening of optimat.chat_feedback: newest first, with the tail of the conversation inlined.';


--
-- Name: chat_trip_state; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."chat_trip_state" (
    "conversation_id" "uuid" NOT NULL,
    "trip" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_search" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: TABLE "chat_trip_state"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON TABLE "optimat"."chat_trip_state" IS 'Compact per-conversation trip digest the chat assistant reads at the start of each turn.';


--
-- Name: COLUMN "chat_trip_state"."trip"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."chat_trip_state"."trip" IS 'Resolved trip fields: canonical origin/destination, travel date, times, trip type, rider eligibility answers.';


--
-- Name: COLUMN "chat_trip_state"."last_search"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."chat_trip_state"."last_search" IS 'Digest of the most recent find_providers result: eligible / verification / excluded provider names with reasons, diagnostics, alternatives.';


--
-- Name: conversation_states; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."conversation_states" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "example_id" "uuid",
    "sequence_number" integer NOT NULL,
    "state_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ui_hints" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "show_providers" boolean DEFAULT false,
    "show_addresses" boolean DEFAULT false,
    "map_action" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: TABLE "conversation_states"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON TABLE "optimat"."conversation_states" IS 'Stores replay states for conversations to enable step-by-step playback';


--
-- Name: COLUMN "conversation_states"."sequence_number"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."conversation_states"."sequence_number" IS 'Order of the state in the replay sequence';


--
-- Name: COLUMN "conversation_states"."state_snapshot"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."conversation_states"."state_snapshot" IS 'Complete state at this point including providers, addresses, etc.';


--
-- Name: COLUMN "conversation_states"."ui_hints"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON COLUMN "optimat"."conversation_states"."ui_hints" IS 'UI hints for frontend display (show_providers, map_action, etc.)';


--
-- Name: conversations; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "title" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb"
);


--
-- Name: demand_response_manifest_review; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."demand_response_manifest_review" (
    "row_number" integer NOT NULL,
    "service_date" "date",
    "provider_id" smallint,
    "route" "text",
    "vehicle" "text",
    "stop_type" "text",
    "load_type" "text",
    "disposition" "text",
    "scheduled_time" time without time zone,
    "arrival_time" time without time zone,
    "departure_time" time without time zone,
    "dwell" interval,
    "appointment_time" time without time zone,
    "early" interval,
    "late" interval,
    "estimated_arrival" time without time zone,
    "odometer_miles" numeric,
    "address1" "text",
    "address2" "text",
    "city" "text",
    "state" "text",
    "zip_code" "text",
    "fare_type" "text",
    "fare_amount" numeric,
    "fare_collected" numeric,
    "schedule_type" "text",
    "equipment_type" "text",
    "trip_id" "text",
    "trip_distance" numeric,
    "travel_time" interval,
    "distance_from_previous" numeric,
    "travel_time_from_previous" interval,
    "slack" interval,
    "on_board" integer,
    "passengers_on_board" integer,
    "previous_passengers_on_board" integer
);


--
-- Name: demands; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."demands" (
    "submit_date" "date" NOT NULL,
    "submit_time" time without time zone NOT NULL,
    "demand_id" integer NOT NULL,
    "user_id" character varying(128),
    "from_addr" "text",
    "to_addr" "text",
    "trip_legs" smallint NOT NULL,
    "time_pickup" time without time zone NOT NULL,
    "time_appt" time without time zone,
    "time_return" time without time zone,
    "health_cond" character varying(128),
    "eligibility" character varying(128),
    "equipment" character varying(128),
    "companion" character varying(128)
);


--
-- Name: find_providers_calls; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."find_providers_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "tool_call_id" "text",
    "source_address" "text",
    "destination_address" "text",
    "provider_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "public_transit_data" "jsonb",
    "message_timestamp" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: general_question_calls; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."general_question_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "search_results" "jsonb",
    "sources" "jsonb",
    "message_timestamp" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: TABLE "general_question_calls"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON TABLE "optimat"."general_question_calls" IS 'Stores web search tool call results for general provider questions';


--
-- Name: geoaddress; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."geoaddress" (
    "No" integer,
    "rawNo" integer,
    "addr" "text",
    "lat" double precision,
    "lng" double precision,
    "pid" "text"
);


--
-- Name: get_provider_info_calls; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."get_provider_info_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "tool_call_id" "text",
    "provider_id" integer,
    "provider_info" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "message_timestamp" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: messages; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid",
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "attachments" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text", 'human'::"text", 'ai'::"text"])))
);


--
-- Name: mobility_matters; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."mobility_matters" (
    "Ride ID" integer,
    "Origin Address" "text",
    "Origin City" "text",
    "Destination Address" "text",
    "Destination City" "text",
    "Duration (hours)" double precision,
    "Origin Latitude" double precision,
    "Origin Longitude" double precision,
    "Destination Latitude" double precision,
    "Destination Longitude" double precision,
    "Origin Geometry" "extensions"."geometry",
    "Destination Geometry" "extensions"."geometry"
);


--
-- Name: providers_backup_service_area_20260518; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."providers_backup_service_area_20260518" (
    "id" "uuid",
    "provider_id" integer,
    "provider_name" "text",
    "provider_type" "text",
    "routing_type" "text",
    "schedule_type" "jsonb",
    "planning_type" "text",
    "eligibility_reqs" "jsonb",
    "provider_org" "text",
    "contacts" "jsonb",
    "booking" "jsonb",
    "fare" "jsonb",
    "service_hours" "text",
    "service_zone" "jsonb",
    "website" "text",
    "round_trip_booking" boolean,
    "investigated" boolean,
    "is_operating" boolean,
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "service_area_geojson" "jsonb",
    "service_area_cities" "text"[],
    "service_area_source" "text",
    "service_area_notes" "text",
    "provider_software" "text"
);


--
-- Name: TABLE "providers_backup_service_area_20260518"; Type: COMMENT; Schema: optimat; Owner: -
--

COMMENT ON TABLE "optimat"."providers_backup_service_area_20260518" IS 'Backup of optimat.providers before the 2026-05-18 service-area metadata import.';


--
-- Name: riderabilities; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."riderabilities" (
    "rider_id" integer NOT NULL,
    "arch_provider" character varying(45),
    "rider_type" "text",
    "disable_type" "text",
    "equipment" character varying(45),
    "companion" character varying(45),
    "eligibility-status" character varying(45),
    "sharing-allow" character varying(45)
);


--
-- Name: search_addresses_calls; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."search_addresses_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "tool_call_id" "text",
    "query_text" "text",
    "places_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "message_timestamp" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: transit_driving_driving; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."transit_driving_driving" (
    "trip_id" integer NOT NULL,
    "driving_summary" "text",
    "driving_distance_meters" integer,
    "driving_duration_seconds" integer,
    "driving_polyline" "text",
    "driving_warnings" "jsonb",
    "transit_summary" "text",
    "transit_distance_meters" integer,
    "transit_duration_seconds" integer,
    "transit_polyline" "text",
    "transit_warnings" "jsonb",
    "driving_raw" "jsonb",
    "transit_raw" "jsonb",
    "updated_at" timestamp with time zone
);


--
-- Name: tri_delta_transit; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."tri_delta_transit" (
    "Trip ID" integer,
    "Origin Address" "text",
    "Origin City" "text",
    "Destination Address" "text",
    "Destination City" "text",
    "Duration (hours)" double precision,
    "Origin Latitude" double precision,
    "Origin Longitude" double precision,
    "Destination Latitude" double precision,
    "Destination Longitude" double precision,
    "Origin Geometry" "extensions"."geometry"(Point,4326),
    "Destination Geometry" "extensions"."geometry"(Point,4326)
);


--
-- Name: trip_record_pairs_raw; Type: TABLE; Schema: optimat; Owner: -
--

CREATE TABLE "optimat"."trip_record_pairs_raw" (
    "no_pk" integer,
    "no_dp" integer,
    "trip_id" integer,
    "pick_time" time without time zone,
    "addr_pk" "text",
    "drop_time" time without time zone,
    "addr_dp" "text",
    "no_return" integer,
    "psg_on_brd" integer,
    "trip_id_return" integer,
    "outgo_dura" interval,
    "google_maps_route" "text",
    "google_route_distance_m" integer,
    "google_route_duration_s" integer,
    "google_route_summary" "text",
    "provider_id" integer
);


--
-- Name: chat_examples chat_examples_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."chat_examples"
    ADD CONSTRAINT "chat_examples_pkey" PRIMARY KEY ("id");


--
-- Name: chat_feedback chat_feedback_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."chat_feedback"
    ADD CONSTRAINT "chat_feedback_pkey" PRIMARY KEY ("id");


--
-- Name: chat_trip_state chat_trip_state_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."chat_trip_state"
    ADD CONSTRAINT "chat_trip_state_pkey" PRIMARY KEY ("conversation_id");


--
-- Name: conversation_states conversation_states_conversation_id_sequence_number_key; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."conversation_states"
    ADD CONSTRAINT "conversation_states_conversation_id_sequence_number_key" UNIQUE ("conversation_id", "sequence_number");


--
-- Name: conversation_states conversation_states_example_id_sequence_number_key; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."conversation_states"
    ADD CONSTRAINT "conversation_states_example_id_sequence_number_key" UNIQUE ("example_id", "sequence_number");


--
-- Name: conversation_states conversation_states_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."conversation_states"
    ADD CONSTRAINT "conversation_states_pkey" PRIMARY KEY ("id");


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");


--
-- Name: find_providers_calls find_providers_calls_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."find_providers_calls"
    ADD CONSTRAINT "find_providers_calls_pkey" PRIMARY KEY ("id");


--
-- Name: general_question_calls general_question_calls_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."general_question_calls"
    ADD CONSTRAINT "general_question_calls_pkey" PRIMARY KEY ("id");


--
-- Name: get_provider_info_calls get_provider_info_calls_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."get_provider_info_calls"
    ADD CONSTRAINT "get_provider_info_calls_pkey" PRIMARY KEY ("id");


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."providers"
    ADD CONSTRAINT "providers_pkey" PRIMARY KEY ("id");


--
-- Name: providers providers_provider_id_key; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."providers"
    ADD CONSTRAINT "providers_provider_id_key" UNIQUE ("provider_id");


--
-- Name: search_addresses_calls search_addresses_calls_pkey; Type: CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."search_addresses_calls"
    ADD CONSTRAINT "search_addresses_calls_pkey" PRIMARY KEY ("id");


--
-- Name: chat_feedback_conversation_idx; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "chat_feedback_conversation_idx" ON "optimat"."chat_feedback" USING "btree" ("conversation_id");


--
-- Name: chat_feedback_created_at_idx; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "chat_feedback_created_at_idx" ON "optimat"."chat_feedback" USING "btree" ("created_at" DESC);


--
-- Name: chat_trip_state_updated_at_idx; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "chat_trip_state_updated_at_idx" ON "optimat"."chat_trip_state" USING "btree" ("updated_at");


--
-- Name: idx_conversation_states_conversation; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_conversation_states_conversation" ON "optimat"."conversation_states" USING "btree" ("conversation_id");


--
-- Name: idx_conversation_states_example; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_conversation_states_example" ON "optimat"."conversation_states" USING "btree" ("example_id");


--
-- Name: idx_conversation_states_sequence; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_conversation_states_sequence" ON "optimat"."conversation_states" USING "btree" ("example_id", "sequence_number");


--
-- Name: idx_general_question_calls_conversation_id; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_general_question_calls_conversation_id" ON "optimat"."general_question_calls" USING "btree" ("conversation_id");


--
-- Name: idx_general_question_calls_timestamp; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_general_question_calls_timestamp" ON "optimat"."general_question_calls" USING "btree" ("message_timestamp" DESC);


--
-- Name: idx_optimat_chat_examples_active; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_chat_examples_active" ON "optimat"."chat_examples" USING "btree" ("is_active");


--
-- Name: idx_optimat_find_providers_conversation; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_find_providers_conversation" ON "optimat"."find_providers_calls" USING "btree" ("conversation_id");


--
-- Name: idx_optimat_find_providers_created; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_find_providers_created" ON "optimat"."find_providers_calls" USING "btree" ("created_at" DESC);


--
-- Name: idx_optimat_get_provider_info_conversation; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_get_provider_info_conversation" ON "optimat"."get_provider_info_calls" USING "btree" ("conversation_id");


--
-- Name: idx_optimat_get_provider_info_created; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_get_provider_info_created" ON "optimat"."get_provider_info_calls" USING "btree" ("created_at" DESC);


--
-- Name: idx_optimat_messages_conversation; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_messages_conversation" ON "optimat"."messages" USING "btree" ("conversation_id");


--
-- Name: idx_optimat_search_addresses_conversation; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_search_addresses_conversation" ON "optimat"."search_addresses_calls" USING "btree" ("conversation_id");


--
-- Name: idx_optimat_search_addresses_created; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_optimat_search_addresses_created" ON "optimat"."search_addresses_calls" USING "btree" ("created_at" DESC);


--
-- Name: idx_providers_name_trgm; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_providers_name_trgm" ON "optimat"."providers" USING "gin" ("provider_name" "extensions"."gin_trgm_ops");


--
-- Name: idx_providers_provider_id; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_providers_provider_id" ON "optimat"."providers" USING "btree" ("provider_id");


--
-- Name: idx_providers_provider_software; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_providers_provider_software" ON "optimat"."providers" USING "btree" ("provider_software") WHERE ("provider_software" IS NOT NULL);


--
-- Name: idx_providers_service_area_cities; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_providers_service_area_cities" ON "optimat"."providers" USING "gin" ("service_area_cities");


--
-- Name: idx_providers_service_zone; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_providers_service_zone" ON "optimat"."providers" USING "gin" ("service_zone" "jsonb_path_ops");


--
-- Name: idx_providers_type; Type: INDEX; Schema: optimat; Owner: -
--

CREATE INDEX "idx_providers_type" ON "optimat"."providers" USING "btree" ("provider_type");


--
-- Name: providers update_providers_updated_at; Type: TRIGGER; Schema: optimat; Owner: -
--

CREATE TRIGGER "update_providers_updated_at" BEFORE UPDATE ON "optimat"."providers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: chat_examples chat_examples_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."chat_examples"
    ADD CONSTRAINT "chat_examples_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: chat_feedback chat_feedback_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."chat_feedback"
    ADD CONSTRAINT "chat_feedback_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: chat_trip_state chat_trip_state_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."chat_trip_state"
    ADD CONSTRAINT "chat_trip_state_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: conversation_states conversation_states_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."conversation_states"
    ADD CONSTRAINT "conversation_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: conversation_states conversation_states_example_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."conversation_states"
    ADD CONSTRAINT "conversation_states_example_id_fkey" FOREIGN KEY ("example_id") REFERENCES "optimat"."chat_examples"("id") ON DELETE CASCADE;


--
-- Name: find_providers_calls find_providers_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."find_providers_calls"
    ADD CONSTRAINT "find_providers_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: general_question_calls general_question_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."general_question_calls"
    ADD CONSTRAINT "general_question_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: get_provider_info_calls get_provider_info_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."get_provider_info_calls"
    ADD CONSTRAINT "get_provider_info_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: search_addresses_calls search_addresses_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: optimat; Owner: -
--

ALTER TABLE ONLY "optimat"."search_addresses_calls"
    ADD CONSTRAINT "search_addresses_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "optimat"."conversations"("id") ON DELETE CASCADE;


--
-- Name: chat_feedback; Type: ROW SECURITY; Schema: optimat; Owner: -
--

ALTER TABLE "optimat"."chat_feedback" ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_trip_state; Type: ROW SECURITY; Schema: optimat; Owner: -
--

ALTER TABLE "optimat"."chat_trip_state" ENABLE ROW LEVEL SECURITY;

--
-- Name: providers; Type: ROW SECURITY; Schema: optimat; Owner: -
--

ALTER TABLE "optimat"."providers" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict 3CWSifjCxCsX8KC26OYdlI0JwJ6dwHubVCS5sbnc4oMQCXtzm7IaOWgB7aaV3ja
