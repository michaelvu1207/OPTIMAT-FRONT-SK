-- Rider feedback on a chat conversation.
--
-- Testers (CCTA staff, Josh and Sofia internally, external riders later) currently have nowhere to
-- report that an answer was wrong except email. This table is the collection point: one row per
-- submission, carrying the tester's name, their comment, and a snapshot of the conversation as it
-- read at the moment they complained. The snapshot matters because optimat.messages keeps changing
-- as the same conversation continues — the transcript stored here is what the tester actually saw.
--
-- Reviewing feedback is a back-office activity (SQL / Supabase dashboard), so nothing here is
-- readable with the public anon key.

CREATE TABLE IF NOT EXISTS optimat.chat_feedback (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid REFERENCES optimat.conversations(id) ON DELETE CASCADE,
    -- The assistant message the feedback bubble was attached to, when known. Not a foreign key:
    -- feedback on a replayed or unsaved message must still be accepted rather than rejected.
    message_id      uuid,
    reviewer_name   text,
    comment         text NOT NULL,
    -- 'down' is the default because the button ships as a thumbs-down; 'up' is reserved for a
    -- positive variant so the column does not need widening later.
    rating          text NOT NULL DEFAULT 'down' CHECK (rating IN ('up', 'down')),
    -- The conversation as rendered when the tester submitted: [{role, content, created_at}, ...].
    transcript      jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Free-form submission context: page URL, user agent, whichever providers were on screen.
    context         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE optimat.chat_feedback IS
    'Tester feedback submitted from the chat, with the conversation transcript as it read at submission time.';
COMMENT ON COLUMN optimat.chat_feedback.reviewer_name IS
    'Name the tester typed. Used to weight internal testers (Josh, Sofia) against external ones.';
COMMENT ON COLUMN optimat.chat_feedback.transcript IS
    'Auto-saved copy of the conversation at submission: array of {role, content, created_at}.';
COMMENT ON COLUMN optimat.chat_feedback.context IS
    'Submission context such as page URL, user agent, and the providers shown when feedback was given.';

CREATE INDEX IF NOT EXISTS chat_feedback_created_at_idx
    ON optimat.chat_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS chat_feedback_conversation_idx
    ON optimat.chat_feedback (conversation_id);

-- Written only by the feedback edge function under the service role; read only by staff.
ALTER TABLE optimat.chat_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON optimat.chat_feedback FROM anon, authenticated;

-- Newest feedback first, with the tester's last message and the reply they were reacting to, so a
-- reviewer can read a week of feedback without unpacking JSON by hand.
CREATE OR REPLACE VIEW optimat.chat_feedback_review AS
SELECT
    f.id,
    f.created_at,
    f.reviewer_name,
    f.rating,
    f.comment,
    f.conversation_id,
    (
        SELECT t.m ->> 'content'
        FROM jsonb_array_elements(f.transcript) WITH ORDINALITY AS t(m, ord)
        WHERE t.m ->> 'role' IN ('human', 'user')
        ORDER BY t.ord DESC
        LIMIT 1
    ) AS last_rider_message,
    (
        SELECT t.m ->> 'content'
        FROM jsonb_array_elements(f.transcript) WITH ORDINALITY AS t(m, ord)
        WHERE t.m ->> 'role' IN ('ai', 'assistant')
        ORDER BY t.ord DESC
        LIMIT 1
    ) AS last_assistant_message,
    jsonb_array_length(f.transcript) AS transcript_length,
    f.context
FROM optimat.chat_feedback f
ORDER BY f.created_at DESC;

COMMENT ON VIEW optimat.chat_feedback_review IS
    'Reviewer-facing flattening of optimat.chat_feedback: newest first, with the tail of the conversation inlined.';

REVOKE ALL ON optimat.chat_feedback_review FROM anon, authenticated;
