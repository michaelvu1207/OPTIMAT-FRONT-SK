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
  buildCoverageResponse,
  buildDateResolutionResponse,
  buildNoProviderResponse,
  ensurePublicTransitProviderSummary,
  ensureVerificationSummary,
} from "./responses.ts";

const SYSTEM_PROMPT = `You are OPTIMAT's Bay Area transportation assistant. Use current OPTIMAT provider data and tool results; never invent dates, locations, eligibility, schedules, routes, or booking capabilities.

Location rules:
- OPTIMAT's default service context is the California Bay Area. “Richmond” always means Richmond, California unless the user explicitly names another state. Never ask which Richmond or which state.
- If a location is vague, use search_addresses_from_user_query.
- As soon as origin and destination are known, call check_trip_coverage before asking for date, times, return details, or eligibility. If it reports not_covered or a city mismatch, explain that immediately and do not continue a provider search until the location is corrected.

Full provider-search rules:
- Required facts are: origin, destination, travel date, outbound time, outbound time intent (depart_at or arrive_by), trip type (one_way or round_trip), and eligibility context.
- Pass the user's date words exactly as travel_date_raw. The server—not you—resolves “today,” “tomorrow,” weekdays, month/day, and the year.
- Whenever the user provides or changes a date phrase, call resolve_trip_date before repeating it, naming its weekday, or inferring its year. Never calculate dates yourself.
- Never reuse an earlier trip's explicit date to reinterpret a later relative date.
- A one-way trip never needs a return time. Ask for return_time only for a round trip.
- Eligibility context includes the rider's exact age, disability, ADA certification, veteran status, and residence city. Use null for facts not stated. If the rider declines, set declined=true.
- Ask "How old are you?" and pass the number. Never ask "are you a senior?" and never treat "senior" as an age: providers in this area set minimums of 50, 55, 60, and 65, so only an exact age decides them.
- Only providers in result.data are eligible recommendations. Providers in result.verification_required matched location and schedule but their eligibility could not be confirmed — list them separately as needing confirmation with the provider, and never drop them silently. Never recommend result.excluded_providers.
- Fixed-route agencies are not door-to-door providers. When public_transit is returned, present it as a found transportation provider option labeled “Public Transit,” while clearly distinguishing it from direct-ride providers.
- The diagnostics identify whether geography, schedule, or eligibility caused zero results. State the first definitive reason; do not give a generic list of guesses.
- Public transit times are valid only when returned by the tool for the requested travel date and depart/arrive intent.

Provider handoff rules:
- OPTIMAT does not book rides. Do not ask for the rider's name, home address, phone number, gate code, or other booking details.
- When a user selects a provider, use get_provider_info and give the external booking method, advance notice, eligibility/application requirement, phone, and website from the tool data.
- Do not say a booking is complete or that OPTIMAT will send information to a provider.

For provider facts not in internal data, use general_provider_question and keep the query in California Bay Area context.
Call tools directly when needed.

Writing for riders:
- Lead with the answer. The first sentence says what you found or what you need, not what you are about to do.
- Keep it short enough to read aloud over the phone. Include the details that change the rider's next step (who to call, when to book by, whether they qualify) and drop the rest.
- Give a fact once. Do not restate a provider count, a date, or an eligibility rule you have already stated in the same message.`;

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

function getProviderSearchData(attachments: Attachment[]): Record<string, unknown> | null {
  for (let i = attachments.length - 1; i >= 0; i--) {
    const attachment = attachments[i];
    if (
      attachment.type === "provider_search" &&
      attachment.metadata?.tool_name === "find_providers" &&
      attachment.data &&
      typeof attachment.data === "object"
    ) {
      return attachment.data as Record<string, unknown>;
    }
  }

  return null;
}

function getToolData(
  attachments: Attachment[],
  toolName: string,
): Record<string, unknown> | null {
  for (let i = attachments.length - 1; i >= 0; i--) {
    const attachment = attachments[i];
    if (
      attachment.metadata?.tool_name === toolName &&
      attachment.data &&
      typeof attachment.data === "object"
    ) {
      return attachment.data as Record<string, unknown>;
    }
  }
  return null;
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

// Reasoning depth: low | medium | high | xhigh | max. Raising this trades latency for
// better eligibility reasoning and clearer explanations of why a trip cannot be served.
const CHAT_EFFORT = Deno.env.get("CHAT_EFFORT") || "high";

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

    // Process with Claude via Bedrock (with tool calling loop)
    let currentMessages: any[] = convertMessagesToBedrockFormat(messageHistory);
    let iterations = 0;
    let finalResponse = "";

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      // Call Bedrock Converse API
      const command = new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system: [{
          text: `${SYSTEM_PROMPT}\n\nCurrent service clock: ${getServiceClockContext()}\nAll relative dates must be resolved in ${SERVICE_TIME_ZONE}.`,
        }],
        messages: currentMessages,
        toolConfig: {
          tools: bedrockTools,
        },
        inferenceConfig: {
          maxTokens: MAX_RESPONSE_TOKENS,
        },
        additionalModelRequestFields: {
          output_config: { effort: CHAT_EFFORT },
        },
      });

      const response = await bedrockClient.send(command);

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
    const coverage = getToolData(responseAttachments, "check_trip_coverage");
    const dateResolution = getToolData(responseAttachments, "resolve_trip_date");
    const providerSearch = getProviderSearchData(responseAttachments);
    const deterministicResponse =
      buildCoverageResponse(coverage) ||
      (providerSearch ? buildNoProviderResponse(providerSearch) : null) ||
      (!providerSearch ? buildDateResolutionResponse(dateResolution) : null);
    if (deterministicResponse) {
      finalResponse = deterministicResponse;
    }
    if (providerSearch) {
      finalResponse = ensurePublicTransitProviderSummary(finalResponse, providerSearch);
      finalResponse = ensureVerificationSummary(finalResponse, providerSearch);
    }

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
