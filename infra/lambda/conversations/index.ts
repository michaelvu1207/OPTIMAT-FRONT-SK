/**
 * Conversations Lambda Function for OPTIMAT
 * Provides CRUD operations for chat conversations.
 *
 * Routes:
 * - GET  /conversations            - List all conversations (paginated)
 * - GET  /conversations/:id        - Get a conversation with its messages
 * - POST /conversations            - Create a new conversation (auto-insert greeting)
 * - PUT  /conversations/:id        - Update title/metadata
 * - DELETE /conversations/:id      - Delete with cascade
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, queryOne, TABLES, sanitizeRecord } from '../_shared/db.js';
import { requireMigrationAdmin } from '../_shared/admin.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Extract conversation ID from path segments: ['conversations'] or ['conversations', '<uuid>'] */
function getConversationId(segments: string[]): string | null {
  if (segments.length >= 2 && segments[0] === 'conversations') {
    return segments[1];
  }
  return null;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  const conversationId = getConversationId(req.pathSegments);

  switch (req.method) {
    // ── GET ────────────────────────────────────────────────────────────────
    case 'GET': {
      if (conversationId) {
        return await getConversation(conversationId, req.origin);
      }
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      return await listConversations(req.searchParams, req.origin);
    }

    // ── POST ───────────────────────────────────────────────────────────────
    case 'POST': {
      if (conversationId) {
        return errorResponse('Cannot POST to a specific conversation ID', 400, req.origin);
      }
      const body = req.body as { title?: string; metadata?: Record<string, unknown> } | null;
      return await createConversation(body, req.origin);
    }

    // ── PUT ────────────────────────────────────────────────────────────────
    case 'PUT': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (!conversationId) {
        return errorResponse('Conversation ID required', 400, req.origin);
      }
      const body = req.body as { title?: string; metadata?: Record<string, unknown> } | null;
      return await updateConversation(conversationId, body, req.origin);
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    case 'DELETE': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (!conversationId) {
        return errorResponse('Conversation ID required', 400, req.origin);
      }
      return await deleteConversation(conversationId, req.origin);
    }

    default:
      return errorResponse('Method not allowed', 405, req.origin);
  }
});

// ─── Route Handlers ────────────────────────────────────────────────────────

/**
 * List all conversations with pagination.
 */
async function listConversations(
  searchParams: URLSearchParams,
  origin: string | null,
) {
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 200);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

  // Get total count and paginated rows in parallel
  const [countResult, rows] = await Promise.all([
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${TABLES.CONVERSATIONS}`,
    ),
    queryRows(
      `SELECT * FROM ${TABLES.CONVERSATIONS}
       ORDER BY updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
  ]);

  const total = parseInt(countResult?.count || '0', 10);
  const conversations = rows.map(sanitizeRecord);

  return jsonResponse(
    {
      data: conversations,
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
 * Get a single conversation with all its messages.
 */
async function getConversation(conversationId: string, origin: string | null) {
  const conversation = await queryOne(
    `SELECT * FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [conversationId],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  const messages = await queryRows(
    `SELECT * FROM ${TABLES.MESSAGES}
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );

  return jsonResponse(
    {
      ...sanitizeRecord(conversation),
      messages: messages.map(sanitizeRecord),
    },
    200,
    origin,
  );
}

/**
 * Create a new conversation and insert an initial greeting message.
 */
async function createConversation(
  body: { title?: string; metadata?: Record<string, unknown> } | null,
  origin: string | null,
) {
  const title = body?.title || 'New Conversation';
  const metadata = body?.metadata ?? null;

  const conversation = await queryOne(
    `INSERT INTO ${TABLES.CONVERSATIONS} (title, metadata)
     VALUES ($1, $2)
     RETURNING *`,
    [title, metadata ? JSON.stringify(metadata) : null],
  );

  if (!conversation) {
    return errorResponse('Error creating conversation', 500, origin);
  }

  // Insert initial assistant greeting message
  await query(
    `INSERT INTO ${TABLES.MESSAGES} (conversation_id, role, content)
     VALUES ($1, $2, $3)`,
    [
      conversation.id,
      'assistant',
      "Hi! I'm here to help you find transportation services. How can I assist you today?",
    ],
  );

  return jsonResponse(sanitizeRecord(conversation), 201, origin);
}

/**
 * Update a conversation's title and/or metadata.
 */
async function updateConversation(
  conversationId: string,
  body: { title?: string; metadata?: Record<string, unknown> } | null,
  origin: string | null,
) {
  if (!body) {
    return errorResponse('Request body required', 400, origin);
  }

  // Build dynamic SET clause
  const setClauses: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (body.title !== undefined) {
    setClauses.push(`title = $${paramIdx++}`);
    params.push(body.title);
  }

  if (body.metadata !== undefined) {
    setClauses.push(`metadata = $${paramIdx++}`);
    params.push(body.metadata ? JSON.stringify(body.metadata) : null);
  }

  // Add conversationId as last param
  params.push(conversationId);

  const conversation = await queryOne(
    `UPDATE ${TABLES.CONVERSATIONS}
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIdx}
     RETURNING *`,
    params,
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  return jsonResponse(sanitizeRecord(conversation), 200, origin);
}

/**
 * Delete a conversation and cascade-delete all related records.
 */
async function deleteConversation(conversationId: string, origin: string | null) {
  // Verify conversation exists
  const existing = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [conversationId],
  );

  if (!existing) {
    return errorResponse('Conversation not found', 404, origin);
  }

  // Delete dependent records in order (child tables first)
  const dependentTables = [
    TABLES.MESSAGES,
    TABLES.FIND_PROVIDERS_CALLS,
    TABLES.SEARCH_ADDRESSES_CALLS,
    TABLES.GET_PROVIDER_INFO_CALLS,
    TABLES.CONVERSATION_STATES,
    TABLES.CHAT_EXAMPLES,
  ];

  for (const table of dependentTables) {
    await query(`DELETE FROM ${table} WHERE conversation_id = $1`, [conversationId]);
  }

  // Delete the conversation itself
  await query(`DELETE FROM ${TABLES.CONVERSATIONS} WHERE id = $1`, [conversationId]);

  return jsonResponse({ success: true, deleted: conversationId }, 200, origin);
}
