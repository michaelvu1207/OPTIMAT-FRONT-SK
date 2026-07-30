import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { queryOne, queryRows, TABLES } from '../_shared/db.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMMENT_LENGTH = 4000;
const MAX_NAME_LENGTH = 120;
const MAX_TRANSCRIPT_MESSAGES = 200;

type TranscriptMessage = { role?: string; content?: string; created_at?: string };
type SubmitFeedbackRequest = {
  conversation_id?: string | null;
  message_id?: string | null;
  name?: string | null;
  comment?: string;
  rating?: string | null;
  transcript?: TranscriptMessage[];
  context?: Record<string, unknown>;
};

function trimToLength(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function asUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function normalizeTranscript(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is TranscriptMessage => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      role: typeof item.role === 'string' ? item.role : 'unknown',
      content: typeof item.content === 'string' ? item.content : '',
      created_at: typeof item.created_at === 'string' ? item.created_at : undefined,
    }))
    .filter((item) => item.content?.trim())
    .slice(-MAX_TRANSCRIPT_MESSAGES);
}

export const handler = createHandler(async (req) => {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req.origin);
  if (!req.body || typeof req.body !== 'object') {
    return errorResponse('Request body must be JSON', 400, req.origin);
  }

  const body = req.body as SubmitFeedbackRequest;
  const comment = trimToLength(body.comment, MAX_COMMENT_LENGTH);
  if (!comment) return errorResponse('Feedback comment is required', 400, req.origin);

  const conversationId = asUuid(body.conversation_id);
  let transcript = normalizeTranscript(body.transcript);
  if (!transcript.length && conversationId) {
    transcript = normalizeTranscript(await queryRows(
      `SELECT role, content, created_at FROM ${TABLES.MESSAGES}
       WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    ));
  }

  const context = {
    ...(body.context && typeof body.context === 'object' ? body.context : {}),
    origin: req.origin,
    user_agent: req.headers['user-agent'] || null,
    submitted_at: new Date().toISOString(),
  };
  const row = await queryOne<{ id: string; created_at: string }>(
    `INSERT INTO ${TABLES.CHAT_FEEDBACK}
      (conversation_id, message_id, reviewer_name, comment, rating, transcript, context)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     RETURNING id, created_at`,
    [
      conversationId,
      asUuid(body.message_id),
      trimToLength(body.name, MAX_NAME_LENGTH),
      comment,
      body.rating === 'up' ? 'up' : 'down',
      JSON.stringify(transcript),
      JSON.stringify(context),
    ],
  );
  if (!row) return errorResponse('Error saving feedback', 500, req.origin);

  return jsonResponse({
    success: true,
    id: String(row.id),
    created_at: row.created_at,
    transcript_length: transcript.length,
  }, 201, req.origin);
});
