-- Durable per-conversation trip state for the chat assistant.
--
-- Tool results previously died with the turn: history is rebuilt from optimat.messages,
-- which stores only role and text. The assistant could not see the resolved travel date,
-- which providers matched, or why any were excluded, so a follow-up question forced a
-- fresh search. This table is the assistant's memory between turns.
--
-- Only canonical, provider-facing facts are stored (geocoded addresses, provider names,
-- eligibility answers the rider volunteered) — never raw rider phrasing or contact details.

CREATE TABLE IF NOT EXISTS optimat.chat_trip_state (
    conversation_id UUID PRIMARY KEY
        REFERENCES optimat.conversations(id) ON DELETE CASCADE,
    trip            JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_search     JSONB,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE optimat.chat_trip_state IS
    'Compact per-conversation trip digest the chat assistant reads at the start of each turn.';
COMMENT ON COLUMN optimat.chat_trip_state.trip IS
    'Resolved trip fields: canonical origin/destination, travel date, times, trip type, rider eligibility answers.';
COMMENT ON COLUMN optimat.chat_trip_state.last_search IS
    'Digest of the most recent find_providers result: eligible / verification / excluded provider names with reasons, diagnostics, alternatives.';

CREATE INDEX IF NOT EXISTS chat_trip_state_updated_at_idx
    ON optimat.chat_trip_state (updated_at);

-- Retention: the digest is a working memory, not a record. Anything older than 30 days is
-- dropped so stale rider eligibility answers cannot linger.
CREATE OR REPLACE FUNCTION optimat.purge_stale_chat_trip_state()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = optimat, public
AS $$
DECLARE
    removed INTEGER;
BEGIN
    DELETE FROM optimat.chat_trip_state WHERE updated_at < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

COMMENT ON FUNCTION optimat.purge_stale_chat_trip_state() IS
    'Deletes chat trip state older than 30 days. Scheduled via pg_cron when available; safe to call manually.';

-- Schedule the purge when pg_cron is installed. The chat function also purges opportunistically,
-- so a project without pg_cron still stays clean.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_stale_chat_trip_state') THEN
            PERFORM cron.schedule(
                'purge_stale_chat_trip_state',
                '17 4 * * *',
                'SELECT optimat.purge_stale_chat_trip_state();'
            );
        END IF;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Skipped pg_cron scheduling for purge_stale_chat_trip_state: %', SQLERRM;
END;
$$;

-- The table is written only by the chat edge function under the service role.
ALTER TABLE optimat.chat_trip_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON optimat.chat_trip_state FROM anon, authenticated;
