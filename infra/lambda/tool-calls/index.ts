/**
 * Tool Calls Lambda Handler
 *
 * Provides read access to tool call history for conversations.
 *
 * Routes:
 * - GET /tool-calls?conversation_id=:id — Get all tool calls for a conversation
 * - GET /tool-calls?conversation_id=:id&tool_name=:name — Get tool calls filtered by type
 * - GET /tool-calls/recent?conversation_id=:id&limit=:n — Get recent tool calls across all types
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { queryRows, queryOne, sanitizeRecord, TABLES } from '../_shared/db.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  conversation_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  result_data?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  created_at: string;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed', 405, req.origin);
  }

  const conversationId = req.searchParams.get('conversation_id');
  const toolName = req.searchParams.get('tool_name');
  const limit = parseInt(req.searchParams.get('limit') || '50', 10);

  if (!conversationId) {
    return errorResponse('conversation_id query parameter required', 400, req.origin);
  }

  // Verify conversation exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [conversationId],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, req.origin);
  }

  // Determine sub-route
  const isRecent = req.pathSegments.includes('recent');

  if (isRecent) {
    return await getRecentToolCalls(conversationId, limit, req.origin);
  }

  if (toolName) {
    return await getToolCallsByType(conversationId, toolName, req.origin);
  }

  return await getAllToolCalls(conversationId, req.origin);
});

// ─── Route Handlers ─────────────────────────────────────────────────────────

/**
 * Get all tool calls for a conversation, organized by type.
 */
async function getAllToolCalls(
  conversationId: string,
  origin: string | null,
) {
  const [findProviders, searchAddresses, getProviderInfo, generalQuestion] = await Promise.all([
    queryRows(`SELECT * FROM ${TABLES.FIND_PROVIDERS_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]),
    queryRows(`SELECT * FROM ${TABLES.SEARCH_ADDRESSES_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]),
    queryRows(`SELECT * FROM ${TABLES.GET_PROVIDER_INFO_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]),
    queryRows(`SELECT * FROM ${TABLES.GENERAL_QUESTION_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]),
  ]);

  return jsonResponse(
    {
      conversation_id: conversationId,
      tool_calls: {
        find_providers: findProviders.map((c) => sanitizeRecord(c)),
        search_addresses: searchAddresses.map((c) => sanitizeRecord(c)),
        get_provider_info: getProviderInfo.map((c) => sanitizeRecord(c)),
        general_provider_question: generalQuestion.map((c) => sanitizeRecord(c)),
      },
    },
    200,
    origin,
  );
}

/**
 * Get tool calls filtered by tool type.
 */
async function getToolCallsByType(
  conversationId: string,
  toolName: string,
  origin: string | null,
) {
  let tableName: string;

  switch (toolName) {
    case 'find_providers':
      tableName = TABLES.FIND_PROVIDERS_CALLS;
      break;
    case 'search_addresses':
    case 'search_addresses_from_user_query':
      tableName = TABLES.SEARCH_ADDRESSES_CALLS;
      break;
    case 'get_provider_info':
      tableName = TABLES.GET_PROVIDER_INFO_CALLS;
      break;
    case 'general_provider_question':
    case 'general_question':
      tableName = TABLES.GENERAL_QUESTION_CALLS;
      break;
    default:
      return errorResponse(`Unknown tool name: ${toolName}`, 400, origin);
  }

  const data = await queryRows(
    `SELECT * FROM ${tableName} WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );

  return jsonResponse(
    {
      conversation_id: conversationId,
      tool_name: toolName,
      calls: data.map((c) => sanitizeRecord(c)),
    },
    200,
    origin,
  );
}

/**
 * Get recent tool calls across all types, sorted by created_at.
 */
async function getRecentToolCalls(
  conversationId: string,
  limit: number,
  origin: string | null,
) {
  const [findProvidersData, searchAddressesData, getProviderInfoData, generalQuestionData] = await Promise.all([
    queryRows(
      `SELECT * FROM ${TABLES.FIND_PROVIDERS_CALLS} WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    ),
    queryRows(
      `SELECT * FROM ${TABLES.SEARCH_ADDRESSES_CALLS} WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    ),
    queryRows(
      `SELECT * FROM ${TABLES.GET_PROVIDER_INFO_CALLS} WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    ),
    queryRows(
      `SELECT * FROM ${TABLES.GENERAL_QUESTION_CALLS} WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    ),
  ]);

  // Normalize all tool calls to a common format
  const allCalls: ToolCall[] = [];

  for (const call of findProvidersData) {
    allCalls.push({
      id: call.id,
      conversation_id: call.conversation_id,
      tool_name: 'find_providers',
      result_data: {
        data: call.provider_data?.data || call.provider_data || [],
        source_address: call.source_address,
        destination_address: call.destination_address,
        public_transit: call.public_transit_data,
      },
      parameters: {
        source_address: call.source_address,
        destination_address: call.destination_address,
      },
      created_at: call.created_at,
    });
  }

  for (const call of searchAddressesData) {
    allCalls.push({
      id: call.id,
      conversation_id: call.conversation_id,
      tool_name: 'search_addresses_from_user_query',
      result_data: call.places_data,
      parameters: {
        user_query: call.query_text,
      },
      created_at: call.created_at,
    });
  }

  for (const call of getProviderInfoData) {
    allCalls.push({
      id: call.id,
      conversation_id: call.conversation_id,
      tool_name: 'get_provider_info',
      result_data: call.provider_info,
      parameters: {
        provider_id: call.provider_id,
      },
      created_at: call.created_at,
    });
  }

  for (const call of generalQuestionData) {
    allCalls.push({
      id: call.id,
      conversation_id: call.conversation_id,
      tool_name: 'general_provider_question',
      result_data: {
        query: call.question,
        answer: (call.search_results as Record<string, unknown> | null)?.answer ?? null,
        sources: call.sources || [],
      },
      parameters: {
        question: call.question,
      },
      created_at: call.created_at,
    });
  }

  // Sort by created_at descending and limit
  allCalls.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const limitedCalls = allCalls.slice(0, limit);

  return jsonResponse(
    {
      conversation_id: conversationId,
      tool_calls: limitedCalls.map((c) => sanitizeRecord(c as unknown as Record<string, unknown>)),
    },
    200,
    origin,
  );
}
