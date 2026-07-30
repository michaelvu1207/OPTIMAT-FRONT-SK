/**
 * Messages Lambda Function for OPTIMAT
 * Provides CRUD operations for chat messages within conversations.
 *
 * Routes:
 * - GET  /messages?conversation_id=... - List messages for a conversation (paginated)
 * - GET  /messages/:id                 - Get a specific message
 * - POST /messages                     - Create a new message
 * - DELETE /messages/:id               - Delete a message
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, queryOne, TABLES, sanitizeRecord } from '../_shared/db.js';
import { requireMigrationAdmin } from '../_shared/admin.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Extract message ID from path segments: ['messages'] or ['messages', '<uuid>'] */
function getMessageId(segments: string[]): string | null {
  if (segments.length >= 2 && segments[0] === 'messages') {
    return segments[1];
  }
  return null;
}

/** Normalize role names: 'human' → 'user', 'ai' → 'assistant' */
function normalizeRole(role: string): string {
  const roleMap: Record<string, string> = {
    human: 'user',
    ai: 'assistant',
    system: 'system',
    user: 'user',
    assistant: 'assistant',
  };
  return roleMap[role.toLowerCase()] || role;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  const messageId = getMessageId(req.pathSegments);

  switch (req.method) {
    // ── GET ────────────────────────────────────────────────────────────────
    case 'GET': {
      if (messageId) {
        return await getMessage(messageId, req.origin);
      }
      const conversationId = req.searchParams.get('conversation_id');
      if (!conversationId) {
        return errorResponse('conversation_id query parameter required', 400, req.origin);
      }
      return await listMessages(conversationId, req.searchParams, req.origin);
    }

    // ── POST ───────────────────────────────────────────────────────────────
    case 'POST': {
      if (messageId) {
        return errorResponse('Cannot POST to a specific message ID', 400, req.origin);
      }
      const body = req.body as {
        conversation_id?: string;
        role?: string;
        content?: string;
        attachments?: Record<string, unknown>[];
      } | null;
      return await createMessage(body, req.origin);
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    case 'DELETE': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (!messageId) {
        return errorResponse('Message ID required', 400, req.origin);
      }
      return await deleteMessage(messageId, req.origin);
    }

    default:
      return errorResponse('Method not allowed', 405, req.origin);
  }
});

// ─── Route Handlers ────────────────────────────────────────────────────────

/**
 * List messages for a conversation with pagination.
 */
async function listMessages(
  conversationId: string,
  searchParams: URLSearchParams,
  origin: string | null,
) {
  // Verify conversation exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [conversationId],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100', 10), 1), 500);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

  // Get total count and paginated rows in parallel
  const [countResult, messages] = await Promise.all([
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${TABLES.MESSAGES} WHERE conversation_id = $1`,
      [conversationId],
    ),
    queryRows(
      `SELECT * FROM ${TABLES.MESSAGES}
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset],
    ),
  ]);

  const total = parseInt(countResult?.count || '0', 10);

  return jsonResponse(
    {
      messages: messages.map(sanitizeRecord),
      pagination: {
        total,
        limit,
        offset,
        has_more: total > offset + limit,
      },
    },
    200,
    origin,
  );
}

/**
 * Get a single message by ID.
 */
async function getMessage(messageId: string, origin: string | null) {
  const message = await queryOne(
    `SELECT * FROM ${TABLES.MESSAGES} WHERE id = $1`,
    [messageId],
  );

  if (!message) {
    return errorResponse('Message not found', 404, origin);
  }

  return jsonResponse(sanitizeRecord(message), 200, origin);
}

/**
 * Create a new message in a conversation.
 */
async function createMessage(
  body: {
    conversation_id?: string;
    role?: string;
    content?: string;
    attachments?: Record<string, unknown>[];
  } | null,
  origin: string | null,
) {
  if (!body?.conversation_id) {
    return errorResponse('conversation_id is required', 400, origin);
  }
  if (!body.role) {
    return errorResponse('role is required', 400, origin);
  }
  if (!body.content) {
    return errorResponse('content is required', 400, origin);
  }

  // Verify conversation exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [body.conversation_id],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  const normalizedRole = normalizeRole(body.role);
  const attachments = body.attachments ?? null;

  // Insert message
  const message = await queryOne(
    `INSERT INTO ${TABLES.MESSAGES} (conversation_id, role, content, attachments)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      body.conversation_id,
      normalizedRole,
      body.content,
      attachments ? JSON.stringify(attachments) : null,
    ],
  );

  if (!message) {
    return errorResponse('Error creating message', 500, origin);
  }

  // Update conversation's updated_at timestamp
  await query(
    `UPDATE ${TABLES.CONVERSATIONS} SET updated_at = NOW() WHERE id = $1`,
    [body.conversation_id],
  );

  return jsonResponse(sanitizeRecord(message), 201, origin);
}

/**
 * Delete a message by ID.
 */
async function deleteMessage(messageId: string, origin: string | null) {
  // Get message first to find its conversation_id
  const message = await queryOne<{ conversation_id: string }>(
    `SELECT conversation_id FROM ${TABLES.MESSAGES} WHERE id = $1`,
    [messageId],
  );

  if (!message) {
    return errorResponse('Message not found', 404, origin);
  }

  // Delete the message
  await query(`DELETE FROM ${TABLES.MESSAGES} WHERE id = $1`, [messageId]);

  // Update conversation's updated_at timestamp
  await query(
    `UPDATE ${TABLES.CONVERSATIONS} SET updated_at = NOW() WHERE id = $1`,
    [message.conversation_id],
  );

  return jsonResponse({ success: true, deleted: messageId }, 200, origin);
}
