/**
 * Replay Lambda Handler
 *
 * Generates replay data for conversation visualization.
 *
 * Routes:
 * - GET /replay?conversation_id=:id — Generate replay data for a conversation
 * - POST /replay/save-as-example — Save a conversation as an example with generated states
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, queryOne, sanitizeRecord, TABLES } from '../_shared/db.js';
import { requireMigrationAdmin } from '../_shared/admin.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ReplayConfig {
  autoAdvance?: boolean;
  delayMs?: number;
  showTypewriter?: boolean;
  highlightToolCalls?: boolean;
}

interface UIHints {
  show_providers: boolean;
  show_addresses: boolean;
  map_action: string | null;
  highlight_tool: string | null;
  new_data: Record<string, unknown>;
}

interface StateSnapshot {
  providers: Array<Record<string, unknown>>;
  addresses: Array<Record<string, unknown>>;
  source_address: string | null;
  destination_address: string | null;
  origin: Record<string, unknown> | null;
  destination: Record<string, unknown> | null;
  public_transit: Record<string, unknown> | null;
  provider_details: Record<string, unknown>;
  service_zones: Array<Record<string, unknown>>;
}

interface ConversationState {
  sequence_number: number;
  message: Record<string, unknown>;
  state_snapshot: StateSnapshot;
  ui_hints: UIHints;
  attachments?: Array<Record<string, unknown>>;
}

interface ConversationReplay {
  conversation_id: string;
  title: string | null;
  description: string | null;
  created_at: string;
  replay_config: ReplayConfig;
  states: ConversationState[];
}

interface SaveAsExampleRequest {
  conversation_id: string;
  title: string;
  description?: string;
  tags?: string[];
  category?: string;
  replay_config?: ReplayConfig;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const handler = createHandler(async (req) => {
  // Determine sub-route
  const segments = req.pathSegments;
  const replayIdx = segments.indexOf('replay');
  const action = replayIdx !== -1 ? segments[replayIdx + 1] || null : null;

  switch (req.method) {
    case 'GET': {
      const conversationId = req.searchParams.get('conversation_id');
      if (!conversationId) {
        return errorResponse('conversation_id query parameter required', 400, req.origin);
      }
      return await generateReplay(conversationId, req.origin);
    }

    case 'POST': {
      const unauthorized = await requireMigrationAdmin(req);
      if (unauthorized) return unauthorized;
      if (action === 'save-as-example') {
        const body = req.body as SaveAsExampleRequest;
        return await saveAsExample(body, req.origin);
      }
      return errorResponse('Unknown action', 400, req.origin);
    }

    default:
      return errorResponse('Method not allowed', 405, req.origin);
  }
});

// ─── Route Handlers ─────────────────────────────────────────────────────────

/**
 * Generate full replay data for a conversation.
 */
async function generateReplay(
  conversationId: string,
  origin: string | null,
) {
  // Fetch conversation
  const conversation = await queryOne(
    `SELECT * FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [conversationId],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  // Generate replay states
  const states = await generateReplayStates(conversationId);

  const replayConfig: ReplayConfig = {
    autoAdvance: false,
    delayMs: 2000,
    showTypewriter: true,
    highlightToolCalls: true,
  };

  const replay: ConversationReplay = {
    conversation_id: conversationId,
    title: conversation.title,
    description: null,
    created_at: conversation.created_at,
    replay_config: replayConfig,
    states,
  };

  return jsonResponse(replay, 200, origin);
}

/**
 * Save a conversation as an example with generated replay states.
 */
async function saveAsExample(
  body: SaveAsExampleRequest,
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
    `SELECT * FROM ${TABLES.CONVERSATIONS} WHERE id = $1`,
    [body.conversation_id],
  );

  if (!conversation) {
    return errorResponse('Conversation not found', 404, origin);
  }

  // Generate replay states
  const states = await generateReplayStates(body.conversation_id);

  // Prepare replay config
  const replayConfig: ReplayConfig = body.replay_config || {
    autoAdvance: false,
    delayMs: 2000,
    showTypewriter: true,
    highlightToolCalls: true,
  };

  // Create the chat example
  const example = await queryOne(
    `INSERT INTO ${TABLES.CHAT_EXAMPLES}
       (conversation_id, title, description, tags, category, replay_config, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING *`,
    [
      body.conversation_id,
      body.title,
      body.description || null,
      JSON.stringify(body.tags || []),
      body.category || 'general',
      JSON.stringify(replayConfig),
    ],
  );

  if (!example) {
    return errorResponse('Error creating chat example', 500, origin);
  }

  // Store states
  if (states.length > 0) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const state of states) {
      placeholders.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
      );
      values.push(
        body.conversation_id,
        example.id,
        state.sequence_number,
        JSON.stringify({ message: state.message, ...state.state_snapshot }),
        JSON.stringify(state.ui_hints),
        state.ui_hints.show_providers,
        state.ui_hints.show_addresses,
        state.ui_hints.map_action,
      );
    }

    await query(
      `INSERT INTO ${TABLES.CONVERSATION_STATES}
         (conversation_id, example_id, sequence_number, state_snapshot, ui_hints, show_providers, show_addresses, map_action)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  // Return the example with states
  const result = {
    ...sanitizeRecord(example),
    states,
  };

  return jsonResponse(result, 201, origin);
}

// ─── Replay State Generation ────────────────────────────────────────────────

/**
 * Generate replay states from conversation history and tool calls.
 * This mirrors the logic from the Python replay_service.
 */
async function generateReplayStates(
  conversationId: string,
): Promise<ConversationState[]> {
  // Fetch messages
  const messages = await queryRows(
    `SELECT * FROM ${TABLES.MESSAGES} WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId],
  );

  if (messages.length === 0) {
    return [];
  }

  // Fetch tool calls in parallel
  const [findProvidersCalls, searchAddressesCalls, getProviderInfoCalls, generalQuestionCalls] =
    await Promise.all([
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
      queryRows(
        `SELECT * FROM ${TABLES.GENERAL_QUESTION_CALLS} WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [conversationId],
      ),
    ]);

  // Build tool calls timeline
  interface ToolCallEntry {
    type: string;
    id: string;
    created_at: string;
    data: Record<string, unknown>;
  }

  const toolCalls: ToolCallEntry[] = [];

  for (const call of findProvidersCalls) {
    toolCalls.push({ type: 'find_providers', id: call.id, created_at: call.created_at, data: call });
  }
  for (const call of searchAddressesCalls) {
    toolCalls.push({ type: 'search_addresses', id: call.id, created_at: call.created_at, data: call });
  }
  for (const call of getProviderInfoCalls) {
    toolCalls.push({ type: 'get_provider_info', id: call.id, created_at: call.created_at, data: call });
  }
  for (const call of generalQuestionCalls) {
    toolCalls.push({ type: 'general_question', id: call.id, created_at: call.created_at, data: call });
  }

  // Sort by created_at
  toolCalls.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Build states
  const states: ConversationState[] = [];

  const cumulativeState: StateSnapshot = {
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

    // Get tool calls up to this message
    const applicableCalls = toolCalls.filter(
      (call) => call.created_at <= messageTime && !processedToolCalls.has(call.id),
    );

    // Apply tool calls to state
    for (const call of applicableCalls) {
      if (call.type === 'find_providers') {
        const data = call.data as Record<string, unknown>;
        const providerData = (data.provider_data || {}) as Record<string, unknown>;
        const providers = Array.isArray(providerData)
          ? providerData
          : (providerData.data as Array<Record<string, unknown>>) || [];

        cumulativeState.providers = providers;

        if (data.source_address) {
          cumulativeState.source_address = data.source_address as string;
        }
        if (data.destination_address) {
          cumulativeState.destination_address = data.destination_address as string;
        }
        if (data.public_transit_data) {
          cumulativeState.public_transit = data.public_transit_data as Record<string, unknown>;
        }

        // Extract origin/destination coordinates if available
        if (providerData.origin) {
          cumulativeState.origin = providerData.origin as Record<string, unknown>;
        }
        if (providerData.destination) {
          cumulativeState.destination = providerData.destination as Record<string, unknown>;
        }

        // Fall back to coordinates produced by the tool, if present.
        const sourceCoords = providerData.source_coordinates as Record<string, unknown> | undefined;
        const destCoords = providerData.destination_coordinates as Record<string, unknown> | undefined;
        if (!cumulativeState.origin && sourceCoords?.lat !== undefined && sourceCoords?.lng !== undefined) {
          cumulativeState.origin = { lat: sourceCoords.lat, lon: sourceCoords.lng } as Record<string, unknown>;
        }
        if (!cumulativeState.destination && destCoords?.lat !== undefined && destCoords?.lng !== undefined) {
          cumulativeState.destination = { lat: destCoords.lat, lon: destCoords.lng } as Record<string, unknown>;
        }

        // Extract service zones
        const serviceZones: Array<Record<string, unknown>> = [];
        for (const provider of providers) {
          if (provider && typeof provider === 'object' && provider.service_zone) {
            serviceZones.push({
              provider_id: provider.id || provider.provider_id,
              provider_name: provider.name || provider.provider_name,
              service_zone: provider.service_zone,
            });
          }
        }
        cumulativeState.service_zones = serviceZones;
      } else if (call.type === 'search_addresses') {
        const data = call.data as Record<string, unknown>;
        const placesData = (data.places_data || {}) as Record<string, unknown>;
        const places = Array.isArray(placesData)
          ? placesData
          : (placesData.places as Array<Record<string, unknown>>) || [];

        for (const place of places) {
          if (
            place &&
            !cumulativeState.addresses.find((a) => JSON.stringify(a) === JSON.stringify(place))
          ) {
            cumulativeState.addresses.push(place);
          }
        }
      } else if (call.type === 'get_provider_info') {
        const data = call.data as Record<string, unknown>;
        const providerId = data.provider_id;
        const providerInfo = data.provider_info;
        if (providerId && providerInfo) {
          cumulativeState.provider_details[String(providerId)] = providerInfo as Record<string, unknown>;
        }
      }
      // general_question: Web search results exposed via attachments / ui_hints.
    }

    // Compute UI hints
    const role = message.role;
    const uiHints: UIHints = {
      show_providers: false,
      show_addresses: false,
      map_action: null,
      highlight_tool: null,
      new_data: {},
    };

    // Check for new tool calls
    const newFindProviders = applicableCalls.some((c) => c.type === 'find_providers');
    const newSearchAddresses = applicableCalls.some((c) => c.type === 'search_addresses');
    const newGetProviderInfo = applicableCalls.some((c) => c.type === 'get_provider_info');
    const newGeneralQuestion = applicableCalls.some((c) => c.type === 'general_question');

    if (role === 'assistant' || role === 'ai') {
      if (newFindProviders) {
        uiHints.show_providers = true;
        uiHints.highlight_tool = 'find_providers';
        uiHints.map_action = 'showServiceZones';

        for (const call of applicableCalls) {
          if (call.type === 'find_providers') {
            const data = call.data as Record<string, unknown>;
            const providerData = (data.provider_data || {}) as Record<string, unknown>;
            const providers = Array.isArray(providerData)
              ? providerData
              : (providerData.data as Array<Record<string, unknown>>) || [];

            uiHints.new_data.providers = providers;
            uiHints.new_data.source_address = data.source_address;
            uiHints.new_data.destination_address = data.destination_address;
            uiHints.new_data.origin = providerData.origin;
            uiHints.new_data.destination = providerData.destination;
            uiHints.new_data.public_transit = data.public_transit_data;
          }
        }
      }

      if (newSearchAddresses) {
        uiHints.show_addresses = true;
        if (!uiHints.highlight_tool) uiHints.highlight_tool = 'search_addresses';
        if (!uiHints.map_action) uiHints.map_action = 'addPings';

        for (const call of applicableCalls) {
          if (call.type === 'search_addresses') {
            const data = call.data as Record<string, unknown>;
            const placesData = (data.places_data || {}) as Record<string, unknown>;
            const places = Array.isArray(placesData)
              ? placesData
              : (placesData.places as Array<Record<string, unknown>>) || [];
            uiHints.new_data.addresses = places;
          }
        }
      }

      if (newGetProviderInfo) {
        if (!uiHints.highlight_tool) uiHints.highlight_tool = 'get_provider_info';

        for (const call of applicableCalls) {
          if (call.type === 'get_provider_info') {
            const data = call.data as Record<string, unknown>;
            uiHints.new_data.provider_info = data.provider_info;
          }
        }
      }

      if (newGeneralQuestion) {
        if (!uiHints.highlight_tool) uiHints.highlight_tool = 'general_provider_question';

        for (const call of applicableCalls) {
          if (call.type === 'general_question') {
            const data = call.data as Record<string, unknown>;
            uiHints.new_data.web_search = {
              query: data.question,
              answer: (data.search_results as Record<string, unknown> | null)?.answer ?? null,
              sources: data.sources ?? [],
            };
          }
        }
      }
    }

    // Determine map focus based on addresses
    if (cumulativeState.source_address && cumulativeState.destination_address) {
      if (!uiHints.map_action) {
        uiHints.map_action = 'focus';
      }
    }

    // Mark calls as processed
    for (const call of applicableCalls) {
      processedToolCalls.add(call.id);
    }

    // Build attachments
    const attachments: Array<Record<string, unknown>> = [];
    if (role === 'assistant' || role === 'ai') {
      for (const call of applicableCalls) {
        const data = call.data as Record<string, unknown>;

        if (call.type === 'find_providers' && data.provider_data) {
          attachments.push({
            type: 'provider_search',
            data: data.provider_data,
            metadata: { tool_name: 'find_providers' },
          });
        }

        if (call.type === 'search_addresses' && data.places_data) {
          attachments.push({
            type: 'address_search',
            data: data.places_data,
            metadata: { tool_name: 'search_addresses_from_user_query' },
          });
        }

        if (call.type === 'get_provider_info' && data.provider_info) {
          attachments.push({
            type: 'provider_info',
            data: data.provider_info,
            metadata: { tool_name: 'get_provider_info', provider_id: data.provider_id ?? null },
          });
        }

        if (call.type === 'general_question') {
          attachments.push({
            type: 'web_search',
            data: {
              query: data.question,
              answer: (data.search_results as Record<string, unknown> | null)?.answer ?? null,
              sources: data.sources ?? [],
            },
            metadata: { tool_name: 'general_provider_question' },
          });
        }
      }
    }

    // Create state
    states.push({
      sequence_number: idx + 1,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        created_at: message.created_at,
      },
      state_snapshot: {
        providers: [...cumulativeState.providers],
        addresses: [...cumulativeState.addresses],
        source_address: cumulativeState.source_address,
        destination_address: cumulativeState.destination_address,
        origin: cumulativeState.origin,
        destination: cumulativeState.destination,
        public_transit: cumulativeState.public_transit,
        provider_details: { ...cumulativeState.provider_details },
        service_zones: [...cumulativeState.service_zones],
      },
      ui_hints: uiHints,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  return states;
}
