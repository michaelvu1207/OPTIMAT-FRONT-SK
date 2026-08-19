#!/usr/bin/env node
/**
 * The feedback bubble must appear under the assistant's provider recommendations, and only there.
 *
 * Usage: node tests/chat/feedback-prompt-e2e.mjs [baseUrl]
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/';
const SHOTS = 'tests/chat/rendered';
mkdirSync(SHOTS, { recursive: true });

// The submission is real: it lands in optimat.chat_feedback. The marker makes the row findable so
// a test run can be cleaned up afterwards.
const reviewerName = `e2e ${Date.now()}`;
const comment = 'Smoke test: the San Ramon van should be listed.';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Get started' }).click();

  const textarea = page.locator('textarea[placeholder="Type your message..."]');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });

  const prompt = page.getByTestId('feedback-prompt');
  assert.equal(await prompt.count(), 0, 'no feedback bubble before any recommendations');

  await textarea.fill(
    "I'm 72 and have ADA paratransit eligibility. I need a ride tomorrow at 10am from 1350 Treat Blvd, Walnut Creek to 2500 Alhambra Ave, Martinez, one way."
  );
  await page.getByRole('button', { name: 'Send message' }).click();

  // Provider cards mean the assistant has made its recommendations.
  await page.locator('[data-testid="provider-card"], .provider-card').first()
    .waitFor({ state: 'visible', timeout: 180_000 })
    .catch(() => {});
  await prompt.first().waitFor({ state: 'visible', timeout: 180_000 });

  assert.equal(await prompt.count(), 1, 'exactly one feedback bubble');
  await prompt.getByRole('button', { name: 'Give feedback' }).click();
  await prompt.getByLabel('Your name').fill(reviewerName);
  await prompt.getByLabel('Your feedback').fill(comment);
  await page.screenshot({ path: `${SHOTS}/feedback-prompt.png`, fullPage: false });

  await prompt.getByRole('button', { name: 'Submit feedback' }).click();
  await prompt.getByText('your feedback was saved', { exact: false })
    .waitFor({ state: 'visible', timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/feedback-submitted.png`, fullPage: false });

  // The prompt has had its answer: it stays put through the next reply and is not asked again.
  await textarea.fill('What about a return trip at 3pm?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForTimeout(3_000);
  assert.equal(await prompt.count(), 1, 'answered bubble survives the next reply streaming');

  await page.getByRole('button', { name: 'Stop generating response' })
    .waitFor({ state: 'hidden', timeout: 180_000 });
  assert.equal(await prompt.count(), 1, 'feedback is asked once per conversation');
  assert.equal(
    await prompt.getByRole('button', { name: 'Give feedback' }).count(),
    0,
    'the answered bubble does not re-open the form'
  );

  console.log(`PASS: feedback bubble renders, submits, and stays answered (name: ${reviewerName})`);
} finally {
  await browser.close();
}
