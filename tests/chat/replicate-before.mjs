#!/usr/bin/env node

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const envPath = new URL('../../.env', import.meta.url);
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  db: { schema: 'optimat' },
});

const conversations = {
  relativeDate: 'a8b13038-f96c-497c-a3f5-05ec24b5cc1a',
  oneWayAndRichmond: '6f4c2981-4812-4e8c-be8d-389e7c638583',
  eligibilityAndPlace: '8d6a7a83-b0ec-4653-b676-a25416fcfe12',
  richmondDate: '0bca3f58-84a1-4fb6-935a-28069b41e836',
};

async function messagesFor(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role,content,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function providerCallsFor(conversationId) {
  const { data, error } = await supabase
    .from('find_providers_calls')
    .select('provider_data,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

function findContent(messages, pattern) {
  return messages.find((message) => pattern.test(message.content || ''))?.content || '';
}

const dateMessages = await messagesFor(conversations.relativeDate);
const oneWayMessages = await messagesFor(conversations.oneWayAndRichmond);
const eligibilityMessages = await messagesFor(conversations.eligibilityAndPlace);
const richmondDateMessages = await messagesFor(conversations.richmondDate);
const richmondCalls = await providerCallsFor(conversations.oneWayAndRichmond);

const tomorrowResponse = findContent(dateMessages, /tomorrow \(July 20th\)/i);
assert.match(tomorrowResponse, /tomorrow \(July 20th\)/i);

const fakeReturnResponse = findContent(oneWayMessages, /do need a return time for the search/i);
assert.match(fakeReturnResponse, /placeholder/i);

const vagueNoResultResponse = findContent(
  oneWayMessages,
  /no provider service area matched both addresses after geocoding and service-hour filtering/i,
);
assert.match(vagueNoResultResponse, /service-hour filtering/i);

const ineligibleResponse = findContent(eligibilityMessages, /I found 2 providers.*December 20th/is);
assert.match(ineligibleResponse, /One-Seat Regional Ride/i);
assert.match(ineligibleResponse, /Mobility Matters/i);
assert.match(ineligibleResponse, /December 20th/i);

const pseudoBookingResponse = findContent(eligibilityMessages, /To complete your booking/i);
assert.match(pseudoBookingResponse, /Your name/i);
assert.match(pseudoBookingResponse, /Your phone number/i);

const dvcCorrectionIndex = eligibilityMessages.findIndex((message) =>
  /DVC is actually in Pleasant Hill|Diablo Valley College is actually in Pleasant Hill/i.test(message.content || ''),
);
const providerRecommendationIndex = eligibilityMessages.findIndex((message) =>
  /I found 2 providers that can serve your trip/i.test(message.content || ''),
);
assert.ok(providerRecommendationIndex >= 0 && dvcCorrectionIndex > providerRecommendationIndex);

const wrongYearResponse = findContent(richmondDateMessages, /July 21, 2025/i);
assert.match(wrongYearResponse, /July 21, 2025/i);

const richmondProviderCalls = richmondCalls.filter((call) => {
  const providers = call.provider_data?.data || [];
  return providers.some((provider) => provider.provider_name === 'R-Transit (Richmond)');
});
assert.ok(richmondProviderCalls.length >= 4);

const largestRichmondPayload = Math.max(
  ...richmondProviderCalls.map((call) => JSON.stringify(call.provider_data).length),
);
assert.ok(largestRichmondPayload > 400_000);

const firstRichmondTime = oneWayMessages.findIndex((message) => /noon and returning at 3pm/i.test(message.content || ''));
const nextAssistant = oneWayMessages.slice(firstRichmondTime + 1).find((message) => message.role === 'assistant');
assert.ok(nextAssistant && /Just to clarify/i.test(nextAssistant.content));
assert.ok(
  oneWayMessages
    .slice(firstRichmondTime + 1)
    .filter((message) => message.role === 'user').length >= 3,
);

const replicated = [
  ['Relative date drift', '“tomorrow” became July 20 on July 9'],
  ['One-way blocked', 'assistant required a fake return time'],
  ['Wrong zero-result reason', 'geography and service hours were conflated'],
  ['Eligibility leak', 'general resident was shown two restricted providers'],
  ['Invented date', 'December 20 appeared without user input'],
  ['Pseudo-booking', 'assistant requested name/address/phone'],
  ['Late place correction', 'DVC/Pleasant Hill correction happened after recommendations'],
  ['Wrong year', 'July 21 was interpreted as 2025'],
  ['Richmond hang', `${richmondProviderCalls.length} searches produced a largest tool payload of ${largestRichmondPayload.toLocaleString()} characters`],
];

console.log('Replicated reported production failures from the July 9 chat records:\n');
for (const [name, evidence] of replicated) {
  console.log(`- ${name}: ${evidence}`);
}

