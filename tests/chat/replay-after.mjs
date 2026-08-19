#!/usr/bin/env node

import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const baseUrl = `${env.VITE_SUPABASE_URL}/functions/v1`;
const headers = {
  apikey: env.VITE_SUPABASE_ANON_KEY,
  authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`,
  'content-type': 'application/json',
};

async function invoke(functionName, body, timeoutMs = 60_000) {
  const response = await fetch(`${baseUrl}/${functionName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${functionName} returned ${response.status}: ${data?.error || text}`);
  return data;
}

async function createConversation(title) {
  const data = await invoke('conversations', { title }, 20_000);
  if (!data?.id) throw new Error(`Conversation creation returned no id for ${title}`);
  return data.id;
}

function attachmentSummary(attachments = []) {
  return attachments.map((attachment) => {
    const data = attachment?.data || {};
    return {
      tool: attachment?.metadata?.tool_name || attachment?.type,
      status: data.status || null,
      travel_date: data.travel_date || null,
      trip_type: data.trip_type || null,
      return_time: data.return_time ?? null,
      total_found: data.total_found ?? null,
      diagnostics: data.diagnostics || null,
      excluded_provider_names: Array.isArray(data.excluded_providers)
        ? data.excluded_providers.map((provider) => provider.provider_name)
        : [],
      serialized_bytes: JSON.stringify(data).length,
    };
  });
}

async function runTurn(conversationId, prompt) {
  const startedAt = Date.now();
  const data = await invoke('chat', { conversation_id: conversationId, message: prompt });
  return {
    prompt,
    response: data?.message || data?.response || '',
    elapsed_ms: Date.now() - startedAt,
    attachments: attachmentSummary(data?.attachments || []),
  };
}

const scenarios = [
  {
    key: 'relative_date_and_one_way',
    prompts: [
      "I need a one-way ride from Walnut Creek City Hall to Kaiser Walnut Creek tomorrow. I need to depart at noon. I'm 42, have ADA paratransit eligibility, am not a veteran, and live in Walnut Creek.",
    ],
  },
  {
    key: 'cross_service_area',
    prompts: [
      "I have ADA paratransit eligibility and need a ride from Walnut Creek to San Francisco.",
    ],
  },
  {
    key: 'missing_date',
    prompts: [
      "I am 35, not disabled, without ADA paratransit eligibility, not a veteran, and I live in Bay Point. I need a one-way ride from Bay Point to Antioch at noon.",
    ],
  },
  {
    key: 'dvc_city_mismatch',
    prompts: [
      "I'm a general resident of Bay Point, age 35, not disabled, without ADA paratransit eligibility, and not a veteran. I need a one-way ride from Bay Point to DVC in Antioch.",
    ],
  },
  {
    key: 'general_resident_eligibility',
    prompts: [
      "I'm a general resident of Bay Point, age 35, not disabled, without ADA paratransit eligibility, and not a veteran. I need a one-way ride from Bay Point to Antioch on July 21, 2026, departing at noon.",
    ],
  },
  {
    key: 'richmond_and_handoff',
    prompts: [
      "I'm 68 and live in Richmond. I need a one-way ride from Richmond City Hall to Kaiser Richmond on July 21, 2026, departing at noon. I'm not disabled, without ADA paratransit eligibility, and not a veteran.",
      "I want R-Transit. How do I book it?",
    ],
  },
];

const results = [];
for (const scenario of scenarios) {
  const conversationId = await createConversation(`Codex regression after: ${scenario.key}`);
  const turns = [];
  for (const prompt of scenario.prompts) {
    const turn = await runTurn(conversationId, prompt);
    turns.push(turn);
    console.log(JSON.stringify({ scenario: scenario.key, conversation_id: conversationId, ...turn }));
  }
  results.push({ scenario: scenario.key, conversation_id: conversationId, turns });
}

console.log(JSON.stringify({ complete: true, scenario_count: results.length }));
