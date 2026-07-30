/**
 * Chat Examples Lambda Handler
 *
 * Provides CRUD operations for chat example conversations.
 *
 * Routes:
 * - GET /chat-examples — List all chat examples (paginated, filter by is_active)
 * - GET /chat-examples/:id — Get a specific chat example
 * - GET /chat-examples/:id/with-states — Get example with replay states
 * - POST /chat-examples — Create a new chat example from a conversation
 * - PUT /chat-examples/:id — Update a chat example
 * - DELETE /chat-examples/:id — Delete a chat example and cascade states
 * - POST /chat-examples/:id/regenerate-states — Regenerate replay states
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, queryOne, sanitizeRecord, TABLES } from '../_shared/db.js';
import { requireMigrationAdmin } from '../_shared/admin.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CreateExampleRequest {
  conversation_id: string;
  title: string;
  description?: string;
  tags?: string[];
  category?: string;
  is_active?: boolean;
  replay_config?: ReplayConfig;
}

interface UpdateExampleRequest {
  title?: string;
  description?: string;
  tags?: string[];
  category?: string;
  is_active?: boolean;
  replay_config?: ReplayConfig;
}

interface ReplayConfig {
  autoAdvance?: boolean;
  delayMs?: number;
  showTypewriter?: boolean;
  highlightToolCalls?: boolean;
}

// ─── Path Parsing ───────────────────────────────────────────────────────────

function parseExamplePath(segments: string[]): { exampleId: string | null; action: string | null } {
  // Look for chat-examples/:id pattern
  const idx = segments.findIndex((p) => p === 'chat-examples');
  if (idx !== -1) {
    const potentialId = segments[idx + 1];
    const action = segments[idx + 2] || null;

    if (potentialId && /^[0-9a-f-]{36}$/i.test(potentialId)) {
      return { exampleId: potentialId, action };
    }
  }

  // Fallback: check last and second-to-last segments
  const lastPart = segments[segments.length - 1];
  const secondToLast = segments[segments.length - 2];

  if (lastPart && /^[0-9a-f-]{36}$/i.test(lastPart)) {
    return { exampleId: lastPart, action: null };
  }
  if (secondToLast && /^[0-9a-f-]{36}$/i.test(secondToLast)) {
    return { exampleId: secondToLast, action: lastPart };
  }

  return { exampleId: null, action: null };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  const { exampleId, action } = parseExamplePath(req.pathSegments);

  switch (req.method) {
    case 'GET': {
      if (exampleId) {
        if (action === 'with-states') {
          return await getExampleWithStates(exampleId, req.origin);
        }
        return await getExample(exampleId, req.origin);
      }
      return await listExamples(req.searchParams, req.origin);
    }

    case 'POST': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (exampleId && action === 'regenerate-states') {
        return await regenerateStates(exampleId, req.origin);
      }
      if (exampleId) {
        return errorResponse('Cannot POST to a specific example ID', 400, req.origin);
      }
      const body = req.body as CreateExampleRequest;
      return await createExample(body, req.origin);
    }

    case 'PUT': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (!exampleId) {
        return errorResponse('Example ID required', 400, req.origin);
      }
      const body = req.body as UpdateExampleRequest;
      return await updateExample(exampleId, body, req.origin);
    }

    case 'DELETE': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (!exampleId) {
        return errorResponse('Example ID required', 400, req.origin);
      }
      return await deleteExample(exampleId, req.origin);
    }

    default:
      return errorResponse('Method not allowed', 405, req.origin);
  }
});

// ─── Route Handlers ─────────────────────────────────────────────────────────

/**
 * List all chat examples, optionally filtered by active status.
 */
async function listExamples(
  searchParams: URLSearchParams,
  origin: string | null,
) {
  const isActive = searchParams.get('is_active');
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  let whereClause = '';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (isActive !== null) {
    whereClause = `WHERE is_active = $${paramIdx++}`;
    params.push(isActive === 'true');
  }

  // Get count
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${TABLES.CHAT_EXAMPLES} ${whereClause}`,
    params,
  );
  const total = parseInt(countResult?.count || '0', 10);

  // Get data
  const data = await queryRows(
    `SELECT * FROM ${TABLES.CHAT_EXAMPLES} ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset],
  );

  const examples = data.map((ex) => sanitizeRecord(ex));

  return jsonResponse(
    {
      data: examples,
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
 * Get a specific chat example by ID.
 */
async function getExample(
  exampleId: string,
  origin: string | null,
) {
  const example = await queryOne(
    `SELECT * FROM ${TABLES.CHAT_EXAMPLES} WHERE id = $1`,
    [exampleId],
  );

  if (!example) {
    return errorResponse('Chat example not found', 404, origin);
  }

  return jsonResponse(sanitizeRecord(example), 200, origin);
}

/**
 * Get a chat example with its replay states.
 */
async function getExampleWithStates(
  exampleId: string,
  origin: string | null,
) {
  // Fetch example
  const example = await queryOne(
    `SELECT * FROM ${TABLES.CHAT_EXAMPLES} WHERE id = $1`,
    [exampleId],
  );

  if (!example) {
    return errorResponse('Chat example not found', 404, origin);
  }

  // Fetch states
  const states = await queryRows(
    `SELECT * FROM ${TABLES.CONVERSATION_STATES} WHERE example_id = $1 ORDER BY sequence_number ASC`,
    [exampleId],
  );

  // Format states
  const formattedStates = states.map((state) => ({
    sequence_number: state.sequence_number,
    message: state.state_snapshot?.message || state.message_data || {},
    state_snapshot: state.state_snapshot || {},
    ui_hints: state.ui_hints || {},
  }));

  const result = {
    ...sanitizeRecord(example),
    states: formattedStates,
  };

  return jsonResponse(result, 200, origin);
}

/**
 * Create a new chat example from a conversation.
 */
async function createExample(
  body: CreateExampleRequest,
  origin: string | null,
) {
  if (!body.conversation_id) {
    return errorResponse('conversation_id is required', 400, origin);
  }

  if (!body.title) {
    return errorResponse('title is required', 400, origin);
  }

  // Verify conversation exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [body.conversation_id],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  // Create example
  const data = await queryOne(
    `INSERT INTO ${TABLES.CHAT_EXAMPLES}
       (conversation_id, title, description, tags, category, is_active, replay_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      body.conversation_id,
      body.title,
      body.description || null,
      JSON.stringify(body.tags || []),
      body.category || 'general',
      body.is_active !== false,
      body.replay_config ? JSON.stringify(body.replay_config) : null,
    ],
  );

  if (!data) {
    return errorResponse('Error creating chat example', 500, origin);
  }

  return jsonResponse(sanitizeRecord(data), 201, origin);
}

/**
 * Update a chat example.
 */
async function updateExample(
  exampleId: string,
  body: UpdateExampleRequest,
  origin: string | null,
) {
  // Build dynamic SET clause
  const setClauses: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (body.title !== undefined) {
    setClauses.push(`title = $${paramIdx++}`);
    params.push(body.title);
  }
  if (body.description !== undefined) {
    setClauses.push(`description = $${paramIdx++}`);
    params.push(body.description);
  }
  if (body.tags !== undefined) {
    setClauses.push(`tags = $${paramIdx++}`);
    params.push(JSON.stringify(body.tags));
  }
  if (body.category !== undefined) {
    setClauses.push(`category = $${paramIdx++}`);
    params.push(body.category);
  }
  if (body.is_active !== undefined) {
    setClauses.push(`is_active = $${paramIdx++}`);
    params.push(body.is_active);
  }
  if (body.replay_config !== undefined) {
    setClauses.push(`replay_config = $${paramIdx++}`);
    params.push(JSON.stringify(body.replay_config));
  }

  params.push(exampleId);

  const data = await queryOne(
    `UPDATE ${TABLES.CHAT_EXAMPLES}
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIdx}
     RETURNING *`,
    params,
  );

  if (!data) {
    return errorResponse('Chat example not found', 404, origin);
  }

  return jsonResponse(sanitizeRecord(data), 200, origin);
}

/**
 * Delete a chat example and its associated states.
 */
async function deleteExample(
  exampleId: string,
  origin: string | null,
) {
  // Delete associated conversation states first
  await query(
    `DELETE FROM ${TABLES.CONVERSATION_STATES} WHERE example_id = $1`,
    [exampleId],
  );

  // Delete the example
  const result = await query(
    `DELETE FROM ${TABLES.CHAT_EXAMPLES} WHERE id = $1`,
    [exampleId],
  );

  if (result.rowCount === 0) {
    return errorResponse('Chat example not found', 404, origin);
  }

  return jsonResponse({ success: true, deleted: exampleId }, 200, origin);
}

/**
 * Regenerate replay states for an example from its source conversation.
 */
async function regenerateStates(
  exampleId: string,
  origin: string | null,
) {
  // Fetch the example to get conversation_id
  const example = await queryOne(
    `SELECT * FROM ${TABLES.CHAT_EXAMPLES} WHERE id = $1`,
    [exampleId],
  );

  if (!example) {
    return errorResponse('Chat example not found', 404, origin);
  }

  const conversationId = example.conversation_id;

  // Verify conversation still exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [conversationId],
  );

  if (!conversation) {
    return errorResponse('Source conversation no longer exists', 404, origin);
  }

  // Generate new states using the replay generation logic
  const states = await generateReplayStatesForConversation(conversationId);

  // Delete existing states
  await query(
    `DELETE FROM ${TABLES.CONVERSATION_STATES} WHERE example_id = $1`,
    [exampleId],
  );

  // Insert new states
  if (states.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const state of states) {
      placeholders.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
      );
      values.push(
        conversationId,
        exampleId,
        state.sequence_number,
        JSON.stringify({
          message: state.message,
          ...state.state_snapshot,
        }),
        JSON.stringify(state.ui_hints),
        state.ui_hints?.show_providers || false,
        state.ui_hints?.show_addresses || false,
        state.ui_hints?.map_action || null,
      );
    }

    await query(
      `INSERT INTO ${TABLES.CONVERSATION_STATES}
         (conversation_id, example_id, sequence_number, state_snapshot, ui_hints, show_providers, show_addresses, map_action)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  // Return the updated example with states
  return await getExampleWithStates(exampleId, origin);
}

// ─── Replay State Generation ────────────────────────────────────────────────

/**
 * Generate replay states from conversation history and tool calls.
 * This mirrors the logic from the Python replay_service.
 */
async function generateReplayStatesForConversation(
  conversationId: string,
): Promise<Array<{
  sequence_number: number;
  message: Record<string, unknown>;
  state_snapshot: Record<string, unknown>;
  ui_hints: Record<string, unknown>;
}>> {
  // Fetch messages
  const messages = await queryRows(
    `SELECT * FROM ${TABLES.MESSAGES} WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );

  if (messages.length === 0) {
    return [];
  }

  // Fetch tool calls
  const [findProvidersCalls, searchAddressesCalls, getProviderInfoCalls] = await Promise.all([
    queryRows(
      `SELECT * FROM ${TABLES.FIND_PROVIDERS_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    ),
    queryRows(
      `SELECT * FROM ${TABLES.SEARCH_ADDRESSES_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    ),
    queryRows(
      `SELECT * FROM ${TABLES.GET_PROVIDER_INFO_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    ),
  ]);

  // Build tool calls timeline
  const toolCalls: Array<{
    type: string;
    id: string;
    created_at: string;
    data: Record<string, unknown>;
  }> = [];

  for (const call of findProvidersCalls) {
    toolCalls.push({ type: 'find_providers', id: call.id, created_at: call.created_at, data: call });
  }
  for (const call of searchAddressesCalls) {
    toolCalls.push({ type: 'search_addresses', id: call.id, created_at: call.created_at, data: call });
  }
  for (const call of getProviderInfoCalls) {
    toolCalls.push({ type: 'get_provider_info', id: call.id, created_at: call.created_at, data: call });
  }

  toolCalls.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Build states
  const states: Array<{
    sequence_number: number;
    message: Record<string, unknown>;
    state_snapshot: Record<string, unknown>;
    ui_hints: Record<string, unknown>;
  }> = [];

  const cumulativeState: Record<string, unknown> = {
    providers: [],
    addresses: [],
    source_address: null,
    destination_address: null,
    origin: null,
    destination: null,
    public_transit: null,
    provider_details: {},
    service_zones: [],
  };

  const processedToolCalls = new Set<string>();

  for (let idx = 0; idx < messages.length; idx++) {
    const message = messages[idx];
    const messageTime = message.created_at;

    const applicableCalls = toolCalls.filter(
      (call) => call.created_at <= messageTime && !processedToolCalls.has(call.id),
    );

    // Apply tool calls to state
    for (const call of applicableCalls) {
      if (call.type === 'find_providers') {
        const data = call.data;
        const providerData = data.provider_data || {};
        const providers = Array.isArray(providerData) ? providerData : (providerData as Record<string, unknown>).data || [];

        cumulativeState.providers = providers;
        if (data.source_address) cumulativeState.source_address = data.source_address;
        if (data.destination_address) cumulativeState.destination_address = data.destination_address;
        if (data.public_transit_data) cumulativeState.public_transit = data.public_transit_data;

        if ((providerData as Record<string, unknown>).origin) cumulativeState.origin = (providerData as Record<string, unknown>).origin;
        if ((providerData as Record<string, unknown>).destination) cumulativeState.destination = (providerData as Record<string, unknown>).destination;
      } else if (call.type === 'search_addresses') {
        const placesData = call.data.places_data || {};
        const places = Array.isArray(placesData) ? placesData : (placesData as Record<string, unknown>).places || [];
        const addresses = cumulativeState.addresses as Array<Record<string, unknown>>;
        for (const place of places as Array<Record<string, unknown>>) {
          if (!addresses.find((a) => JSON.stringify(a) === JSON.stringify(place))) {
            addresses.push(place);
          }
        }
      } else if (call.type === 'get_provider_info') {
        const providerId = call.data.provider_id;
        const providerInfo = call.data.provider_info;
        if (providerId && providerInfo) {
          (cumulativeState.provider_details as Record<string, unknown>)[String(providerId)] = providerInfo;
        }
      }
    }

    // Compute UI hints
    const role = message.role;
    const uiHints: Record<string, unknown> = {
      show_providers: false,
      show_addresses: false,
      map_action: null,
      highlight_tool: null,
      new_data: {},
    };

    const newFindProviders = applicableCalls.some((c) => c.type === 'find_providers');
    const newSearchAddresses = applicableCalls.some((c) => c.type === 'search_addresses');
    const newGetProviderInfo = applicableCalls.some((c) => c.type === 'get_provider_info');

    if (role === 'assistant' || role === 'ai') {
      if (newFindProviders) {
        uiHints.show_providers = true;
        uiHints.highlight_tool = 'find_providers';
        uiHints.map_action = 'showServiceZones';
      }
      if (newSearchAddresses) {
        uiHints.show_addresses = true;
        if (!uiHints.highlight_tool) uiHints.highlight_tool = 'search_addresses';
        if (!uiHints.map_action) uiHints.map_action = 'addPings';
      }
      if (newGetProviderInfo) {
        if (!uiHints.highlight_tool) uiHints.highlight_tool = 'get_provider_info';
      }
    }

    for (const call of applicableCalls) {
      processedToolCalls.add(call.id);
    }

    states.push({
      sequence_number: idx + 1,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        created_at: message.created_at,
      },
      state_snapshot: {
        providers: cumulativeState.providers,
        addresses: cumulativeState.addresses,
        source_address: cumulativeState.source_address,
        destination_address: cumulativeState.destination_address,
        origin: cumulativeState.origin,
        destination: cumulativeState.destination,
        public_transit: cumulativeState.public_transit,
        provider_details: cumulativeState.provider_details,
        service_zones: cumulativeState.service_zones,
      },
      ui_hints: uiHints,
    });
  }

  return states;
}
