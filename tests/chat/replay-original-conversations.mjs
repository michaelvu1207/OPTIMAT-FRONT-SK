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

const originals = [
  { key: 'walnut-creek-concord-date', id: 'a8b13038-f96c-497c-a3f5-05ec24b5cc1a' },
  { key: 'sf-richmond-public-transit', id: '6f4c2981-4812-4e8c-be8d-389e7c638583' },
  { key: 'bay-point-dvc-eligibility', id: '8d6a7a83-b0ec-4653-b676-a25416fcfe12' },
  { key: 'richmond-weekend-date', id: '0bca3f58-84a1-4fb6-935a-28069b41e836' },
];

async function request(functionName, options = {}) {
  const url = new URL(`${baseUrl}/${functionName}`);
  for (const [key, value] of Object.entries(options.params || {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 90_000),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;
  if (!response.ok) throw new Error(`${functionName} returned ${response.status}: ${data?.error || raw}`);
  return data;
}

async function originalTesterMessages(conversationId) {
  const payload = await request('messages', {
    params: { conversation_id: conversationId, limit: '200' },
    timeoutMs: 20_000,
  });
  return (payload.messages || [])
    .filter((message) => message.role === 'user' || message.role === 'human')
    .map((message) => message.content);
}

async function replayConversation(original) {
  const testerMessages = await originalTesterMessages(original.id);
  const created = await request('conversations', {
    method: 'POST',
    body: { title: `Full tester replay after fixes: ${original.key} [${original.id}]` },
    timeoutMs: 20_000,
  });
  const afterId = created.id;
  if (!afterId) throw new Error(`No new conversation id for ${original.id}`);

  let completed = 0;
  const turns = [];
  for (const [index, message] of testerMessages.entries()) {
    const startedAt = Date.now();
    try {
      const response = await request('chat', {
        method: 'POST',
        body: { conversation_id: afterId, message },
      });
      const result = {
        turn: index + 1,
        ok: true,
        elapsed_ms: Date.now() - startedAt,
        response_chars: String(response?.message || response?.response || '').length,
      };
      turns.push(result);
      completed += 1;
      console.log(JSON.stringify({ key: original.key, original_id: original.id, after_id: afterId, ...result }));
    } catch (error) {
      const result = {
        turn: index + 1,
        ok: false,
        elapsed_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      turns.push(result);
      console.log(JSON.stringify({ key: original.key, original_id: original.id, after_id: afterId, ...result }));
    }
  }

  return {
    key: original.key,
    original_id: original.id,
    after_id: afterId,
    tester_turns: testerMessages.length,
    completed_turns: completed,
    failed_turns: testerMessages.length - completed,
    turns,
  };
}

const requestedKeys = new Set(process.argv.slice(2));
const selectedOriginals = requestedKeys.size > 0
  ? originals.filter((original) => requestedKeys.has(original.key))
  : originals;
if (selectedOriginals.length === 0) {
  throw new Error(`No matching replay keys. Available keys: ${originals.map((original) => original.key).join(', ')}`);
}

const replays = await Promise.all(selectedOriginals.map(replayConversation));
console.log(JSON.stringify({ complete: true, replays }));
