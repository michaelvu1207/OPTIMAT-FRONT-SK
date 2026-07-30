/**
 * Replay API Edge Function for OPTIMAT
 * Generates replay data for conversation visualization.
 *
 * Routes:
 * - GET /?conversation_id=:id - Generate replay data for a conversation
 * - POST /save-as-example - Save a conversation as an example with generated states
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

// Parse URL path
function parseUrlPath(url: string): { action: string | null } {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/").filter(Boolean);

  // Look for /replay/action pattern
  const idx = pathParts.findIndex((p) => p === "replay");
  if (idx !== -1 && pathParts[idx + 1]) {
    return { action: pathParts[idx + 1] };
  }

  // Also check if last part is an action
  const lastPart = pathParts[pathParts.length - 1];
  if (lastPart && lastPart !== "replay") {
    return { action: lastPart };
  }

  return { action: null };
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

    const url = new URL(req.url);
    const { action } = parseUrlPath(req.url);

    switch (req.method) {
      case "GET": {
        const conversationId = url.searchParams.get("conversation_id");
        if (!conversationId) {
          return errorResponse(
            "conversation_id query parameter required",
            400,
            origin,
          );
        }
        return await generateReplay(supabase, conversationId, origin);
      }

      case "POST": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        if (action === "save-as-example") {
          const body: SaveAsExampleRequest = await req.json();
          return await saveAsExample(supabase, body, origin);
        }
        return errorResponse("Unknown action", 400, origin);
      }

      default:
        return errorResponse("Method not allowed", 405, origin);
    }
  } catch (error) {
    console.error("Replay error:", error);
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
 * Generate full replay data for a conversation.
 */
async function generateReplay(
  supabase: ReturnType<typeof createOptimatClient>,
  conversationId: string,
  origin: string | null,
): Promise<Response> {
  // Fetch conversation
  const { data: conversation, error: convError } = await supabase
    .from(TABLES.CONVERSATIONS)
    .select("*")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return errorResponse("Conversation not found", 404, origin);
  }

  // Generate replay states
  const states = await generateReplayStates(supabase, conversationId);

  // Build default replay config
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
  supabase: ReturnType<typeof createOptimatClient>,
  body: SaveAsExampleRequest,
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
    .select("*")
    .eq("id", body.conversation_id)
    .single();

  if (convError || !conversation) {
    return errorResponse("Conversation not found", 404, origin);
  }

  // Generate replay states
  const states = await generateReplayStates(supabase, body.conversation_id);

  // Prepare replay config
  const replayConfig: ReplayConfig = body.replay_config || {
    autoAdvance: false,
    delayMs: 2000,
    showTypewriter: true,
    highlightToolCalls: true,
  };

  // Create the chat example
  const { data: example, error: exError } = await supabase
    .from(TABLES.CHAT_EXAMPLES)
    .insert({
      conversation_id: body.conversation_id,
      title: body.title,
      description: body.description || null,
      tags: body.tags || [],
      category: body.category || "general",
      replay_config: replayConfig,
      is_active: true,
    })
    .select()
    .single();

  if (exError || !example) {
    console.error("Error creating chat example:", exError);
    return errorResponse("Error creating chat example", 500, origin);
  }

  // Store states
  if (states.length > 0) {
    const stateInserts = states.map((state) => ({
      conversation_id: body.conversation_id,
      example_id: example.id,
      sequence_number: state.sequence_number,
      state_snapshot: {
        message: state.message,
        ...state.state_snapshot,
      },
      ui_hints: state.ui_hints,
      show_providers: state.ui_hints.show_providers,
      show_addresses: state.ui_hints.show_addresses,
      map_action: state.ui_hints.map_action,
    }));

    const { error: statesError } = await supabase
      .from(TABLES.CONVERSATION_STATES)
      .insert(stateInserts);

    if (statesError) {
      console.error("Error inserting states:", statesError);
      // Don't fail the whole operation, just log the error
    }
  }

  // Return the example with states
  const result = {
    ...sanitizeRecord(example),
    states,
  };

  return jsonResponse(result, 201, origin);
}

/**
 * Generate replay states from conversation history and tool calls.
 * This mirrors the logic from the Python replay_service.
 */
async function generateReplayStates(
  supabase: ReturnType<typeof createOptimatClient>,
  conversationId: string,
): Promise<ConversationState[]> {
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

  const { data: generalQuestionCalls } = await supabase
    .from(TABLES.GENERAL_QUESTION_CALLS)
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  // Build tool calls timeline
  interface ToolCallEntry {
    type: string;
    id: string;
    created_at: string;
    data: Record<string, unknown>;
  }

  const toolCalls: ToolCallEntry[] = [];

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

  for (const call of generalQuestionCalls || []) {
    toolCalls.push({
      type: "general_question",
      id: call.id,
      created_at: call.created_at,
      data: call,
    });
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
      (call) =>
        call.created_at <= messageTime && !processedToolCalls.has(call.id),
    );

    // Apply tool calls to state
    for (const call of applicableCalls) {
      if (call.type === "find_providers") {
        const data = call.data as Record<string, unknown>;
        const providerData = (data.provider_data || {}) as Record<
          string,
          unknown
        >;
        const providers = Array.isArray(providerData)
          ? providerData
          : (providerData.data as Array<Record<string, unknown>>) || [];

        cumulativeState.providers = providers;

        if (data.source_address) {
          cumulativeState.source_address = data.source_address as string;
        }
        if (data.destination_address) {
          cumulativeState.destination_address = data
            .destination_address as string;
        }
        if (data.public_transit_data) {
          cumulativeState.public_transit = data.public_transit_data as Record<
            string,
            unknown
          >;
        }

        // Extract origin/destination coordinates if available
        if (providerData.origin) {
          cumulativeState.origin = providerData.origin as Record<
            string,
            unknown
          >;
        }
        if (providerData.destination) {
          cumulativeState.destination = providerData.destination as Record<
            string,
            unknown
          >;
        }

        // Fall back to coordinates produced by the tool, if present.
        const sourceCoords = providerData.source_coordinates as
          | Record<string, unknown>
          | undefined;
        const destCoords = providerData.destination_coordinates as
          | Record<string, unknown>
          | undefined;
        if (
          !cumulativeState.origin && sourceCoords?.lat !== undefined &&
          sourceCoords?.lng !== undefined
        ) {
          cumulativeState.origin = {
            lat: sourceCoords.lat,
            lon: sourceCoords.lng,
          } as Record<string, unknown>;
        }
        if (
          !cumulativeState.destination && destCoords?.lat !== undefined &&
          destCoords?.lng !== undefined
        ) {
          cumulativeState.destination = {
            lat: destCoords.lat,
            lon: destCoords.lng,
          } as Record<string, unknown>;
        }

        // Extract service zones
        const serviceZones: Array<Record<string, unknown>> = [];
        for (const provider of providers) {
          if (
            provider && typeof provider === "object" && provider.service_zone
          ) {
            serviceZones.push({
              provider_id: provider.id || provider.provider_id,
              provider_name: provider.name || provider.provider_name,
              service_zone: provider.service_zone,
            });
          }
        }
        cumulativeState.service_zones = serviceZones;
      } else if (call.type === "search_addresses") {
        const data = call.data as Record<string, unknown>;
        const placesData = (data.places_data || {}) as Record<string, unknown>;
        const places = Array.isArray(placesData)
          ? placesData
          : (placesData.places as Array<Record<string, unknown>>) || [];

        for (const place of places) {
          if (
            place &&
            !cumulativeState.addresses.find((a) =>
              JSON.stringify(a) === JSON.stringify(place)
            )
          ) {
            cumulativeState.addresses.push(place);
          }
        }
      } else if (call.type === "get_provider_info") {
        const data = call.data as Record<string, unknown>;
        const providerId = data.provider_id;
        const providerInfo = data.provider_info;
        if (providerId && providerInfo) {
          cumulativeState.provider_details[String(providerId)] =
            providerInfo as Record<
              string,
              unknown
            >;
        }
      } else if (call.type === "general_question") {
        // Web search results are exposed via attachments / ui_hints on the specific message state.
      }
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
    const newFindProviders = applicableCalls.some((c) =>
      c.type === "find_providers"
    );
    const newSearchAddresses = applicableCalls.some((c) =>
      c.type === "search_addresses"
    );
    const newGetProviderInfo = applicableCalls.some((c) =>
      c.type === "get_provider_info"
    );
    const newGeneralQuestion = applicableCalls.some((c) =>
      c.type === "general_question"
    );

    if (role === "assistant" || role === "ai") {
      if (newFindProviders) {
        uiHints.show_providers = true;
        uiHints.highlight_tool = "find_providers";
        uiHints.map_action = "showServiceZones";

        // Add new provider data to hints
        for (const call of applicableCalls) {
          if (call.type === "find_providers") {
            const data = call.data as Record<string, unknown>;
            const providerData = (data.provider_data || {}) as Record<
              string,
              unknown
            >;
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
        if (!uiHints.highlight_tool) {
          uiHints.highlight_tool = "search_addresses";
        }
        if (!uiHints.map_action) uiHints.map_action = "addPings";

        // Add new address data to hints
        for (const call of applicableCalls) {
          if (call.type === "search_addresses") {
            const data = call.data as Record<string, unknown>;
            const placesData = (data.places_data || {}) as Record<
              string,
              unknown
            >;
            const places = Array.isArray(placesData)
              ? placesData
              : (placesData.places as Array<Record<string, unknown>>) || [];
            uiHints.new_data.addresses = places;
          }
        }
      }

      if (newGetProviderInfo) {
        if (!uiHints.highlight_tool) {
          uiHints.highlight_tool = "get_provider_info";
        }

        for (const call of applicableCalls) {
          if (call.type === "get_provider_info") {
            const data = call.data as Record<string, unknown>;
            uiHints.new_data.provider_info = data.provider_info;
          }
        }
      }

      if (newGeneralQuestion) {
        if (!uiHints.highlight_tool) {
          uiHints.highlight_tool = "general_provider_question";
        }

        for (const call of applicableCalls) {
          if (call.type === "general_question") {
            const data = call.data as Record<string, unknown>;
            uiHints.new_data.web_search = {
              query: data.question,
              answer: (data.search_results as Record<string, unknown> | null)
                ?.answer ?? null,
              sources: data.sources ?? [],
            };
          }
        }
      }
    }

    // Determine map focus based on addresses
    if (cumulativeState.source_address && cumulativeState.destination_address) {
      if (!uiHints.map_action) {
        uiHints.map_action = "focus";
      }
    }

    // Mark calls as processed
    for (const call of applicableCalls) {
      processedToolCalls.add(call.id);
    }

    const attachments: Array<Record<string, unknown>> = [];
    if (role === "assistant" || role === "ai") {
      for (const call of applicableCalls) {
        const data = call.data as Record<string, unknown>;

        if (call.type === "find_providers" && data.provider_data) {
          attachments.push({
            type: "provider_search",
            data: data.provider_data,
            metadata: { tool_name: "find_providers" },
          });
        }

        if (call.type === "search_addresses" && data.places_data) {
          attachments.push({
            type: "address_search",
            data: data.places_data,
            metadata: { tool_name: "search_addresses_from_user_query" },
          });
        }

        if (call.type === "get_provider_info" && data.provider_info) {
          attachments.push({
            type: "provider_info",
            data: data.provider_info,
            metadata: {
              tool_name: "get_provider_info",
              provider_id: data.provider_id ?? null,
            },
          });
        }

        if (call.type === "general_question") {
          attachments.push({
            type: "web_search",
            data: {
              query: data.question,
              answer: (data.search_results as Record<string, unknown> | null)
                ?.answer ?? null,
              sources: data.sources ?? [],
            },
            metadata: { tool_name: "general_provider_question" },
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
