#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5180/';
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const textarea = page.locator('textarea[placeholder="Type your message..."]');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[placeholder="Type your message..."]');
    return input && !input.disabled;
  }, null, { timeout: 30_000 });

  await textarea.fill("I'm 68 and live in Richmond. I need a one-way ride from Richmond City Hall to Kaiser Richmond on July 21, 2026, departing at noon. I'm not disabled, not ADA-certified, and not a veteran.");
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.chat-markdown').filter({ hasText: 'R-Transit' }).last().waitFor({ timeout: 60_000 });

  const publicTransitCard = page.locator('[data-provider-kind="public-transit"]');
  await publicTransitCard.waitFor({ state: 'visible', timeout: 10_000 });
  await publicTransitCard.getByRole('button', { name: 'Show route' }).click();
  await page.locator('.public-transit-route').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('transit-route-summary').waitFor({ state: 'visible', timeout: 10_000 });

  const cardText = await publicTransitCard.innerText();
  assert.match(cardText, /Hide route/);
  assert.match(cardText, /Route steps/i);
  assert.match(await page.locator('[aria-label="Provider results count"]').innerText(), /Includes public transit/);

  await page.waitForTimeout(1_500);
  await page.screenshot({
    path: 'tests/chat/rendered/07-public-transit-provider-route-after.png',
    fullPage: true,
  });

  console.log(JSON.stringify({
    public_transit_is_provider_result: true,
    route_polyline_visible: true,
    route_summary_visible: true,
    route_toggle_selected: true,
  }, null, 2));
} finally {
  await browser.close();
}
