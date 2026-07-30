/**
 * Chat Examples API Edge Function for OPTIMAT
 * Provides CRUD operations for chat example conversations.
 *
 * Routes:
 * - GET / - List all chat examples
 * - POST / - Create a new chat example from a conversation
 * - GET /:id - Get a specific chat example
 * - GET /:id/with-states - Get a chat example with replay states
 * - PUT /:id - Update a chat example
 * - DELETE /:id - Delete a chat example
 * - POST /:id/regenerate-states - Regenerate replay states for an example
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  errorResponse,
  handleCorsPreflightRequest,
  jsonResponse,
} from "../_shared/cors.ts";
import { requireMigrationAdmin } from "../_shared/admin.ts";
import {
  createOptimatClient,
  sanitizeRecord,
  TABLES,
} from "../_shared/supabase.ts";

// Types
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

interface ChatExample {
  id: string;
  conversation_id: string;
  title: string | null;
  description: string | null;
  tags: string[];
  category: string;
  is_active: boolean;
  replay_config: ReplayConfig | null;
  created_at: string;
  updated_at: string | null;
}

// Parse URL path to extract example ID and action
function parseUrlPath(
  url: string,
): { exampleId: string | null; action: string | null } {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/").filter(Boolean);

  // Look for chat-examples/:id pattern
  const idx = pathParts.findIndex((p) => p === "chat-examples");
  if (idx !== -1) {
    const potentialId = pathParts[idx + 1];
    const action = pathParts[idx + 2] || null;

    // Check if it looks like a UUID
    if (potentialId && /^[0-9a-f-]{36}$/i.test(potentialId)) {
      return { exampleId: potentialId, action };
    }
  }

  // Check if last or second-to-last part looks like a UUID
  const lastPart = pathParts[pathParts.length - 1];
  const secondToLast = pathParts[pathParts.length - 2];

  if (lastPart && /^[0-9a-f-]{36}$/i.test(lastPart)) {
    return { exampleId: lastPart, action: null };
  }

  if (secondToLast && /^[0-9a-f-]{36}$/i.test(secondToLast)) {
    return { exampleId: secondToLast, action: lastPart };
  }

  return { exampleId: null, action: null };
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  try {
    // Initialize Supabase client with optimat schema
    const supabase = createOptimatClient();

    // Parse the URL
    const { exampleId, action } = parseUrlPath(req.url);

    // Route handlers
    switch (req.method) {
      case "GET": {
        if (exampleId) {
          if (action === "with-states") {
            // GET /:id/with-states - Get example with states
            return await getExampleWithStates(supabase, exampleId, origin);
          }
          // GET /:id - Get a specific example
          return await getExample(supabase, exampleId, origin);
        } else {
          // GET / - List all examples
          return await listExamples(supabase, req, origin);
        }
      }

      case "POST": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        if (exampleId && action === "regenerate-states") {
          // POST /:id/regenerate-states
          return await regenerateStates(supabase, exampleId, origin);
        }
        if (exampleId) {
          return errorResponse(
            "Cannot POST to a specific example ID",
            400,
            origin,
          );
        }
        // POST / - Create a new example
        const body: CreateExampleRequest = await req.json();
        return await createExample(supabase, body, origin);
      }

      case "PUT": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        // PUT /:id - Update an example
        if (!exampleId) {
          return errorResponse("Example ID required", 400, origin);
        }
        const body: UpdateExampleRequest = await req.json();
        return await updateExample(supabase, exampleId, body, origin);
      }

      case "DELETE": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        // DELETE /:id - Delete an example
        if (!exampleId) {
          return errorResponse("Example ID required", 400, origin);
        }
        return await deleteExample(supabase, exampleId, origin);
      }

      default:
        return errorResponse("Method not allowed", 405, origin);
    }
  } catch (error) {
    console.error("Chat examples error:", error);
    return errorResponse(
      `Internal server error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      500,
      origin,
    );
  }
});

/**
 * List all chat examples, optionally filtered by active status.
 */
async function listExamples(
  supabase: ReturnType<typeof createOptimatClient>,
  req: Request,
  origin: string | null,
): Promise<Response> {
  const url = new URL(req.url);
  const isActive = url.searchParams.get("is_active");
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  let query = supabase
    .from(TABLES.CHAT_EXAMPLES)
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (isActive !== null) {
    query = query.eq("is_active", isActive === "true");
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("Error listing chat examples:", error);
    return errorResponse("Error listing chat examples", 500, origin);
  }

  const examples = (data || []).map((ex) => sanitizeRecord(ex));

  return jsonResponse(
    {
      data: examples,
      pagination: {
        total: count || 0,
        limit,
        offset,
        has_more: (count || 0) > offset + limit,
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
  supabase: ReturnType<typeof createOptimatClient>,
  exampleId: string,
  origin: string | null,
): Promise<Response> {
  const { data: example, error } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .select("*")
    .eq("id", exampleId)
    .single();

  if (error || !example) {
    return errorResponse("Chat example not found", 404, origin);
  }

  return jsonResponse(sanitizeRecord(example), 200, origin);
}

/**
 * Get a chat example with its replay states.
 */
async function getExampleWithStates(
  supabase: ReturnType<typeof createOptimatClient>,
  exampleId: string,
  origin: string | null,
): Promise<Response> {
  // Fetch example
  const { data: example, error: exError } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .select("*")
    .eq("id", exampleId)
    .single();

  if (exError || !example) {
    return errorResponse("Chat example not found", 404, origin);
  }

  // Fetch states
  const { data: states, error: statesError } = await supabase
    .from(TABLES.CONVERSATION_STATES)
    .select("*")
    .eq("example_id", exampleId)
    .order("sequence_number", { ascending: true });

  if (statesError) {
    console.error("Error fetching states:", statesError);
    return errorResponse("Error fetching replay states", 500, origin);
  }

  // Format states
  const formattedStates = (states || []).map((state) => ({
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
  supabase: ReturnType<typeof createOptimatClient>,
  body: CreateExampleRequest,
  origin: string | null,
): Promise<Response> {
  if (!body.conversation_id) {
    return errorResponse("conversation_id is required", 400, origin);
  }

  if (!body.title) {
    return errorResponse("title is required", 400, origin);
  }

  // Verify conversation exists
  const { data: conversation, error: convError } = await supabase
    .from(TABLES.CONVERSATIONS)
    .select("id")
    .eq("id", body.conversation_id)
    .single();

  if (convError || !conversation) {
    return errorResponse("Conversation not found", 404, origin);
  }

  // Create example
  const { data, error } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .insert({
      conversation_id: body.conversation_id,
      title: body.title,
      description: body.description || null,
      tags: body.tags || [],
      category: body.category || "general",
      is_active: body.is_active !== false,
      replay_config: body.replay_config || null,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating chat example:", error);
    return errorResponse("Error creating chat example", 500, origin);
  }

  return jsonResponse(sanitizeRecord(data), 201, origin);
}

/**
 * Update a chat example.
 */
async function updateExample(
  supabase: ReturnType<typeof createOptimatClient>,
  exampleId: string,
  body: UpdateExampleRequest,
  origin: string | null,
): Promise<Response> {
  // Build update object
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.tags !== undefined) updates.tags = body.tags;
  if (body.category !== undefined) updates.category = body.category;
  if (body.is_active !== undefined) updates.is_active = body.is_active;
  if (body.replay_config !== undefined) {
    updates.replay_config = body.replay_config;
  }

  const { data, error } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .update(updates)
    .eq("id", exampleId)
    .select()
    .single();

  if (error) {
    console.error("Error updating chat example:", error);
    if (error.code === "PGRST116") {
      return errorResponse("Chat example not found", 404, origin);
    }
    return errorResponse("Error updating chat example", 500, origin);
  }

  return jsonResponse(sanitizeRecord(data), 200, origin);
}

/**
 * Delete a chat example and its associated states.
 */
async function deleteExample(
  supabase: ReturnType<typeof createOptimatClient>,
  exampleId: string,
  origin: string | null,
): Promise<Response> {
  // Delete associated conversation states first
  await supabase
    .from(TABLES.CONVERSATION_STATES)
    .delete()
    .eq("example_id", exampleId);

  // Delete the example
  const { error } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .delete()
    .eq("id", exampleId);

  if (error) {
    console.error("Error deleting chat example:", error);
    return errorResponse("Error deleting chat example", 500, origin);
  }

  return jsonResponse({ success: true, deleted: exampleId }, 200, origin);
}

/**
 * Regenerate replay states for an example from its source conversation.
 */
async function regenerateStates(
  supabase: ReturnType<typeof createOptimatClient>,
  exampleId: string,
  origin: string | null,
): Promise<Response> {
  // Fetch the example to get conversation_id
  const { data: example, error: exError } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .select("*")
    .eq("id", exampleId)
    .single();

  if (exError || !example) {
    return errorResponse("Chat example not found", 404, origin);
  }

  const conversationId = example.conversation_id;

  // Verify conversation still exists
  const { data: conversation, error: convError } = await supabase
    .from(TABLES.CONVERSATIONS)
    .select("id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return errorResponse("Source conversation no longer exists", 404, origin);
  }

  // Generate new states using the replay generation logic
  const states = await generateReplayStates(supabase, conversationId);

  // Delete existing states
  await supabase
    .from(TABLES.CONVERSATION_STATES)
    .delete()
    .eq("example_id", exampleId);

  // Insert new states
  if (states.length > 0) {
    const stateInserts = states.map((state) => ({
      conversation_id: conversationId,
      example_id: exampleId,
      sequence_number: state.sequence_number,
      state_snapshot: {
        message: state.message,
        ...state.state_snapshot,
      },
      ui_hints: state.ui_hints,
      show_providers: state.ui_hints?.show_providers || false,
      show_addresses: state.ui_hints?.show_addresses || false,
      map_action: state.ui_hints?.map_action || null,
    }));

    const { error: insertError } = await supabase
      .from(TABLES.CONVERSATION_STATES)
      .insert(stateInserts);

    if (insertError) {
      console.error("Error inserting states:", insertError);
      return errorResponse("Error regenerating states", 500, origin);
    }
  }

  // Return the updated example with states
  return await getExampleWithStates(supabase, exampleId, origin);
}

/**
 * Generate replay states from conversation history and tool calls.
 * This mirrors the logic from the Python replay_service.
 */
async function generateReplayStates(
  supabase: ReturnType<typeof createOptimatClient>,
  conversationId: string,
): Promise<
  Array<{
    sequence_number: number;
    message: Record<string, unknown>;
    state_snapshot: Record<string, unknown>;
    ui_hints: Record<string, unknown>;
  }>
> {
  // Fetch messages
  const { data: messages } = await supabase
    .from(TABLES.MESSAGES)
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (!messages || messages.length === 0) {
    return [];
  }

  // Fetch tool calls
  const { data: findProvidersCalls } = await supabase
    .from(TABLES.FIND_PROVIDERS_CALLS)
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const { data: searchAddressesCalls } = await supabase
    .from(TABLES.SEARCH_ADDRESSES_CALLS)
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const { data: getProviderInfoCalls } = await supabase
    .from(TABLES.GET_PROVIDER_INFO_CALLS)
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  // Build tool calls timeline
  const toolCalls: Array<{
    type: string;
    id: string;
    created_at: string;
    data: Record<string, unknown>;
  }> = [];

  for (const call of findProvidersCalls || []) {
    toolCalls.push({
      type: "find_providers",
      id: call.id,
      created_at: call.created_at,
      data: call,
    });
  }

  for (const call of searchAddressesCalls || []) {
    toolCalls.push({
      type: "search_addresses",
      id: call.id,
      created_at: call.created_at,
      data: call,
    });
  }

  for (const call of getProviderInfoCalls || []) {
    toolCalls.push({
      type: "get_provider_info",
      id: call.id,
      created_at: call.created_at,
      data: call,
    });
  }

  // Sort by created_at
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

    // Get tool calls up to this message
    const applicableCalls = toolCalls.filter(
      (call) =>
        call.created_at <= messageTime && !processedToolCalls.has(call.id),
    );

    // Apply tool calls to state
    for (const call of applicableCalls) {
      if (call.type === "find_providers") {
        const data = call.data;
        const providerData = data.provider_data || {};
        const providers = Array.isArray(providerData)
          ? providerData
          : providerData.data || [];

        cumulativeState.providers = providers;
        if (data.source_address) {
          cumulativeState.source_address = data.source_address;
        }
        if (data.destination_address) {
          cumulativeState.destination_address = data.destination_address;
        }
        if (data.public_transit_data) {
          cumulativeState.public_transit = data.public_transit_data;
        }

        // Extract origin/destination coordinates if available
        if (providerData.origin) cumulativeState.origin = providerData.origin;
        if (providerData.destination) {
          cumulativeState.destination = providerData.destination;
        }
      } else if (call.type === "search_addresses") {
        const placesData = call.data.places_data || {};
        const places = Array.isArray(placesData)
          ? placesData
          : placesData.places || [];
        const addresses = cumulativeState.addresses as Array<
          Record<string, unknown>
        >;
        for (const place of places) {
          if (
            !addresses.find((a) => JSON.stringify(a) === JSON.stringify(place))
          ) {
            addresses.push(place);
          }
        }
      } else if (call.type === "get_provider_info") {
        const providerId = call.data.provider_id;
        const providerInfo = call.data.provider_info;
        if (providerId && providerInfo) {
          (cumulativeState.provider_details as Record<string, unknown>)[
            String(providerId)
          ] = providerInfo;
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

    // Check for new tool calls
    const newFindProviders = applicableCalls.some((c) =>
      c.type === "find_providers"
    );
    const newSearchAddresses = applicableCalls.some((c) =>
      c.type === "search_addresses"
    );
    const newGetProviderInfo = applicableCalls.some((c) =>
      c.type === "get_provider_info"
    );

    if (role === "assistant" || role === "ai") {
      if (newFindProviders) {
        uiHints.show_providers = true;
        uiHints.highlight_tool = "find_providers";
        uiHints.map_action = "showServiceZones";
      }

      if (newSearchAddresses) {
        uiHints.show_addresses = true;
        if (!uiHints.highlight_tool) {
          uiHints.highlight_tool = "search_addresses";
        }
        if (!uiHints.map_action) uiHints.map_action = "addPings";
      }

      if (newGetProviderInfo) {
        if (!uiHints.highlight_tool) {
          uiHints.highlight_tool = "get_provider_info";
        }
      }
    }

    // Mark calls as processed
    for (const call of applicableCalls) {
      processedToolCalls.add(call.id);
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
