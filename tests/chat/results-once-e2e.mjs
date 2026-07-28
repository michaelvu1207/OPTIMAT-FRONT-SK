#!/usr/bin/env node
/**
 * Results embed once, and only once the assistant has what it needs.
 *
 * The trip below matches six providers, none of which can be decided until the rider gives their
 * age. That first reply must be the question alone — no cards. Answering it settles the verdicts,
 * and the cards arrive then, in that message and nowhere else.
 *
 * Usage: node tests/chat/results-once-e2e.mjs [baseUrl]
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/';
const SHOTS = 'tests/chat/rendered';
mkdirSync(SHOTS, { recursive: true });

const TRIP =
  "Hi, I'm planning a trip for next Monday from 2125 Tice Creek Dr in Walnut Creek to " +
  "1990 Market St - Monument Crisis Center in Concord. I'm leaving at 12pm and returning at 3pm";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

// Every provider card carries this control, so counting it counts the cards on screen.
const cards = page.locator('text=Show service area');
const transitCards = page.locator('text=FIXED-ROUTE ITINERARY');
const tripStrips = page.locator('text=Copy trip details');

async function send(text) {
  const textarea = page.locator('textarea[placeholder="Type your message..."]');
  await textarea.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Stop generating response' })
    .waitFor({ state: 'hidden', timeout: 240_000 });
  await page.waitForTimeout(1_000);
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.locator('textarea[placeholder="Type your message..."]')
    .waitFor({ state: 'visible', timeout: 30_000 });

  await send(TRIP);
  await page.screenshot({ path: `${SHOTS}/results-once-question.png` });
  assert.equal(await cards.count(), 0, 'no provider cards while eligibility is still being asked');
  assert.equal(await transitCards.count(), 0, 'no transit card while eligibility is still being asked');
  assert.equal(await tripStrips.count(), 0, 'no trip strip while eligibility is still being asked');
  assert.equal(
    await page.getByTestId('feedback-prompt').count(),
    0,
    'no feedback prompt before the rider has been given an answer'
  );

  await send("I'm 74 and I have a disability.");
  await page.screenshot({ path: `${SHOTS}/results-once-answered.png` });

  const shown = await cards.count();
  assert.ok(shown > 0, 'cards arrive once the answer is settled');
  assert.equal(await tripStrips.count(), 1, 'the trip strip is embedded once');
  assert.ok(await transitCards.count() <= 1, 'the transit card is embedded at most once');
  assert.equal(
    await page.getByTestId('feedback-prompt').count(),
    1,
    'feedback is asked once the recommendations exist'
  );

  // A follow-up that reassesses must move the results, not duplicate them.
  await send('What if I go on Tuesday instead?');
  await page.screenshot({ path: `${SHOTS}/results-once-followup.png` });
  assert.equal(await tripStrips.count(), 1, 'the trip strip is still embedded exactly once');
  assert.ok(await transitCards.count() <= 1, 'the transit card is still embedded at most once');

  console.log(`PASS: question first with no cards, then ${shown} cards embedded once`);
} finally {
  await browser.close();
}
