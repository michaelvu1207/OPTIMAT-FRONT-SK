#!/usr/bin/env node
/**
 * End-to-end check of the chat redesign through the real UI.
 *
 * Covers the four things the redesign changed, in a browser against the deployed edge function:
 *   1. a senior with an exact age gets a card per provider, embedded in the reply
 *   2. a follow-up about the previous search is answered from memory (no second search)
 *   3. a trip nothing can serve explains why and offers alternatives
 *   4. no message contradicts itself on provider counts or claims to book
 *
 * Usage: node tests/chat/redesign-e2e.mjs [baseUrl]
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

/**
 * The attachment carrying rider-facing results.
 *
 * find_providers stops at candidates now; the eligibility verdicts, and so the provider cards,
 * arrive with assess_eligibility. Older recorded transcripts still have them on find_providers.
 */
function resultsAttachment(attachments) {
  const list = attachments || [];
  return list.find((a) => a?.metadata?.tool_name === 'assess_eligibility')
    || list.find((a) => a?.metadata?.tool_name === 'find_providers' && Array.isArray(a?.data?.data));
}


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

/** The welcome dialog covers the page on load; dismiss it before touching the chat. */
async function dismissWelcome(page) {
  const dialog = page.locator('[role="dialog"][aria-labelledby="welcome-title"]');
  // It mounts after the app boots, so wait for it rather than checking too early.
  const appeared = await dialog.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false);
  if (!appeared) return;
  await page.getByRole('button', { name: 'Get started' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
}

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
  await dismissWelcome(page);
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

    const search = resultsAttachment(first.attachments);
    check('search ran and returned providers', Boolean(search) && (search.data.data || []).length > 0,
      `attachments: ${(first.attachments || []).map((a) => a?.metadata?.tool_name).join(', ') || 'none'}`);
    assertHygiene('turn 1', first.message);

    const providerCards = page.locator('.chat-messages article[data-provider-kind="callable"], .chat-messages article[data-provider-kind="verification-required"]');
    await providerCards.first().waitFor({ state: 'visible', timeout: 30_000 });
    check('provider cards are rendered inside the reply', await providerCards.count() > 0, 'no provider cards visible');

    // Every provider the rider would actually phone gets a card: the ones they qualify for and the
    // ones whose eligibility they will settle on the call. None may be dropped by the wording.
    const callable = (search?.data?.data || []).length + (search?.data?.verification_required || []).length;
    const shown = await providerCards.count();
    check(
      'a card for every provider to call, including ones pending eligibility checks',
      shown === callable,
      `${shown} cards for ${callable} callable (${(search?.data?.data || []).length} eligible + ${(search?.data?.verification_required || []).length} to verify)`,
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

    const search = resultsAttachment(turn.attachments);
    const alternatives = search?.data?.alternatives || [];
    if (alternatives.length > 0) {
      // Alternatives are prose now: the reply has to actually say what would work instead.
      const described = alternatives.some((alternative) => {
        const words = String(alternative?.description || '').toLowerCase().match(/[a-z]{5,}/g) || [];
        return words.length > 0 && words.filter((word) => turn.message.toLowerCase().includes(word)).length >= 2;
      });
      check('the reply describes at least one of the alternatives returned', described,
        `alternatives: ${alternatives.map((alternative) => alternative.description).join(' | ').slice(0, 200)}`);
    } else {
      console.log('  · no alternatives returned for this trip; check skipped');
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
