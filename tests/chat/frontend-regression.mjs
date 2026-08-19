#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ headless: true });

async function openReadyPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const textarea = page.locator('textarea[placeholder="Type your message..."]');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[placeholder="Type your message..."]');
    return input && !input.disabled && document.activeElement === input;
  }, null, { timeout: 30_000 });
  return { page, textarea };
}

const results = {};

try {
  {
    const { page, textarea } = await openReadyPage();
    await textarea.fill("I have ADA paratransit eligibility and need a ride from Walnut Creek to San Francisco.");
    await page.getByRole('button', { name: 'Send message' }).click();
    const stopButton = page.getByRole('button', { name: 'Stop generating response' });
    await stopButton.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await textarea.isEnabled(), true, 'composer must remain enabled while waiting');
    await textarea.fill('Draft preserved while waiting');
    await stopButton.click();
    await page.getByText('Response stopped. You can edit or send another message.').waitFor({ timeout: 5_000 });
    assert.equal(await textarea.inputValue(), 'Draft preserved while waiting');
    assert.equal(await textarea.evaluate((element) => document.activeElement === element), true);
    results.cancel = {
      stop_button_visible: true,
      composer_enabled_while_waiting: true,
      draft_preserved: true,
      focus_restored: true,
    };
    await page.close();
  }

  {
    const { page, textarea } = await openReadyPage();
    await textarea.fill('I want a ride from Bay Point to DVC in Antioch.');
    await page.getByRole('button', { name: 'Send message' }).click();

    const pausedSearch = page.locator('[aria-label="Provider search status"][data-provider-search-state="paused"]');
    await pausedSearch.waitFor({ state: 'visible', timeout: 60_000 });
    assert.match(await pausedSearch.innerText(), /Provider search needs confirmation/);
    assert.match(await pausedSearch.innerText(), /Action required/);
    assert.equal(await page.locator('[aria-label="Provider search results"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Open results' }).count(), 0);

    await textarea.fill('The address is 321 Golf Club Rd, Pleasant Hill, CA 94523.');
    await page.getByRole('button', { name: 'Send message' }).click();

    const activeSearch = page.locator('[aria-label="Provider search status"][data-provider-search-state="in_progress"]');
    await activeSearch.waitFor({ state: 'visible', timeout: 60_000 });
    assert.match(await activeSearch.innerText(), /Provider search in progress/);
    assert.match(await activeSearch.innerText(), /Waiting for details/);
    assert.equal(await page.locator('[aria-label="Provider search results"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Open results' }).count(), 0);
    await page.locator('.chat-messages').screenshot({
      path: 'tests/chat/rendered/05-provider-search-progress-after.png',
    });
    await activeSearch.locator('xpath=../..').screenshot({
      path: 'tests/chat/rendered/06-provider-search-in-progress-widget-after.png',
    });
    results.provider_search_states = {
      clarification_uses_paused_widget: true,
      coverage_uses_in_progress_widget: true,
      incomplete_search_has_no_results_control: true,
    };
    await page.close();
  }

  {
    const { page, textarea } = await openReadyPage();
    await textarea.fill("I have ADA paratransit eligibility and need a ride from Walnut Creek to San Francisco.");
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Stop generating response' }).waitFor({ timeout: 5_000 });
    await page.getByText('Active conversation', { exact: true }).click();
    const response = page.locator('.chat-markdown').filter({ hasText: 'coverage constraint' }).last();
    await response.waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await textarea.evaluate((element) => document.activeElement === element), false);
    results.intentional_click_out = {
      focus_not_stolen_after_outside_click: true,
    };
    await page.close();
  }

  {
    const { page, textarea } = await openReadyPage();
    await textarea.fill("I have ADA paratransit eligibility and need a ride from Walnut Creek to San Francisco.");
    await page.getByRole('button', { name: 'Send message' }).click();
    const response = page.locator('.chat-markdown').filter({ hasText: 'coverage constraint' }).last();
    await response.waitFor({ state: 'visible', timeout: 60_000 });
    const responseText = await response.innerText();
    assert.match(responseText, /Changing the date or time will not fix this coverage constraint/);
    assert.doesNotMatch(responseText, /return time for the search/i);
    assert.equal(await textarea.evaluate((element) => document.activeElement === element), true);
    results.success_focus = {
      focus_restored_after_response: true,
      no_fake_return_request: true,
    };
    await page.close();
  }

  {
    const { page, textarea } = await openReadyPage();
    await textarea.fill("I'm 68 and live in Richmond. I need a one-way ride from Richmond City Hall to Kaiser Richmond on July 21, 2026, departing at noon. I'm not disabled, without ADA paratransit eligibility, and not a veteran.");
    await page.getByRole('button', { name: 'Send message' }).click();
    const response = page.locator('.chat-markdown').filter({ hasText: 'R-Transit' }).last();
    await response.waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await textarea.evaluate((element) => document.activeElement === element), true);

    const telephoneLinks = await response.locator('a[href^="tel:"]').count();
    const emailLinks = await response.locator('a[href^="mailto:"]').count();
    const webLinks = await response.locator('a[href^="https://"]').count();
    assert(telephoneLinks > 0, 'rendered response should contain a telephone link');
    assert(emailLinks > 0, 'rendered response should contain an email link');
    assert(webLinks > 0, 'rendered response should contain an HTTPS link');
    await page.locator('[aria-label="Provider search results"]').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('button', { name: 'Open results' }).waitFor({ state: 'visible', timeout: 5_000 });

    const publicTransitCard = page.locator('[data-provider-kind="public-transit"]');
    await publicTransitCard.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(await publicTransitCard.innerText(), /Public Transit/);
    assert.match(await publicTransitCard.innerText(), /Fixed-route itinerary/i);
    await publicTransitCard.getByRole('link', { name: 'Open in Google Maps' }).waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('[aria-label="Provider results count"]').innerText(), /Includes public transit/);

    await publicTransitCard.getByRole('button', { name: 'Show route' }).click();
    await page.locator('.public-transit-route').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('transit-route-summary').waitFor({ state: 'visible', timeout: 10_000 });
    await publicTransitCard.getByRole('button', { name: 'Hide route' }).waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForTimeout(1_500);
    await page.screenshot({
      path: 'tests/chat/rendered/07-public-transit-provider-route-after.png',
      fullPage: true,
    });
    results.contacts = {
      telephone_links: telephoneLinks,
      email_links: emailLinks,
      web_links: webLinks,
      focus_restored_after_response: true,
      completed_search_uses_results_widget: true,
      public_transit_is_provider_result: true,
      public_transit_route_drawn_on_map: true,
      public_transit_google_maps_handoff: true,
    };
    await page.close();
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
