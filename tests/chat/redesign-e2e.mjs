#!/usr/bin/env node
/**
 * End-to-end check of the chat redesign through the real UI.
 *
 * Covers the four things the redesign changed, in a browser against the deployed edge function:
 *   1. a senior with an exact age gets providers rendered, not a blank panel
 *   2. a follow-up about the previous search is answered from memory (no second search)
 *   3. a trip nothing can serve explains why and offers alternatives
 *   4. no message contradicts itself on provider counts or claims to book
 *
 * Usage: node tests/chat/redesign-e2e.mjs [baseUrl]
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/';
const SHOTS = 'tests/chat/rendered';
mkdirSync(SHOTS, { recursive: true });

const BOOKING_CLAIM = /\b(i'?ll book|i will book|i'?ve booked|i'?ve scheduled|your ride is (booked|scheduled|confirmed))\b/i;
const NUMBER_WORDS = { no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function unqualifiedProviderCounts(text) {
  const counts = [];
  const pattern = /\b(\d{1,3}|no|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more\s+|additional\s+|other\s+|direct\s+|transportation\s+)*provider/gi;
  for (const match of text.matchAll(pattern)) {
    if (/\b(more|additional|other)\b/i.test(match[0])) continue;
    const token = match[1].toLowerCase();
    const value = token in NUMBER_WORDS ? NUMBER_WORDS[token] : Number(token);
    if (Number.isFinite(value)) counts.push({ value, phrase: match[0].trim() });
  }
  return counts;
}

const browser = await chromium.launch({ headless: true });
const results = [];

async function openChat() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const chatResponses = [];
  page.on('response', async (response) => {
    if (!response.url().includes('/functions/v1/chat')) return;
    try {
      chatResponses.push({ status: response.status(), body: await response.json() });
    } catch { /* non-JSON body */ }
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const textarea = page.locator('textarea[placeholder="Type your message..."]');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[placeholder="Type your message..."]');
    return input && !input.disabled;
  }, null, { timeout: 30_000 });
  return { page, textarea, chatResponses };
}

async function send(page, textarea, message, expectedResponses) {
  await textarea.fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(
    (count) => window.__chatTurnCount === undefined || true,
    expectedResponses,
    { timeout: 1_000 },
  ).catch(() => {});
  return message;
}

async function waitForTurn(chatResponses, count) {
  const deadline = Date.now() + 180_000;
  while (chatResponses.length < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for assistant turn ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const turn = chatResponses[count - 1];
  if (turn.status !== 200) throw new Error(`Chat turn ${count} returned ${turn.status}`);
  return turn.body;
}

function check(name, condition, detail) {
  results.push({ name, passed: Boolean(condition), detail: condition ? '' : detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition ? '' : ` — ${detail}`}`);
}

function assertHygiene(label, message) {
  check(`${label}: no booking claim`, !BOOKING_CLAIM.test(message), `claimed to book: ${(message.match(BOOKING_CLAIM) || [])[0]}`);
  const counts = unqualifiedProviderCounts(message);
  const distinct = [...new Set(counts.map((count) => count.value))];
  check(
    `${label}: one provider total, not two`,
    distinct.length <= 1,
    `states ${counts.map((count) => `"${count.phrase}"`).join(' and ')}`,
  );
}

try {
  // ── 1 & 2: results render, then a follow-up is answered from memory ──────
  console.log('\nScenario A — senior finds providers, then asks a follow-up');
  {
    const { page, textarea, chatResponses } = await openChat();

    await send(page, textarea,
      'I need a one-way ride from Richmond City Hall to Kaiser Permanente Richmond Medical Center on August 12, 2026, departing at noon. I am 68, I live in Richmond, not disabled, not ADA-certified, not a veteran.');
    const first = await waitForTurn(chatResponses, 1);

    const search = (first.attachments || []).find((a) => a?.metadata?.tool_name === 'find_providers');
    check('search ran and returned providers', Boolean(search) && (search.data.data || []).length > 0,
      `attachments: ${(first.attachments || []).map((a) => a?.metadata?.tool_name).join(', ') || 'none'}`);
    assertHygiene('turn 1', first.message);

    const providerCards = page.locator('article[data-provider-kind], [aria-label="Provider results count"]');
    await providerCards.first().waitFor({ state: 'visible', timeout: 30_000 });
    check('provider results are rendered in the panel', await providerCards.count() > 0, 'no provider cards visible');

    // The headline count must account for every option the search returned. Counting only the
    // confirmed ones showed "1 provider found" on a trip with three providers pending an
    // eligibility check, which reads as a dead end.
    const expected = (search?.data?.data || []).length +
      (search?.data?.verification_required || []).length +
      (search?.data?.public_transit ? 1 : 0);
    const headline = await page.locator('[aria-label="Provider results count"]').first().innerText().catch(() => '');
    const shown = Number((headline.match(/(\d+)\s+providers?\s+found/i) || [])[1] ?? NaN);
    check(
      'headline count includes providers pending eligibility checks',
      shown === expected,
      `panel says ${shown}, search returned ${expected} (${(search?.data?.data || []).length} eligible + ${(search?.data?.verification_required || []).length} to verify + transit)`,
    );
    await page.screenshot({ path: `${SHOTS}/redesign-01-results.png`, fullPage: true });

    // The follow-up must be answerable from stored state alone.
    await send(page, textarea, 'Which of those still need their eligibility checked, and why?');
    const second = await waitForTurn(chatResponses, 2);
    const secondTools = (second.attachments || []).map((a) => a?.metadata?.tool_name);
    check('follow-up answered without re-running the search', !secondTools.includes('find_providers'),
      `re-ran tools: ${secondTools.join(', ')}`);

    const earlierNames = [
      ...(search?.data?.data || []),
      ...(search?.data?.verification_required || []),
    ].map((provider) => provider.provider_name).filter(Boolean);
    check('follow-up names a provider from the earlier search',
      earlierNames.some((name) => second.message.includes(name)),
      `named none of: ${earlierNames.join(', ')}`);
    assertHygiene('turn 2', second.message);
    await page.screenshot({ path: `${SHOTS}/redesign-02-followup.png`, fullPage: true });
    await page.close();
  }

  // ── 3: a trip nothing can serve explains itself and offers alternatives ──
  console.log('\nScenario B — trip nothing can serve');
  {
    const { page, textarea, chatResponses } = await openChat();
    await send(page, textarea,
      'I need a ride from Diablo Valley College to San Francisco City Hall on August 12, 2026 at 9:00 AM, one way. I am 70, live in Pleasant Hill, not disabled, not ADA-certified, not a veteran.');
    const turn = await waitForTurn(chatResponses, 1);

    const explains = /service area|covers? both|coverage|does not reach|only covers/i.test(turn.message);
    check('names coverage as the binding constraint', explains, `said: ${turn.message.slice(0, 160)}`);

    const offersSomething = /instead|part of the way|public transit|BART|as far as|covers the pickup|covers the destination/i.test(turn.message);
    check('offers an alternative or fallback', offersSomething, `said: ${turn.message.slice(0, 160)}`);
    assertHygiene('no-coverage turn', turn.message);

    const search = (turn.attachments || []).find((a) => a?.metadata?.tool_name === 'find_providers');
    const alternatives = search?.data?.alternatives || [];
    if (alternatives.length > 0) {
      const section = page.locator('article[data-provider-kind="alternative"]');
      await section.first().waitFor({ state: 'visible', timeout: 20_000 });
      check('alternatives render in the panel', await section.count() > 0, 'alternatives returned but not rendered');
    } else {
      console.log('  · no alternatives returned for this trip; panel check skipped');
    }
    await page.screenshot({ path: `${SHOTS}/redesign-03-no-coverage.png`, fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const failure of failed) console.log(`  ✗ ${failure.name} — ${failure.detail}`);
}
console.log(`Screenshots in ${SHOTS}/`);
process.exitCode = failed.length ? 1 : 0;
