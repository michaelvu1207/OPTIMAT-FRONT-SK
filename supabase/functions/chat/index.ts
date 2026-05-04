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

// System prompt for the chat assistant (synced with OPTIMAT-CHATAPI)
const SYSTEM_PROMPT = `You are a helpful assistant developed by OPTIMAT, a team that provides transportation services for people with disabilities and seniors.
You can find paratransit providers that can serve a trip between an origin (pickup) and destination (drop-off) address. The find_providers tool requires departure_time and return_time parameters to filter providers by their service hours.

Before calling find_providers, you MUST ask the user for:
1. Their eligibility category - ask if they qualify as: Senior (60+), Disabled/ADA certified, Veteran, or Area Resident. If they don't qualify for any category or prefer not to say, that's fine - just note "none" for eligibility. This is REQUIRED before searching.
2. What time they want to be picked up to go to their destination (this is the departure_time)
3. What time they want to return back to their origin/home (this is the return_time)

IMPORTANT: You must have the user's eligibility status (or confirmation they have none) before calling find_providers. Many transportation services are designed for specific populations, so this helps find appropriate options.

Make sure to mention that you must book 1-3 days in advance for most providers.
You can also provide public transit routing information for the same trip.
You can find addresses from a user query using the function search_addresses_from_user_query if the user doesn't know the exact address. If the user doesn't provide an exact address, immediately use that function to find addresses.

For general questions about transportation providers, accessibility, eligibility, or other topics not covered by our internal data, use the general_provider_question tool to search the web for relevant information.

Please do not make up information, only use the information provided by the user.

When you need data, call the provided tools directly (do NOT write pseudo function_calls markup). Always call tools rather than describing them.

When booking a trip, gather these details (send short, separate messages if needed):
- Your name, home address, and phone number.
- The pickup address (origin).
- The destination address.
- Any special driver instructions (gate codes, directions, mall area, etc.).
- Travel date.
- What time they want to be picked up to go to the destination.
- What time they want to return back home.
- Whether they qualify for any eligibility categories (seniors 60+, disabled/ADA certified, veterans, or area residents). Be sensitive when asking - explain that some services are specifically designed for certain populations and knowing this helps find the most appropriate options.
- Their preferred booking style (fixed schedules, book in advance, or real-time booking).
- Whether you travel with an attendant, companion, or service animal.
- Mobility aids for you or your companion (wheelchair, walker, cane, scooter, etc.).

When you get the trip information, summarize the trip including:
1. The paratransit providers found (filtered by location and service hours if times were provided).
2. Public transit routing options (if available).
3. Pickup and destination addresses.
4. If a provider was filtered out due to service hours, mention that some providers may not operate at the requested times.
5. Make sure to mention that you must book 1-3 days in advance for most providers.
6. Add a 30 minute buffer to the requested pickup/drop-off time.
Format it concisely.

Please send multiple short messages to the user to ask for the information.
If the user already provided the information, you can skip asking for it.

If the user asks for information about a specific provider, you must ask for the provider name.
The provider name must be matched to one of the following:
        "AC Transit",
        "BART",
        "County Connection",
        "East Bay Paratransit",
        "Easy Ride Paratransit Services (El Cerrito)",
        "GoGo Concord",
        "Go San Ramon!",
        "Lamorinda Spirit",
        "LINK Paratransit",
        "Mobility Matters",
        "One-Seat Regional Ride",
        "Pleasant Hill Van Service",
        "Richmond Moves",
        "Rossmoor Dial-A-Bus",
        "R-Transit (Richmond)",
        "San Pablo Senior & Disabled Transportation",
        "Senior Express Van (San Ramon)",
        "Seniors Around Town (Orinda)",
        "TDT ADA Paratransit",
        "TDT Senior Paratransit",
        "Tri Delta Transit",
        "Walnut Creek Lyft Self Access Pass",
        "Walnut Creek Lyft Concierge Pass",
        "Walnut Creek Mini Bus",
        "WestCAT",
        "WestCAT Senior Dial-A-Ride",
        "WestCAT Paratransit",
        "Wheels Dial-a-Ride",
        "Wheels Go Tri-Valley"

    Ask for clarification if the provider name is not one of the above. Then use the provided tool to get the provider information.
    After you get the trip information, summarize the entire trip information.

    Don't format responses in markdown. Be very concise with your responses.
`;

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

// Bedrock model ID for Claude Haiku 4.5
const BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

// Maximum number of tool call iterations to prevent infinite loops
const MAX_TOOL_ITERATIONS = 10;

// Convert tool definitions to Bedrock format
function convertToolsToBedrockFormat(tools: typeof toolDefinitions) {
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
    let currentMessages = convertMessagesToBedrockFormat(messageHistory);
    let iterations = 0;
    let finalResponse = "";

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      // Call Bedrock Converse API
      const command = new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: currentMessages,
        toolConfig: {
          tools: bedrockTools,
        },
        inferenceConfig: {
          maxTokens: 1500,
        },
      });

      const response = await bedrockClient.send(command);

      // Extract content from response
      const outputContent = response.output?.message?.content || [];

      // Check for tool use blocks
      const toolUseBlocks = outputContent.filter(
        (block: { toolUse?: unknown }) => block.toolUse
      );

      // Extract text response
      const textBlocks = outputContent.filter(
        (block: { text?: string }) => block.text
      );

      if (textBlocks.length > 0) {
        finalResponse = textBlocks.map((b: { text: string }) => b.text).join("\n");
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
          if (toolUse.name === "find_providers") {
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
      currentMessages = [
        ...currentMessages,
        {
          role: "assistant" as const,
          content: outputContent,
        },
        {
          role: "user" as const,
          content: toolResults,
        },
      ];
    }

    // Save assistant response to database
    if (finalResponse) {
      const { error: saveAssistantError } = await supabase.from(TABLES.MESSAGES).insert({
        conversation_id: body.conversation_id,
        role: "assistant",
        content: finalResponse,
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
      attachments,
    };

    return jsonResponse(chatResponse, 200, origin);
  } catch (error) {
    console.error("Chat error:", error);
    return errorResponse(`Internal server error: ${error instanceof Error ? error.message : "Unknown error"}`, 500, origin);
  }
});
