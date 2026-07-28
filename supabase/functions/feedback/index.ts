/**
 * Feedback API Edge Function for OPTIMAT.
 *
 * Collects tester feedback on a chat conversation.
 *
 * Routes:
 * - POST / - Submit feedback for a conversation
 *
 * The conversation is auto-saved with the submission: the client sends the transcript it rendered,
 * and anything missing is backfilled from optimat.messages so a submission is still useful when the
 * client sends nothing but a comment.
 *
 * There is deliberately no GET route. The anon key ships in the frontend bundle, so exposing a read
 * endpoint would publish every tester's name and comment. Reviewers read optimat.chat_feedback_review
 * from the dashboard or with the service role key.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
} from "../_shared/cors.ts";
import { createOptimatClient, sanitizeRecord, TABLES } from "../_shared/supabase.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Long enough for a detailed complaint, short enough that the table cannot be used as storage.
const MAX_COMMENT_LENGTH = 4000;
const MAX_NAME_LENGTH = 120;
const MAX_TRANSCRIPT_MESSAGES = 200;

interface TranscriptMessage {
  role?: string;
  content?: string;
  created_at?: string;
}

interface SubmitFeedbackRequest {
  conversation_id?: string | null;
  message_id?: string | null;
  name?: string | null;
  comment?: string;
  rating?: string | null;
  transcript?: TranscriptMessage[];
  context?: Record<string, unknown>;
}

function trimToLength(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function asUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/** Keep only the fields a reviewer reads, so no stray client state lands in the table. */
function normalizeTranscript(transcript: unknown): TranscriptMessage[] {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((message): message is TranscriptMessage => Boolean(message) && typeof message === "object")
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "unknown",
      content: typeof message.content === "string" ? message.content : "",
      created_at: typeof message.created_at === "string" ? message.created_at : undefined,
    }))
    .filter((message) => message.content.trim() !== "")
    .slice(-MAX_TRANSCRIPT_MESSAGES);
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  try {
    let body: SubmitFeedbackRequest;
    try {
      body = await req.json();
    } catch {
      return errorResponse("Request body must be JSON", 400, origin);
    }

    const comment = trimToLength(body.comment, MAX_COMMENT_LENGTH);
    if (!comment) {
      return errorResponse("Feedback comment is required", 400, origin);
    }

    const rating = body.rating === "up" ? "up" : "down";
    const conversationId = asUuid(body.conversation_id);
    const supabase = createOptimatClient();

    // Auto-save the conversation with the submission. The client's transcript is what the tester
    // actually saw, so it wins; the database copy is a fallback for a submission sent without one.
    let transcript = normalizeTranscript(body.transcript);
    if (transcript.length === 0 && conversationId) {
      const { data: messages, error: messagesError } = await supabase
        .from(TABLES.MESSAGES)
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (messagesError) {
        // A missing transcript must not cost us the comment.
        console.error("Error loading conversation for feedback snapshot:", messagesError);
      } else {
        transcript = normalizeTranscript(messages);
      }
    }

    const { data, error } = await supabase
      .from(TABLES.CHAT_FEEDBACK)
      .insert({
        conversation_id: conversationId,
        message_id: asUuid(body.message_id),
        reviewer_name: trimToLength(body.name, MAX_NAME_LENGTH),
        comment,
        rating,
        transcript,
        context: {
          ...(body.context && typeof body.context === "object" ? body.context : {}),
          origin,
          user_agent: req.headers.get("user-agent"),
          submitted_at: new Date().toISOString(),
        },
      })
      .select()
      .single();

    if (error) {
      console.error("Error saving feedback:", error);
      return errorResponse("Error saving feedback", 500, origin);
    }

    // Only the identifiers go back — the client already has everything else it sent.
    return jsonResponse(
      {
        success: true,
        id: sanitizeRecord(data).id,
        created_at: data.created_at,
        transcript_length: transcript.length,
      },
      201,
      origin
    );
  } catch (error) {
    console.error("Feedback error:", error);
    return errorResponse(
      `Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`,
      500,
      origin
    );
  }
});
