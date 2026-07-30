/**
 * Conversations API Edge Function for OPTIMAT
 * Provides CRUD operations for chat conversations.
 *
 * Routes:
 * - POST / - Create a new conversation
 * - GET / - List all conversations
 * - GET /:id - Get a conversation with its messages
 * - PUT /:id - Update a conversation
 * - DELETE /:id - Delete a conversation
 *
 * Note: All tables are in the 'optimat' schema.
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
interface CreateConversationRequest {
  title?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateConversationRequest {
  title?: string;
  metadata?: Record<string, unknown>;
}

interface Conversation {
  id: string;
  title: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

// Parse URL path to extract conversation ID
function parseUrlPath(url: string): { conversationId: string | null } {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/").filter(Boolean);

  // Remove 'conversations' from path if present
  const idx = pathParts.findIndex((p) => p === "conversations");
  if (idx !== -1 && pathParts[idx + 1]) {
    return { conversationId: pathParts[idx + 1] };
  }

  // Check if last part looks like a UUID
  const lastPart = pathParts[pathParts.length - 1];
  if (lastPart && /^[0-9a-f-]{36}$/i.test(lastPart)) {
    return { conversationId: lastPart };
  }

  return { conversationId: null };
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

    // Parse the URL to determine the route
    const { conversationId } = parseUrlPath(req.url);

    // Route handlers
    switch (req.method) {
      case "GET": {
        if (conversationId) {
          // GET /:id - Get a specific conversation with messages
          return await getConversation(supabase, conversationId, origin);
        } else {
          const unauthorized = requireMigrationAdmin(req, origin);
          if (unauthorized) return unauthorized;
          // GET / - List all conversations
          return await listConversations(supabase, req, origin);
        }
      }

      case "POST": {
        // POST / - Create a new conversation
        if (conversationId) {
          return errorResponse(
            "Cannot POST to a specific conversation ID",
            400,
            origin,
          );
        }
        const body: CreateConversationRequest = await req.json();
        return await createConversation(supabase, body, origin);
      }

      case "PUT": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        // PUT /:id - Update a conversation
        if (!conversationId) {
          return errorResponse("Conversation ID required", 400, origin);
        }
        const body: UpdateConversationRequest = await req.json();
        return await updateConversation(supabase, conversationId, body, origin);
      }

      case "DELETE": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        // DELETE /:id - Delete a conversation
        if (!conversationId) {
          return errorResponse("Conversation ID required", 400, origin);
        }
        return await deleteConversation(supabase, conversationId, origin);
      }

      default:
        return errorResponse("Method not allowed", 405, origin);
    }
  } catch (error) {
    console.error("Conversations error:", error);
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
 * List all conversations.
 */
async function listConversations(
  supabase: ReturnType<typeof createOptimatClient>,
  req: Request,
  origin: string | null,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const query = supabase
    .from(TABLES.CONVERSATIONS)
    .select("*", { count: "exact" })
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error("Error listing conversations:", error);
    return errorResponse("Error listing conversations", 500, origin);
  }

  const conversations = (data || []).map((conv) => sanitizeRecord(conv));

  return jsonResponse(
    {
      data: conversations,
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
 * Get a specific conversation with all its messages.
 */
async function getConversation(
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

  // Fetch messages
  const { data: messages, error: msgError } = await supabase
    .from(TABLES.MESSAGES)
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (msgError) {
    console.error("Error fetching messages:", msgError);
    return errorResponse("Error fetching messages", 500, origin);
  }

  const result: ConversationWithMessages = {
    ...sanitizeRecord(conversation),
    messages: (messages || []).map((msg) => sanitizeRecord(msg)),
  } as ConversationWithMessages;

  return jsonResponse(result, 200, origin);
}

/**
 * Create a new conversation.
 */
async function createConversation(
  supabase: ReturnType<typeof createOptimatClient>,
  body: CreateConversationRequest,
  origin: string | null,
): Promise<Response> {
  const title = body.title || "New Conversation";
  const metadata = body.metadata || null;

  const { data, error } = await supabase
    .from(TABLES.CONVERSATIONS)
    .insert({
      title,
      metadata,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating conversation:", error);
    return errorResponse("Error creating conversation", 500, origin);
  }

  // Add initial assistant greeting message
  const { error: msgError } = await supabase.from(TABLES.MESSAGES).insert({
    conversation_id: data.id,
    role: "assistant",
    content:
      "Hi! I'm here to help you find transportation services. How can I assist you today?",
  });

  if (msgError) {
    console.error("Error creating initial message:", msgError);
  }

  return jsonResponse(sanitizeRecord(data), 201, origin);
}

/**
 * Update a conversation.
 */
async function updateConversation(
  supabase: ReturnType<typeof createOptimatClient>,
  conversationId: string,
  body: UpdateConversationRequest,
  origin: string | null,
): Promise<Response> {
  // Build update object
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.title !== undefined) {
    updates.title = body.title;
  }

  if (body.metadata !== undefined) {
    updates.metadata = body.metadata;
  }

  const { data, error } = await supabase
    .from(TABLES.CONVERSATIONS)
    .update(updates)
    .eq("id", conversationId)
    .select()
    .single();

  if (error) {
    console.error("Error updating conversation:", error);
    if (error.code === "PGRST116") {
      return errorResponse("Conversation not found", 404, origin);
    }
    return errorResponse("Error updating conversation", 500, origin);
  }

  return jsonResponse(sanitizeRecord(data), 200, origin);
}

/**
 * Delete a conversation and all its messages.
 */
async function deleteConversation(
  supabase: ReturnType<typeof createOptimatClient>,
  conversationId: string,
  origin: string | null,
): Promise<Response> {
  // Delete related records first (foreign key constraints)

  // Delete messages
  const { error: msgError } = await supabase
    .from(TABLES.MESSAGES)
    .delete()
    .eq("conversation_id", conversationId);

  if (msgError) {
    console.error("Error deleting messages:", msgError);
    return errorResponse("Error deleting conversation messages", 500, origin);
  }

  // Delete tool call records
  await supabase.from(TABLES.FIND_PROVIDERS_CALLS).delete().eq(
    "conversation_id",
    conversationId,
  );
  await supabase.from(TABLES.SEARCH_ADDRESSES_CALLS).delete().eq(
    "conversation_id",
    conversationId,
  );
  await supabase.from(TABLES.GET_PROVIDER_INFO_CALLS).delete().eq(
    "conversation_id",
    conversationId,
  );

  // Delete conversation states
  await supabase.from(TABLES.CONVERSATION_STATES).delete().eq(
    "conversation_id",
    conversationId,
  );

  // Delete chat examples that reference this conversation
  await supabase.from(TABLES.CHAT_EXAMPLES).delete().eq(
    "conversation_id",
    conversationId,
  );

  // Delete the conversation
  const { error } = await supabase.from(TABLES.CONVERSATIONS).delete().eq(
    "id",
    conversationId,
  );

  if (error) {
    console.error("Error deleting conversation:", error);
    return errorResponse("Error deleting conversation", 500, origin);
  }

  return jsonResponse({ success: true, deleted: conversationId }, 200, origin);
}
