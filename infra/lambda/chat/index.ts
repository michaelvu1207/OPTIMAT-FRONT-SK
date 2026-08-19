/**
 * Chat Lambda Function
 *
 * AI chat with AWS Bedrock Claude Haiku 4.5 integration and tool calling.
 * Uses IAM role credentials (no explicit AWS key env vars needed).
 *
 * Routes:
 *   POST /chat → { message, attachments }
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, queryOne, TABLES } from '../_shared/db.js';
import { toolDefinitions, executeTool, storeToolCall, type ToolResult } from './tools.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_TOOL_ITERATIONS = 10;

const SYSTEM_PROMPT = `You are a helpful assistant developed by OPTIMAT, a team that provides transportation services for people with disabilities and seniors.
You can find paratransit providers that can serve a trip between an origin (pickup) and destination (drop-off) address. The find_providers tool requires departure_time and return_time parameters to filter providers by their service hours.

Before calling find_providers, you MUST ask the user for:
1. Their eligibility context - ask about age/senior status, disability or ADA paratransit eligibility, veteran status, and where they live. If they don't qualify for any category or prefer not to say, that's fine - just note "none" or "unknown" for eligibility. This is REQUIRED before searching.
2. What time they want to be picked up to go to their destination (this is the departure_time)
3. What time they want to return back to their origin/home (this is the return_time)

IMPORTANT: You must have the user's eligibility context (or confirmation they prefer not to share) before calling find_providers. The tool filters by trip geography and service hours, but it does not filter by eligibility. It returns each provider's eligibility requirements. You must compare those requirements to the user's situation and recommend providers in plain English.

When reviewing returned providers:
- Recommend providers only when the returned eligibility text appears to match the user's situation.
- Treat every eligibility match as preliminary. In rider-facing responses, say "you may qualify" or "you could be eligible" and tell the rider the provider makes the final determination. Never say "you qualify", "you are eligible", or otherwise make a definitive eligibility determination.
- If a provider may match but needs an application, proof, ADA approval, residency proof, or a provider decision, say that clearly.
- If a provider does not appear to match, do not present it as a recommendation; at most mention it as not likely eligible if useful.
- Preserve AND/OR logic from provider text. For example, "senior or disabled AND Concord resident" means both a category match and Concord residency are needed.

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
- Whether they may qualify for any eligibility categories (seniors 60+, disabled/ADA paratransit eligibility, veterans, or area residents). Be sensitive when asking - explain that some services are specifically designed for certain populations and knowing this helps find the most appropriate options.
- Their preferred booking style (fixed schedules, book in advance, or real-time booking).
- Whether you travel with an attendant, companion, or service animal.
- Mobility aids for you or your companion (wheelchair, walker, cane, scooter, etc.).

When you get the trip information, summarize the trip including:
1. The best provider recommendations based on location, service hours, and your reasoning over each provider's eligibility requirements.
2. Public transit routing options (if available).
3. Pickup and destination addresses.
4. If a provider was filtered out due to service hours, mention that some providers may not operate at the requested times.
5. Make sure to mention that you must book 1-3 days in advance for most providers.
6. Add a 30 minute buffer to the requested pickup/drop-off time.
7. For each recommended provider, include the eligibility reason and any proof/application step shown in the provider data.
Format it concisely.

Please send multiple short messages to the user to ask for the information.
If the user already provided the information, you can skip asking for it.

If the user asks for information about a specific provider, you must ask for the provider name.

Don't format responses in markdown. Be very concise with your responses.
Use the rider-facing term "ADA paratransit eligibility" consistently; never substitute legacy status wording in OPTIMAT-authored text.
One Seat Ride is not a standalone provider. For cross-area trips, direct riders to the applicable paratransit agencies for coordination and never invent a separate fixed fare.
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Attachment {
  type: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * The model is prompted to keep screening language preliminary, but this last-mile guard prevents
 * a rider from receiving a definitive determination if the instruction is missed. Provider-facing
 * confirmation questions ("whether you qualify") are intentionally left unchanged.
 */
function softenEligibilityClaims(response: string): string {
  const cautious = (match: string, phrase: string) =>
    /^[A-Z]/.test(match) ? phrase[0].toUpperCase() + phrase.slice(1) : phrase;

  return response
    .replace(/(?<!whether )\byou (?:do |definitely )?qualify\b/gi, (match) => cautious(match, 'you may qualify'))
    .replace(/(?<!whether )\byou are (?:definitely )?eligible\b/gi, (match) => cautious(match, 'you may be eligible'))
    .replace(/(?<!whether )\byou['’]re (?:definitely )?eligible\b/gi, (match) => cautious(match, 'you may be eligible'))
    .replace(/\bthe rider (?:definitely )?qualifies\b/gi, (match) => cautious(match, 'the rider may qualify'))
    .replace(/\bthe rider is (?:definitely )?eligible\b/gi, (match) => cautious(match, 'the rider may be eligible'));
}

function getProviderSearchData(attachments: Attachment[]): Record<string, unknown> | null {
  for (let i = attachments.length - 1; i >= 0; i--) {
    const attachment = attachments[i];
    if (attachment.type === 'provider_search' && attachment.data && typeof attachment.data === 'object') {
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
    const toolName = typeof attachment.metadata?.tool_name === 'string' ? attachment.metadata.tool_name : '';
    const key = `${attachment.type}:${toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.unshift(attachment);
  }

  return compacted;
}

function sanitizeAttachmentForChat(attachment: Attachment): Attachment {
  if (attachment.type !== 'provider_search' || !attachment.data || typeof attachment.data !== 'object') {
    return attachment;
  }

  const data = attachment.data as Record<string, unknown>;
  if (!Array.isArray(data.data)) return attachment;

  return {
    ...attachment,
    data: {
      ...data,
      data: data.data.map((provider) => {
        if (!provider || typeof provider !== 'object') return provider;
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

function buildNoProviderResponse(providerSearch: Record<string, unknown>): string | null {
  const providers = Array.isArray(providerSearch.data) ? providerSearch.data : [];
  const totalFound =
    typeof providerSearch.total_found === 'number' ? providerSearch.total_found : providers.length;

  if (totalFound !== 0) return null;

  const sourceAddress =
    typeof providerSearch.source_address === 'string' ? providerSearch.source_address : 'the pickup address';
  const destinationAddress =
    typeof providerSearch.destination_address === 'string'
      ? providerSearch.destination_address
      : 'the destination address';
  const hasPublicTransit = Boolean(providerSearch.public_transit);

  const lines = [
    "I couldn't find any providers in our current data that serve both ends of this trip.",
    '',
    `Pickup: ${sourceAddress}`,
    `Destination: ${destinationAddress}`,
  ];

  if (hasPublicTransit) {
    lines.push('', 'Public transit routing may still be available for this trip. Open the results to review the transit option.');
  }

  lines.push('', "This means no provider service area matched both addresses after geocoding and service-hour filtering. I won't recommend a specific provider unless it appears in the filtered results.");

  return lines.join('\n');
}

function convertToolsToBedrockFormat(tools: typeof toolDefinitions) {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.input_schema },
    },
  }));
}

function convertMessagesToBedrockFormat(messages: Message[]): any[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: [{ text: msg.content }],
  }));
}

// ─── Handler ────────────────────────────────────────────────────────────────

// Initialize Bedrock client once (reused across warm invocations)
// Uses Lambda execution role credentials automatically
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-west-1',
});

export const handler = createHandler(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, req.origin);
  }

  const body = req.body as { conversation_id?: string; message?: string } | null;
  if (!body?.conversation_id || !body?.message) {
    return errorResponse('Missing required fields: conversation_id and message', 400, req.origin);
  }

  const googleMapsApiKey = 'aws-location';

  // Verify conversation exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`, [body.conversation_id]
  );
  if (!conversation) {
    return errorResponse('Conversation not found', 404, req.origin);
  }

  // Load conversation history
  const existingMessages = await queryRows(
    `SELECT role, content FROM ${TABLES.MESSAGES}
     WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [body.conversation_id]
  );

  // Build message history (filter empty/system, map roles)
  const messageHistory: Message[] = existingMessages
    .filter((msg) => msg.role !== 'system' && msg.content?.trim())
    .map((msg) => ({
      role: (msg.role === 'assistant' || msg.role === 'ai') ? 'assistant' as const : 'user' as const,
      content: msg.content,
    }));

  // Add new user message
  messageHistory.push({ role: 'user', content: body.message });

  // Save user message
  await query(
    `INSERT INTO ${TABLES.MESSAGES} (conversation_id, role, content) VALUES ($1, $2, $3)`,
    [body.conversation_id, 'user', body.message]
  );

  // Collect attachments from tool calls
  const attachments: Attachment[] = [];
  const bedrockTools = convertToolsToBedrockFormat(toolDefinitions);

  // Tool-calling loop
  let currentMessages = convertMessagesToBedrockFormat(messageHistory);
  let iterations = 0;
  let finalResponse = '';

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const command = new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: currentMessages,
      toolConfig: { tools: bedrockTools as any },
      inferenceConfig: { maxTokens: 1500 },
    });

    const response = await bedrockClient.send(command);
    const outputContent = response.output?.message?.content || [];

    const toolUseBlocks = outputContent.filter((block: any) => block.toolUse);
    const textBlocks = outputContent.filter((block: any) => block.text);

    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map((b: any) => b.text).join('\n');
    }

    if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
      break;
    }

    // Execute tool calls
    const toolResults: any[] = [];

    for (const block of toolUseBlocks) {
      const toolUse = block.toolUse;
      if (!toolUse?.name || !toolUse.toolUseId) continue;
      console.log(`Executing tool: ${toolUse.name}`, toolUse.input);

      const result: ToolResult = await executeTool(toolUse.name, toolUse.input, googleMapsApiKey);
      await storeToolCall(body.conversation_id, toolUse.name, toolUse.input, result);

      // Build attachment
      if (result.success && result.data) {
        const typeMap: Record<string, string> = {
          find_providers: 'provider_search',
          search_addresses_from_user_query: 'address_search',
          get_provider_info: 'provider_info',
          general_provider_question: 'web_search',
        };
        attachments.push({
          type: typeMap[toolUse.name] || 'tool_result',
          data: result.data,
          metadata: { tool_name: toolUse.name, tool_use_id: toolUse.toolUseId, conversation_id: body.conversation_id },
        });
      }

      toolResults.push({
        toolResult: {
          toolUseId: toolUse.toolUseId,
          content: [{ text: JSON.stringify(result.success ? result.data : { error: result.error }) }],
        },
      });
    }

    // Continue conversation with tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: outputContent },
      { role: 'user' as const, content: toolResults },
    ];
  }

  const responseAttachments = compactAttachments(attachments);
  const providerSearch = getProviderSearchData(responseAttachments);
  const noProviderResponse = providerSearch ? buildNoProviderResponse(providerSearch) : null;
  if (noProviderResponse) {
    finalResponse = noProviderResponse;
  }
  finalResponse = softenEligibilityClaims(finalResponse);

  // Save assistant response
  if (finalResponse) {
    await query(
      `INSERT INTO ${TABLES.MESSAGES} (conversation_id, role, content, attachments) VALUES ($1, $2, $3, $4)`,
      [body.conversation_id, 'assistant', finalResponse, responseAttachments.length > 0 ? JSON.stringify(responseAttachments) : null]
    );
  }

  // Update conversation timestamp
  await query(
    `UPDATE ${TABLES.CONVERSATIONS} SET updated_at = NOW() WHERE id = $1`,
    [body.conversation_id]
  );

  return jsonResponse({ message: finalResponse, attachments: responseAttachments }, 200, req.origin);
});
