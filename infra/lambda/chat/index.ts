/**
 * Chat Lambda Function
 *
 * AI chat with AWS Bedrock Claude Haiku 4.5 integration and tool calling.
 * Uses IAM role credentials (no explicit AWS key env vars needed).
 *
 * Routes:
 *   POST /chat → { message, attachments }
 */

import { riderProviderDetails } from './provider-details.js';
import { applyUserDestination } from './destination.js';
import { registerQuestion, applyTypedBinaryAnswer, questionsFromText, applyBinaryAnswer, binaryFactsBlock, YES_NO_OPTIONS } from './yes-no.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { query, queryRows, queryOne, TABLES } from '../_shared/db.js';
import { toolDefinitions, executeTool, storeToolCall, requiredRiderQuestion, type ToolResult } from './tools.js';
import { buildCurrentTimeBlock, buildRiderFactsBlock, loadTurnContext, saveTurnContext } from './state.js';
import { serializeToolResultForModel, boundConversationHistory, assertModelRequestBudget, ModelContextLimitError } from './model-payload.js';
import { AGE_RANGE_QUESTION, ageBounds, ageChoiceData, ageRangeFromMessage, exactAgeFromMessage, getAgeRange, mergeAgeFacts } from './age.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BEDROCK_MODEL_ID = process.env.CHAT_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_TOOL_ITERATIONS = 10;

const SYSTEM_PROMPT = `For every yes/no question, call ask_yes_no to offer three buttons: Yes, No, Would rather not say. Ask one fact at a time, with a complete positive standalone question. Do not list these options in prose. A refusal means unknown, never false or consent, and must not be asked again. Preserve unknown eligibility for provider verification. Do not invent answers. Reuse explicit button answers, but accept a rider's explicit typed correction. Never ask a binary question instead of an open-ended request for addresses, dates, times, age ranges, or residence. Keep the existing address and age selection tools.
You are a helpful assistant developed by OPTIMAT, a team that provides transportation services for people with disabilities and seniors.
You help riders discover transportation services; you do not book rides or submit applications. You can find paratransit providers for a trip between an origin (pickup) and destination (drop-off) address. The find_providers tool uses the departure time and, for a round trip, the return time to check service hours.

The find_providers tool filters by source/destination GeoJSON and known service hours. It returns candidates,
not recommendations. Once it returns candidates, you MUST call assess_eligibility and provide exactly one verdict
for every candidate before answering. Provider cards are created only from that assessment.
Before searching or recommending trip options, you need the rider's age range and city of residence. A voluntarily stated exact age is also sufficient, but never require an exact age.
When age information is missing, call ask_age_range to show clickable choices. The choices are Under 18, 18–49, 50–54, 55–59, 60–64, and 65+, based on provider cutoffs at 18, 50, 55, 60, and 65. Explain briefly that age ranges help check eligibility. Ask for residence when missing too. Reuse explicit answers from
this message or prior turns. If either is declined, explain that the trip search cannot be completed without it;
do not guess, repeatedly pressure the rider, or offer unassessed providers as recommendations.

Pass eligibility as structured facts: age_range (or a voluntarily supplied exact age), disability, veteran status,
and residence city. Disability and veteran status are conditional eligibility questions, not a universal intake checklist. Ask only when an unknown answer can change a returned candidate's eligibility after accounting for known age, residence, and any OR alternatives. Briefly explain the relevant provider requirement before asking. Do not ask for diagnoses, medical records, proof documents, or ADA paratransit eligibility status.
Use only facts the rider explicitly stated. A pickup address is not proof of residence unless
the rider identifies it as home. Unknown facts stay unknown.
Never turn a range into an exact age or repeatedly ask for age after a selection. Compare the entire interval to provider cutoffs. For example, 60–64 satisfies 60+ but not 65+, and 50–54 satisfies 50+ but not 55+. Preserve senior OR disability OR veteran alternatives and the 18+ minimum where stated. If a future cutoff lies within a selected range, leave that provider as verification_required and explain the specific threshold. If the provider only says "Senior" without a number, ask the provider to confirm rather than assuming a cutoff. When the rider selects a range, acknowledge it and continue with missing trip details.

For disability information, only ask whether the rider has a disability.
Never ask about ADA paratransit eligibility.
This includes questions about certification, applications, or transit-agency approval. Do not infer ADA approval
from disability. Record ADA status only when volunteered. If ADA approval is required but unknown, use
verification_required and explain that the provider must confirm it without asking the rider about it.
If disabled=false, exclude every service classified as ADA Paratransit, but do not exclude Non-ADA services
merely because their documentation mentions ADA. If disabled=true, do not remove any option on disability
or ADA approval grounds, even if approval is unknown or false. Retain it with a provider-verification note.
Age, residence, geography, service hours, and other independent requirements still apply.

When reviewing returned providers:
- Preserve every AND/OR clause in the returned eligibility text, including residence.
- Use verification_required when an unknown fact could change the answer and name that missing fact.
- Never omit a candidate from assess_eligibility; use ineligible when a known fact rules it out.
- Recommend providers only after assess_eligibility returns them in its eligible results.
- If service_hours_known is false, say the requested time still needs confirmation with the provider.
- Treat every eligibility match as preliminary. In rider-facing responses, say "you may qualify" or "you could be eligible" and tell the rider the provider makes the final determination. Never say "you qualify", "you are eligible", or otherwise make a definitive eligibility determination.
- If a provider may match but needs an application, proof, ADA approval, residency proof, or a provider decision, say that clearly.
- If a provider does not appear to match, do not present it as a recommendation; at most mention it as not likely eligible if useful.
- Preserve AND/OR logic from provider text. For example, "senior or disabled AND Concord resident" means both a category match and Concord residency are needed.

Explain initial application requirements separately from ride booking notice. Use each provider's schedule_type.advance_notice for its booking window; never give a universal 1-3-day rule. An eligibility match is not confirmation that an application has been approved or a ride is available immediately.
If booking.application is present, use its required flag, processing_time, instructions, source_url, and verified_at as recorded provider information. Otherwise use only explicit application instructions in eligibility_reqs. Missing application information does not mean no application is required. When application processing time is absent, say "Contact the provider to confirm processing time." Never reuse booking notice as application processing time, invent a 30-day wait, infer a waitlist, or promise to accelerate an application. Existing application approval can be volunteered, but never ask the rider about ADA approval or certification status.
Application processing_time can be legacy text or structured data: kind=estimate means about value units, up_to means at most value units, at_least means at least value units, range uses minimum and maximum, and same_day means same-day processing. Preserve calendar_days versus business_days, weeks, and months. These are recorded processing estimates, not guarantees of approval or immediate ride availability.
You can also provide public transit routing information for the same trip.
You can find addresses from a user query using the function search_addresses_from_user_query if the user doesn't know the exact address. If the user doesn't provide an exact address, immediately use that function to find addresses.
Preserve the full destination identity across follow-up searches: organization, campus, medical specialty, and destination city supplied by the rider. Search pickup and destination separately with their role and structured location fields. Never attach the pickup or residence city to the destination. When the rider says Kaiser, do not drop Kaiser from later eye-doctor searches or replace it with an unrelated clinic. In a medical-appointment conversation, "apt" may mean appointment; do not assume it means apartment or reset the medical destination. Clarify the abbreviation only if the context is insufficient.
When a department/building is requested, call search_addresses_from_user_query for AWS map candidates first. Avoid third-party search. The verify_destination_address tool also uses AWS first; it may call Tavily only when no specific AWS candidate exists and the rider explicitly asks to check an official website or verify the department address. Never request this extra lookup routinely. Official results are still suggestions until the rider confirms them. If official verification is unavailable, show the returned map candidates as possible matches without claiming they are verified departments. Ask the rider to choose a location or select "None of these — enter an address". Never say either address is fine or assume the driver knows. Do not search providers until the rider confirms a destination. Preserve organization, specialty and destination city; do not borrow the pickup city.
Address search results are choices, not confirmed trip locations. Ask the rider to select a pickup or destination using the address buttons or confirm it in text. A Street, Locality, or other area result is not a verified facility address; ask for a more specific facility or full street address. Preserve the facility name and full returned street address; never invent a street number. When the rider says "Use [address] as my pickup/destination", record it for that trip role and ask only for the remaining trip details.

For general questions about transportation providers, accessibility, eligibility, or other topics not covered by our internal data, use the general_provider_question tool to search the web for relevant information.

Please do not make up information, only use the information provided by the user.

Date accuracy is required before every response and tool call:
- First check the current local date and time supplied below in America/Los_Angeles. This server clock is authoritative; do not take today's date from conversation history, examples, or memory.
- For "today" and "tomorrow", use the exact calendar date and weekday in the server-verified dates below. Tomorrow means the next local calendar day, including across month and year boundaries.
- Before outputting any date, silently verify that the relative phrase, calendar date, year, and weekday all agree. For other dates, resolve them from the current local date and check the weekday against the resolved calendar date. Use the same verified date in tool parameters and the trip summary.
- Apply this check to confirmations, corrections, and examples in your own questions. Do not add an unverified date or weekday to a question; simply ask "What date would you like to travel?" when no date is needed.
- If the rider gives conflicting date details, ask which date they mean instead of silently choosing one. If you cannot verify a date, ask for clarification rather than guessing. If an earlier reply gave a wrong date, correct it using the current server clock before continuing.

When you need data, call the provided tools directly (do NOT write pseudo function_calls markup). Always call tools rather than describing them.

Keep the conversation short and easy to follow, reflecting the focus-group feedback about intrusive questions and excessive scrolling:
- First identify the rider's goal. Answer general questions and questions about a named provider without requiring a trip intake, age, disability status, or residence first. Ask for the provider name only if it is missing and cannot be resolved from the conversation.
- For an actual trip search, collect only the missing pickup, destination, travel date, departure time, trip type, age range, and city of residence. Briefly explain why a sensitive detail is needed when first asking; do not repeat the full privacy notice on every turn.
- Ask one short question at a time, or at most two closely related questions. Do not present a long intake checklist. Acknowledge a selection briefly and move to the next missing detail.
- Reuse information from this message, prior turns, selected addresses, age choices, and explicit yes/no answers. Do not ask the rider to type an address or age again after a selection. If a detail conflicts, clarify only that detail.
- Ask whether a return trip is needed only when the trip type is unknown. For a one-way trip, omit return_time and never ask for a return time. For a round trip, ask for the return time only if it is missing. Do not invent one to complete a tool call.
- Do not ask for the rider's name, phone number, email, separate home address, gate codes, driver instructions, payment details, or preferred booking style as part of service discovery. A pickup address and city of residence are sufficient for location matching; the pickup need not be the rider's home. If asked how to book, provide the provider's recorded contact details and instructions rather than collecting a reservation on its behalf.
- Do not routinely ask about companions, attendants, wheelchairs, walkers, canes, or other mobility aids. Respond to needs the rider volunteers. Ask a focused follow-up only if verified provider data makes that detail necessary to answer the rider's accessibility question; unknown accessibility must remain subject to provider confirmation.
- Once the required search details are available, search and assess the candidates without adding optional questions as a barrier. For conditional eligibility, use the assessment's next_question when available, skip facts already answered or declined, and retain uncertain options for provider verification. Never treat a refusal as No or repeatedly pressure the rider to disclose it.

Do not proactively ask about service animals, pets, or other animals, including through ask_yes_no. Animal information is not a required trip detail or an eligibility filter. If the rider volunteers an animal-related need or asks about an animal policy, respond to that specific concern using verified provider information only. If the policy is unavailable, explain that it needs confirmation directly with the provider; do not invent restrictions or exclude providers because animal information is absent or declined.

When you get the trip information, summarize the trip including:
1. The best provider recommendations based on location, service hours, and your reasoning over each provider's eligibility requirements.
2. Public transit routing options (if available).
3. Pickup and destination addresses.
4. If a provider was filtered out due to service hours, mention that some providers may not operate at the requested times.
5. Show the provider-specific booking notice and separate initial application processing requirements. If either is unknown, direct the rider to confirm it with the provider.
6. Preserve the rider's requested dates and times exactly in searches and summaries. Do not automatically add a 30-minute buffer or change pickup, appointment, or return times. If the rider asks for arrival planning, explain any suggested allowance separately as a suggestion, using verified information, and ask before changing the requested time.
7. For each recommended provider, include the eligibility reason and any proof/application step shown in the provider data.
Format it concisely.

An age range (or a voluntarily supplied exact age) and city of residence are needed for trip searches. For other facts, ask only for information that
changes at least one candidate's eligibility, and never ask about ADA approval. Reuse known rider facts from prior turns.
If the rider already provided the information, do not ask again.

If a provider-specific question has no identifiable provider, ask for its name. If it is already named or unambiguous from the conversation, use it directly without asking again.

Never display raw JSON, internal field names, record IDs, database timestamps, import notes, or map geometry in rider-facing answers. Explain the relevant service facts in plain language. A provider record is not proof that you have checked its website; only claim an official source was checked when a tool actually retrieved supporting evidence. If application information is missing, say that you cannot confirm it and suggest contacting the provider, rather than claiming the website has no application requirement.
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
    const addressData = attachment.data as { role?: string; query?: string } | undefined;
    const key = attachment.type === 'address_search'
      ? `${attachment.type}:${addressData?.role || addressData?.query || toolName}`
      : `${attachment.type}:${toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.unshift(attachment);
  }

  return compacted;
}

function sanitizeAttachmentForChat(attachment: Attachment): Attachment {
  if (attachment.type === 'provider_info') return { ...attachment, data: riderProviderDetails(attachment.data) };
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

export function buildNoProviderResponse(providerSearch: Record<string, unknown>): string | null {
  if (Array.isArray(providerSearch.verification_required) && providerSearch.verification_required.length) return null;
  if (providerSearch.status === 'awaiting_eligibility_assessment') {
    const candidates = Array.isArray(providerSearch.candidates) ? providerSearch.candidates : [];
    // If candidates exist, the model still owes the required assessment; do not misreport them as
    // a geographic failure. The tool error in the next iteration tells it exactly what to finish.
    if (candidates.length > 0) return null;
  }
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

  const eligibilityExcluded = Array.isArray(providerSearch.excluded_providers) && providerSearch.excluded_providers.length > 0;
  const lines = [
    eligibilityExcluded ? "No providers matched this trip after applying the rider eligibility requirements."
      : "I couldn't find any providers in our current data that serve both ends of this trip at the requested times.",
    '',
    `Pickup: ${sourceAddress}`,
    `Destination: ${destinationAddress}`,
  ];

  if (hasPublicTransit) {
    lines.push('', 'Public transit routing may still be available for this trip. Open the results to review the transit option.');
  }

  lines.push('', eligibilityExcluded
    ? 'Providers were excluded by eligibility requirements; this does not mean their service areas miss the trip.'
    : 'No provider remained after checking both addresses and service hours.');

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

  const body = req.body as { conversation_id?: string; message?: string; age_range?: unknown; yes_no_answer?: unknown } | null;
  if (!body?.conversation_id || !body?.message) {
    return errorResponse('Missing required fields: conversation_id and message', 400, req.origin);
  }
  if (typeof body.message !== 'string' || Buffer.byteLength(body.message, 'utf8') > 16_000) {
    return errorResponse('Please shorten your message to the trip details and rider information.', 400, req.origin);
  }
  if (body.age_range !== undefined && !getAgeRange(body.age_range)) {
    return errorResponse('Please select a valid age range.', 400, req.origin);
  }

  const googleMapsApiKey = 'aws-location';

  // Verify conversation exists
  const conversation = await queryOne(
    `SELECT id FROM ${TABLES.CONVERSATIONS} WHERE id = $1`, [body.conversation_id]
  );
  if (!conversation) {
    return errorResponse('Conversation not found', 404, req.origin);
  }

  const turn = await loadTurnContext(body.conversation_id);
  if (body.yes_no_answer !== undefined) {
    const answer = applyBinaryAnswer(turn, body.yes_no_answer);
    if (!answer) return errorResponse('Please choose an answer to a question in this conversation.', 400, req.origin);
    body.message = `Question: ${answer.question} Answer: ${YES_NO_OPTIONS.find(option => option.value === answer.answer)!.label}.`;
  }
  if (body.yes_no_answer === undefined) applyTypedBinaryAnswer(turn, body.message);
  applyUserDestination(turn, body.message);
  const selectedAgeRange = getAgeRange(body.age_range)?.id || ageRangeFromMessage(body.message);
  if (selectedAgeRange) turn.riderEligibility = mergeAgeFacts(turn.riderEligibility, { age_range: selectedAgeRange });
  else {
    const exactAge = exactAgeFromMessage(body.message);
    if (exactAge !== null) turn.riderEligibility = mergeAgeFacts(turn.riderEligibility, { age: exactAge });
  }
  const systemPrompt = `${SYSTEM_PROMPT}\n\n${buildCurrentTimeBlock()}\n\n${buildRiderFactsBlock(turn.riderEligibility)}\n${binaryFactsBlock(turn)}\nDestination verification state: ${JSON.stringify(turn.destinationVerification || null)}. If pending or verified, do not search providers until the rider confirms a destination. Present candidate choices or allow manual address entry. Only user_provided state records rider confirmation.`;

  // Load conversation history
  const existingMessages = await queryRows(
    `SELECT role, content FROM ${TABLES.MESSAGES}
     WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [body.conversation_id]
  );

  turn.locationMessages = [...existingMessages.filter(message => message.role === 'user' || message.role === 'human').map(message => String(message.content || '')), body.message];

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
  let currentMessages: any[] = [];
  let iterations = 0;
  let finalResponse = '';
  let contextLimited = false;
  let searchedThisTurn = false;

  try {
    currentMessages = convertMessagesToBedrockFormat(boundConversationHistory(messageHistory));
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const modelRequest = {
        modelId: BEDROCK_MODEL_ID,
        system: [{ text: systemPrompt }],
        messages: currentMessages,
        toolConfig: { tools: bedrockTools as any },
        inferenceConfig: { maxTokens: Number(process.env.CHAT_MAX_TOKENS || 4000) },
      };
      assertModelRequestBudget(modelRequest);
      const command = new ConverseCommand(modelRequest);

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
        if (toolUse.name === 'find_providers' || toolUse.name === 'assess_eligibility') searchedThisTurn = true;
        console.log(`Executing tool: ${toolUse.name}`, toolUse.input);

        const result: ToolResult = await executeTool(toolUse.name, toolUse.input, googleMapsApiKey, turn);
        await storeToolCall(body.conversation_id, toolUse.name, toolUse.input, result);

        // Build attachment
        if (result.success && result.data) {
          const typeMap: Record<string, string> = {
            find_providers: 'provider_search',
            assess_eligibility: 'provider_search',
            search_addresses_from_user_query: 'address_search',
            verify_destination_address: 'address_search',
            get_provider_info: 'provider_info',
            general_provider_question: 'web_search',
            ask_age_range: 'age_choices',
          };
          if (toolUse.name !== 'ask_age_range' || !ageBounds(turn.riderEligibility)) attachments.push({
            type: typeMap[toolUse.name] || 'tool_result',
            data: result.data,
            metadata: { tool_name: toolUse.name, tool_use_id: toolUse.toolUseId, conversation_id: body.conversation_id },
          });
        }

        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            content: [{ text: serializeToolResultForModel(result.success ? result.data : { error: result.error }) }],
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
  } catch (error) {
    if (!(error instanceof ModelContextLimitError)) throw error;
    contextLimited = true;
    finalResponse = 'There are too many search details to assess safely in one response. Please narrow the trip details or ask about a specific provider. I have not completed provider eligibility verification.';
  }

  // Do not expose incomplete candidates as recommendations after hitting a budget.
  const binaryQuestions = contextLimited ? [] : attachments.flatMap(item => {
    if (item.metadata?.tool_name !== 'ask_yes_no') return [];
    return ((item.data as { questions?: { question: string }[] }).questions || []).flatMap(item => {
      const question = registerQuestion(turn, item.question);
      return question ? [question] : [];
    });
  });
  const responseAttachments = contextLimited ? [] : compactAttachments(attachments.filter(item => item.metadata?.tool_name !== 'ask_yes_no'));
  const providerSearch = getProviderSearchData(responseAttachments);
  const noProviderResponse = providerSearch ? buildNoProviderResponse(providerSearch) : null;
  if (noProviderResponse) {
    finalResponse = noProviderResponse;
  }
  if (searchedThisTurn) finalResponse = requiredRiderQuestion(turn.riderEligibility) || finalResponse;
  // A failed provider tool call still needs usable age buttons. Also cover a
  // model asking the age question in prose without calling ask_age_range.
  const asksAge = /(?:which|what|your|select|choose|share|provide|tell me|how old)[^.!?\n]{0,90}\b(?:age|old)\b|\bage[^.!?\n]{0,40}(?:range|group|band|\?)/i.test(finalResponse);
  if (!ageBounds(turn.riderEligibility) && !turn.riderEligibility.declined &&
      (searchedThisTurn || asksAge) && !responseAttachments.some(item => item.type === 'age_choices')) {
    responseAttachments.push({ type: 'age_choices', data: ageChoiceData() });
  }
  if (!finalResponse.trim() && responseAttachments.some(item => item.type === 'age_choices')) finalResponse = AGE_RANGE_QUESTION;
  if (!contextLimited && turn.destinationVerification?.status === 'pending' &&
      (searchedThisTurn || responseAttachments.some(item => item.type === 'address_search'))) {
    for (let i = responseAttachments.length - 1; i >= 0; i--) {
      if (responseAttachments[i].type === 'age_choices') responseAttachments.splice(i, 1);
    }
    const hasCandidates = responseAttachments.some(item => item.type === 'address_search' && (item.data as { status?: string })?.status === 'confirmation_required');
    finalResponse = hasCandidates ? 'I found some possible locations. Please choose the address that matches your destination. If none is right, select None of these — enter an address. These matches do not confirm the exact department or building.' : 'I could not find a specific destination address. Select Enter an address to provide it. You can check your appointment notice if you are unsure.';
  }
  const officialDestination = responseAttachments.some(item => item.type === 'address_search' && (item.data as { status?: string })?.status === 'verified');
  if (!contextLimited && officialDestination && turn.destinationVerification?.status === 'verified') {
    finalResponse = 'I found an official destination address and matched it on the map. Please check the department and building against your appointment details, then select Use as destination to confirm.';
  }
  if (!contextLimited) {
    for (const question of turn.binaryQuestions || []) {
      if (question.answer) finalResponse = finalResponse.split(question.question).join('');
    }
    const questions = [...new Map([...binaryQuestions, ...questionsFromText(turn, finalResponse)].map(question => [question.id, question])).values()];
    if (questions.length) {
      responseAttachments.push({ type: 'yes_no_choices', data: { questions, options: YES_NO_OPTIONS } });
    }
    if (!finalResponse.trim()) finalResponse = questions.length ? 'Please choose an answer below.' : 'Please share any remaining trip details.';
  }
  finalResponse = softenEligibilityClaims(finalResponse);
  await saveTurnContext(body.conversation_id, turn);

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

  return jsonResponse({ message: finalResponse, attachments: responseAttachments, age_range: turn.riderEligibility.age_range || null, binary_answers: (turn.binaryQuestions || []).filter(question => question.answer) }, 200, req.origin);
});
