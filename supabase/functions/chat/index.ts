/**
 * Chat API Edge Function for OPTIMAT
 * Handles chat messages with AWS Bedrock Claude integration and tool calling.
 *
 * Note: All tables are in the 'optimat' schema.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "npm:@aws-sdk/client-bedrock-runtime@3.693.0";
import {
  handleCorsPreflightRequest,
  jsonResponse,
  errorResponse,
} from "../_shared/cors.ts";
import {
  createOptimatClient,
  TABLES,
} from "../_shared/supabase.ts";
import { toolDefinitions, executeTool, storeToolCall, ToolResult } from "./tools.ts";
import { getServiceClockContext, SERVICE_TIME_ZONE } from "./trip.ts";
import {
  buildCorrectionPrompt,
  buildFallbackResponse,
  verifyResponse,
} from "./responses.ts";
import {
  buildFactsBlock,
  loadTripState,
  saveTripState,
  updateTripStateFromTools,
  type TripState,
} from "./state.ts";

/**
 * The prompt states only what the server cannot enforce on its own. Anything the code already
 * guarantees — date arithmetic, eligibility evaluation, which bucket a provider belongs in, what
 * question is worth asking next — lives in the tool descriptions and the facts block, where it
 * cannot drift out of step with the validator that enforces it.
 */
const SYSTEM_PROMPT =
  `You are OPTIMAT's transportation assistant, helping riders in the California Bay Area find a ride.

Be genuinely useful: work out what the rider needs, explain what you find, and when something will not work say why and what would work instead. Ask a question only when the answer changes what you can tell them, and ask it in your own words.

Rules you must not break:
- Every provider, date, time, fare, phone number, eligibility rule and route comes from tool results or the verified facts below. Never fill a gap from memory.
- OPTIMAT does not book rides. Hand off — who to call, and by when. Never say a ride is booked or arranged, never pass rider details to a provider, and never collect a name, address, phone number or gate code.
- Providers with unconfirmed eligibility still belong in your answer, marked as needing confirmation. Never drop them silently; never present a ruled-out provider as available.
- Places are in the Bay Area: "Richmond" means Richmond, California. Never ask which state.
- Pass the rider's date words to the tools verbatim; the server resolves them. Never work out a date or weekday yourself.

Write for someone listening on the phone: lead with the answer, keep what changes their next step (who to call, the deadline, whether they qualify), drop the rest. State each fact once, and never two different provider counts in one message.`;

// Types
interface ChatRequest {
  conversation_id: string;
  message: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Attachment {
  type: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

interface ChatResponse {
  message: string;
  attachments: Attachment[];
}

function compactAttachments(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  const compacted: Attachment[] = [];

  for (let i = attachments.length - 1; i >= 0; i--) {
    const attachment = sanitizeAttachmentForChat(attachments[i]);
    const toolName = typeof attachment.metadata?.tool_name === "string" ? attachment.metadata.tool_name : "";
    const key = `${attachment.type}:${toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.unshift(attachment);
  }

  return compacted;
}

function sanitizeAttachmentForChat(attachment: Attachment): Attachment {
  if (attachment.type !== "provider_search" || !attachment.data || typeof attachment.data !== "object") {
    return attachment;
  }

  const data = attachment.data as Record<string, unknown>;
  if (!Array.isArray(data.data)) return attachment;

  return {
    ...attachment,
    data: {
      ...data,
      data: data.data.map((provider) => {
        if (!provider || typeof provider !== "object") return provider;
        const {
          service_area_geojson: _serviceAreaGeojson,
          service_zone_geojson: _serviceZoneGeojson,
          service_zone: _serviceZone,
          raw_data: _rawData,
          ...rest
        } = provider as Record<string, unknown>;
        return rest;
      }),
    },
  };
}

// Claude Opus 5 on Bedrock, as a us-west-1 cross-region inference profile.
// Overridable by secret so the model can be changed or rolled back without a deploy.
const BEDROCK_MODEL_ID = Deno.env.get("CHAT_MODEL_ID") || "us.anthropic.claude-opus-5";

// Reasoning depth: low | medium | high | xhigh | max. Medium keeps turn latency usable
// during a live rider phone call; raise it if eligibility reasoning needs to be deeper.
const CHAT_EFFORT = Deno.env.get("CHAT_EFFORT") || "medium";

// Opus 5 has adaptive thinking on by default, and this ceiling covers thinking plus the
// visible response together — too low a value truncates the answer mid-sentence.
const MAX_RESPONSE_TOKENS = Number(Deno.env.get("CHAT_MAX_TOKENS") || 8000);

// Maximum number of tool call iterations to prevent infinite loops
const MAX_TOOL_ITERATIONS = 6;

/**
 * Opus 5 returns a reasoningContent block that the pinned AWS SDK cannot deserialize; it
 * arrives as {"$unknown": [...]} and Bedrock rejects it when echoed back, failing the turn.
 * The block carries no readable text (Opus 5 never returns raw thinking), so dropping it
 * loses nothing. Verified against Bedrock: a stripped assistant turn is accepted.
 */
function sanitizeAssistantContent(content: any[]): any[] {
  return content.filter((block) => block && !("$unknown" in block));
}

// Convert tool definitions to Bedrock format
function convertToolsToBedrockFormat(tools: typeof toolDefinitions): any[] {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: tool.input_schema,
      },
    },
  }));
}

// Convert message history to Bedrock format
function convertMessagesToBedrockFormat(messages: Message[]) {
  return messages.map((msg) => ({
    role: msg.role,
    content: [{ text: msg.content }],
  }));
}

serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  // Only accept POST requests
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  try {
    // Parse request body
    const body: ChatRequest = await req.json();

    if (!body.conversation_id || !body.message) {
      return errorResponse("Missing required fields: conversation_id and message", 400, origin);
    }

    // Get AWS credentials from environment
    const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
    const awsSecretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
    const awsRegion = Deno.env.get("AWS_REGION") || "us-west-1";
    const googleMapsApiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");

    if (!awsAccessKeyId || !awsSecretAccessKey) {
      return errorResponse("Server configuration error: AWS credentials not configured", 500, origin);
    }

    if (!googleMapsApiKey) {
      return errorResponse("Server configuration error: Google Maps API key not configured", 500, origin);
    }

    // Initialize Supabase client with optimat schema
    const supabase = createOptimatClient();

    // Initialize Bedrock client
    const bedrockClient = new BedrockRuntimeClient({
      region: awsRegion,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
      },
    });

    // Verify conversation exists
    const { data: conversation, error: convError } = await supabase
      .from(TABLES.CONVERSATIONS)
      .select("id")
      .eq("id", body.conversation_id)
      .single();

    if (convError || !conversation) {
      return errorResponse("Conversation not found", 404, origin);
    }

    // Load conversation history
    const { data: existingMessages, error: msgError } = await supabase
      .from(TABLES.MESSAGES)
      .select("role, content")
      .eq("conversation_id", body.conversation_id)
      .order("created_at", { ascending: true });

    if (msgError) {
      console.error("Error loading messages:", msgError);
      return errorResponse("Error loading conversation history", 500, origin);
    }

    // Build message history for Claude (map legacy role names)
    // Filter out empty messages and system messages (tool results stored as system)
    const messageHistory: Message[] = (existingMessages || [])
      .filter((msg) => {
        // Skip system messages (these are tool call results stored incorrectly)
        if (msg.role === "system") return false;
        // Skip messages with empty or whitespace-only content
        if (!msg.content || msg.content.trim() === "") return false;
        return true;
      })
      .map((msg) => {
        // Map legacy role names to Bedrock-compatible names
        let role: "user" | "assistant" = "user";
        if (msg.role === "assistant" || msg.role === "ai") {
          role = "assistant";
        } else if (msg.role === "user" || msg.role === "human") {
          role = "user";
        }
        return { role, content: msg.content };
      });

    // Add the new user message
    messageHistory.push({
      role: "user",
      content: body.message,
    });

    // Save user message to database
    const { error: saveUserError } = await supabase.from(TABLES.MESSAGES).insert({
      conversation_id: body.conversation_id,
      role: "user",
      content: body.message,
    });

    if (saveUserError) {
      console.error("Error saving user message:", saveUserError);
    }

    // Collect attachments from tool calls
    const attachments: Attachment[] = [];

    // Convert tools to Bedrock format
    const bedrockTools = convertToolsToBedrockFormat(toolDefinitions);

    // What this conversation already established. Loaded before the loop so the model can answer
    // a follow-up about an earlier search without running it again.
    let tripState: TripState = await loadTripState(supabase, body.conversation_id);

    const buildSystemPrompt = (state: TripState): string => {
      const facts = buildFactsBlock(state);
      return [
        SYSTEM_PROMPT,
        `\nCurrent service clock: ${getServiceClockContext()}\nAll relative dates must be resolved in ${SERVICE_TIME_ZONE}.`,
        facts ? `\n${facts}` : "",
      ].join("\n");
    };

    // Process with Claude via Bedrock (with tool calling loop)
    let currentMessages: any[] = convertMessagesToBedrockFormat(messageHistory);
    let iterations = 0;
    let finalResponse = "";

    const callModel = (messages: any[], state: TripState) =>
      bedrockClient.send(new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system: [{ text: buildSystemPrompt(state) }],
        messages,
        toolConfig: {
          tools: bedrockTools,
        },
        inferenceConfig: {
          maxTokens: MAX_RESPONSE_TOKENS,
        },
        additionalModelRequestFields: {
          output_config: { effort: CHAT_EFFORT },
        },
      }));

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const response = await callModel(currentMessages, tripState);

      // Extract content from response
      const outputContent: any[] = response.output?.message?.content || [];

      // Check for tool use blocks
      const toolUseBlocks = outputContent.filter(
        (block: { toolUse?: unknown }) => block.toolUse
      );

      // Extract text response
      const textBlocks = outputContent.filter(
        (block: { text?: string }) => block.text
      );

      if (textBlocks.length > 0) {
        finalResponse = textBlocks.map((block) => String(block.text || "")).join("\n");
      }

      // If no tool calls or stop reason is end_turn, we're done
      if (toolUseBlocks.length === 0 || response.stopReason === "end_turn") {
        break;
      }

      // Execute tool calls
      const attachmentsBefore = attachments.length;
      const toolResults: Array<{
        toolResult: {
          toolUseId: string;
          content: Array<{ text: string }>;
        };
      }> = [];

      for (const block of toolUseBlocks) {
        const toolUse = block.toolUse;
        if (!toolUse?.name || !toolUse.toolUseId) continue;
        console.log(`Executing tool: ${toolUse.name}`, toolUse.input);

        const result: ToolResult = await executeTool(
          toolUse.name,
          toolUse.input,
          supabase,
          googleMapsApiKey
        );

        // Store tool call in database
        await storeToolCall(supabase, body.conversation_id, toolUse.name, toolUse.input, result);

        // Add to attachments based on tool type
        if (result.success && result.data) {
          let attachmentType = "tool_result";
          if (toolUse.name === "find_providers" || toolUse.name === "check_trip_coverage") {
            attachmentType = "provider_search";
          } else if (toolUse.name === "search_addresses_from_user_query") {
            attachmentType = "address_search";
          } else if (toolUse.name === "get_provider_info") {
            attachmentType = "provider_info";
          } else if (toolUse.name === "general_provider_question") {
            attachmentType = "web_search";
          }

          attachments.push({
            type: attachmentType,
            data: result.data,
            metadata: {
              tool_name: toolUse.name,
              tool_use_id: toolUse.toolUseId,
              conversation_id: body.conversation_id,
            },
          });
        }

        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            content: [{ text: JSON.stringify(result.success ? result.data : { error: result.error }) }],
          },
        });
      }

      // Fold this iteration's results in before the next model call, so a follow-up tool call
      // sees what the previous one established.
      tripState = updateTripStateFromTools(tripState, attachments.slice(attachmentsBefore));

      // Add assistant response and tool results to message history
      const assistantContent = sanitizeAssistantContent(outputContent);
      if (assistantContent.length === 0) {
        console.error("Assistant turn had no serializable content; ending tool loop", {
          block_keys: outputContent.map((block) => Object.keys(block)[0]),
        });
        break;
      }

      currentMessages = [
        ...currentMessages,
        {
          role: "assistant" as const,
          content: assistantContent,
        },
        {
          role: "user" as const,
          content: toolResults,
        },
      ];
    }

    const responseAttachments = compactAttachments(attachments);

    // Check the model's own answer against the verified facts. Correct it by asking for a
    // rewrite, not by overwriting it — a substituted template cannot respond to what the rider
    // just said, which is how the same sentence was returned three turns in a row.
    let problems = verifyResponse(finalResponse, tripState);
    if (problems.length > 0) {
      console.warn("Response failed verification; asking for one correction", {
        codes: problems.map((problem) => problem.code),
      });
      try {
        const retry = await callModel(
          [
            ...currentMessages,
            ...(finalResponse ? [{ role: "assistant" as const, content: [{ text: finalResponse }] }] : []),
            { role: "user" as const, content: [{ text: buildCorrectionPrompt(problems) }] },
          ],
          tripState,
        );
        const retryText = (retry.output?.message?.content || [])
          .filter((block: { text?: string }) => block.text)
          .map((block: { text?: string }) => String(block.text || ""))
          .join("\n");
        const retryProblems = verifyResponse(retryText, tripState);
        if (retryText && retryProblems.length === 0) {
          finalResponse = retryText;
          problems = [];
          console.log("Correction accepted");
        } else {
          problems = retryProblems;
        }
      } catch (error) {
        console.error("Correction attempt failed:", error);
      }
    }

    // Only after a failed correction does the server write the words itself.
    if (problems.length > 0) {
      console.error("Falling back to generated response", {
        codes: problems.map((problem) => problem.code),
      });
      finalResponse = buildFallbackResponse(tripState);
    }

    await saveTripState(supabase, body.conversation_id, tripState);

    // Save assistant response to database
    if (finalResponse) {
      const { error: saveAssistantError } = await supabase.from(TABLES.MESSAGES).insert({
        conversation_id: body.conversation_id,
        role: "assistant",
        content: finalResponse,
        attachments: responseAttachments.length > 0 ? responseAttachments : null,
      });

      if (saveAssistantError) {
        console.error("Error saving assistant message:", saveAssistantError);
      }
    }

    // Update conversation's updated_at timestamp
    await supabase
      .from(TABLES.CONVERSATIONS)
      .update({ updated_at: new Date().toISOString() })
      .eq("id", body.conversation_id);

    // Return response
    const chatResponse: ChatResponse = {
      message: finalResponse,
      attachments: responseAttachments,
    };

    return jsonResponse(chatResponse, 200, origin);
  } catch (error) {
    console.error("Chat error:", error);
    return errorResponse(`Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`, 500, origin);
  }
});
