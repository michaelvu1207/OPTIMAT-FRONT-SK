/**
 * Messages API Edge Function for OPTIMAT
 * Provides CRUD operations for chat messages within conversations.
 *
 * Routes:
 * - GET /?conversation_id=:id - List messages for a conversation
 * - POST / - Create a new message
 * - GET /:id - Get a specific message
 * - DELETE /:id - Delete a message
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
interface CreateMessageRequest {
  conversation_id: string;
  role: "user" | "assistant" | "system" | "ai" | "human";
  content: string;
  attachments?: Record<string, unknown>[];
}

interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  attachments?: Record<string, unknown>[] | null;
  created_at: string;
}

// Parse URL path to extract message ID
function parseUrlPath(
  url: string,
): { messageId: string | null; conversationId: string | null } {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  const conversationId = urlObj.searchParams.get("conversation_id");

  // Look for messages/:id pattern
  const idx = pathParts.findIndex((p) => p === "messages");
  if (idx !== -1 && pathParts[idx + 1]) {
    const potentialId = pathParts[idx + 1];
    // Check if it looks like a UUID
    if (/^[0-9a-f-]{36}$/i.test(potentialId)) {
      return { messageId: potentialId, conversationId };
    }
  }

  // Check if last part looks like a UUID
  const lastPart = pathParts[pathParts.length - 1];
  if (
    lastPart && /^[0-9a-f-]{36}$/i.test(lastPart) && lastPart !== "messages"
  ) {
    return { messageId: lastPart, conversationId };
  }

  return { messageId: null, conversationId };
}

// Normalize role to standard format
function normalizeRole(role: string): string {
  const roleMap: Record<string, string> = {
    human: "user",
    ai: "assistant",
    system: "system",
    user: "user",
    assistant: "assistant",
  };
  return roleMap[role.toLowerCase()] || role;
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
    const { messageId, conversationId } = parseUrlPath(req.url);

    // Route handlers
    switch (req.method) {
      case "GET": {
        if (messageId) {
          // GET /:id - Get a specific message
          return await getMessage(supabase, messageId, origin);
        } else if (conversationId) {
          // GET /?conversation_id=:id - List messages for a conversation
          return await listMessages(supabase, conversationId, req, origin);
        } else {
          return errorResponse(
            "conversation_id query parameter required",
            400,
            origin,
          );
        }
      }

      case "POST": {
        // POST / - Create a new message
        if (messageId) {
          return errorResponse(
            "Cannot POST to a specific message ID",
            400,
            origin,
          );
        }
        const body: CreateMessageRequest = await req.json();
        return await createMessage(supabase, body, origin);
      }

      case "DELETE": {
        const unauthorized = requireMigrationAdmin(req, origin);
        if (unauthorized) return unauthorized;
        // DELETE /:id - Delete a message
        if (!messageId) {
          return errorResponse("Message ID required", 400, origin);
        }
        return await deleteMessage(supabase, messageId, origin);
      }

      default:
        return errorResponse("Method not allowed", 405, origin);
    }
  } catch (error) {
    console.error("Messages error:", error);
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
 * List all messages for a conversation.
 */
async function listMessages(
  supabase: ReturnType<typeof createOptimatClient>,
  conversationId: string,
  req: Request,
  origin: string | null,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  // First verify the conversation exists
  const { data: conversation, error: convError } = await supabase
    .from(TABLES.CONVERSATIONS)
    .select("id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return errorResponse("Conversation not found", 404, origin);
  }

  // Fetch messages
  const { data, error, count } = await supabase
    .from(TABLES.MESSAGES)
    .select("*", { count: "exact" })
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Error listing messages:", error);
    return errorResponse("Error listing messages", 500, origin);
  }

  const messages = (data || []).map((msg) => sanitizeRecord(msg));

  return jsonResponse(
    {
      messages,
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
 * Get a specific message by ID.
 */
async function getMessage(
  supabase: ReturnType<typeof createOptimatClient>,
  messageId: string,
  origin: string | null,
): Promise<Response> {
  const { data: message, error } = await supabase
    .from(TABLES.MESSAGES)
    .select("*")
    .eq("id", messageId)
    .single();

  if (error || !message) {
    return errorResponse("Message not found", 404, origin);
  }

  return jsonResponse(sanitizeRecord(message), 200, origin);
}

/**
 * Create a new message in a conversation.
 */
async function createMessage(
  supabase: ReturnType<typeof createOptimatClient>,
  body: CreateMessageRequest,
  origin: string | null,
): Promise<Response> {
  if (!body.conversation_id) {
    return errorResponse("conversation_id is required", 400, origin);
  }

  if (!body.role) {
    return errorResponse("role is required", 400, origin);
  }

  if (!body.content) {
    return errorResponse("content is required", 400, origin);
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

  // Normalize role
  const normalizedRole = normalizeRole(body.role);

  // Create message
  const { data, error } = await supabase
    .from(TABLES.MESSAGES)
    .insert({
      conversation_id: body.conversation_id,
      role: normalizedRole,
      content: body.content,
      attachments: body.attachments || null,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating message:", error);
    return errorResponse("Error creating message", 500, origin);
  }

  // Update conversation's updated_at
  await supabase
    .from(TABLES.CONVERSATIONS)
    .update({ updated_at: new Date().toISOString() })
    .eq("id", body.conversation_id);

  return jsonResponse(sanitizeRecord(data), 201, origin);
}

/**
 * Delete a message.
 */
async function deleteMessage(
  supabase: ReturnType<typeof createOptimatClient>,
  messageId: string,
  origin: string | null,
): Promise<Response> {
  // Get message first to find conversation_id
  const { data: message, error: fetchError } = await supabase
    .from(TABLES.MESSAGES)
    .select("conversation_id")
    .eq("id", messageId)
    .single();

  if (fetchError || !message) {
    return errorResponse("Message not found", 404, origin);
  }

  // Delete the message
  const { error } = await supabase
    .from(TABLES.MESSAGES)
    .delete()
    .eq("id", messageId);

  if (error) {
    console.error("Error deleting message:", error);
    return errorResponse("Error deleting message", 500, origin);
  }

  // Update conversation's updated_at
  await supabase
    .from(TABLES.CONVERSATIONS)
    .update({ updated_at: new Date().toISOString() })
    .eq("id", message.conversation_id);

  return jsonResponse({ success: true, deleted: messageId }, 200, origin);
}
