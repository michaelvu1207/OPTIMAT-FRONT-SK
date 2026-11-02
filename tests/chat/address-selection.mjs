// Local-only regression; all external API and map requests are stubbed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const first = { name: 'Example Clinic', address: '100 Example Street, Concord, CA 94520', location: { lat: 37.98, lng: -122.01 }, place_type: 'PointOfInterest' };
const second = { name: 'Example Medical Center', address: '200 Example Avenue, Concord, CA 94520', location: { lat: 37.99, lng: -122.02 }, place_type: 'PointOfInterest' };
const road = { name: 'Kaiser Quarry Rd, Concord, CA', address: 'Kaiser Quarry Rd, Concord, CA', place_type: 'Street' };

try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    const requests = [];
    let rejectPickup = true;
    let geocodeRequests = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'address-test', messages: [] } });
      if (url.pathname.endsWith('/geocode')) geocodeRequests++;
      if (url.pathname.endsWith('/chat')) {
        const body = route.request().postDataJSON();
        requests.push(body);
        if (body.message.startsWith('Use ')) {
          await new Promise(resolve => setTimeout(resolve, 150));
          if (body.message.endsWith('as my pickup.') && rejectPickup) {
            rejectPickup = false;
            return route.fulfill({ status: 500, json: { error: 'Selection failed. Please try again.' } });
          }
          return route.fulfill({ json: { message: 'Location confirmed. What date would you like to travel?', attachments: [] } });
        }
        return route.fulfill({ json: { message: 'Choose the correct location.', attachments: [{ type: 'address_search', data: { places: [first, first, second, road] } }] } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await input.fill('Find a medical facility in Concord');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const choice = page.locator('[data-address-choice]').filter({ hasText: second.name });
    await choice.waitFor();
    assert.equal(await page.locator('[data-address-choice]').count(), 3, 'Duplicate results should be removed');
    const roadChoice = page.locator('[data-address-choice]').filter({ hasText: road.address });
    assert.equal(await roadChoice.getByRole('button').count(), 0, 'Road results must not be offered as verified facilities');
    assert.equal(await roadChoice.getByText(road.address, { exact: true }).count(), 1, 'Identical name/address should display once');
    await choice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-address-choices-${viewport.width}.png` });
    await input.fill('Keep my draft');
    const destination = choice.getByRole('button', { name: 'Use as destination', exact: true });
    await destination.focus();
    await page.keyboard.press('Enter');
    await choice.getByRole('button', { name: 'Confirming...', exact: true }).waitFor();
    assert.equal(await choice.getByRole('button', { name: 'Use as pickup', exact: true }).isDisabled(), true);
    await choice.getByRole('button', { name: 'Destination selected', exact: true }).waitFor();
    assert.equal(requests[1].message, `Use ${second.name}, ${second.address} as my destination.`);
    assert.equal(requests[1].conversation_id, 'address-test');
    assert.equal(await input.inputValue(), 'Keep my draft');
    assert.equal(geocodeRequests, 0, 'Selection should reuse returned coordinates');
    if (viewport.width > 1024) await page.locator('.leaflet-marker-icon').first().waitFor();

    const pickup = choice.getByRole('button', { name: 'Use as pickup', exact: true });
    await pickup.click();
    await page.getByRole('alert').filter({ hasText: 'Selection failed' }).waitFor();
    assert.equal(await choice.getByRole('button', { name: 'Pickup selected', exact: true }).count(), 0);
    assert.equal(await pickup.isEnabled(), true, 'Failed selection must remain retryable');
    await pickup.click();
    await choice.getByRole('button', { name: 'Pickup selected', exact: true }).waitFor();
    assert.equal(requests.at(-1).message, `Use ${second.name}, ${second.address} as my pickup.`);
    assert.equal(requests.length, 4, 'Each selection should send exactly one chat turn');
    assert.equal(await input.inputValue(), 'Keep my draft');
    assert.equal(await choice.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    if (viewport.width > 1024) assert.equal(await page.locator('.leaflet-marker-icon').count(), 2, 'Pickup and destination must be separate map roles');
    const firstChoice = page.locator('[data-address-choice]').filter({ hasText: first.name });
    await firstChoice.getByRole('button', { name: 'Use as destination', exact: true }).click();
    await firstChoice.getByRole('button', { name: 'Destination selected', exact: true }).waitFor();
    assert.equal(await choice.getByRole('button', { name: 'Use as destination', exact: true }).isEnabled(), true, 'Changing destination must clear the previous selection');
    assert.equal(await choice.getByRole('button', { name: 'Pickup selected', exact: true }).count(), 1, 'Changing destination must preserve pickup');
    if (viewport.width > 1024) assert.equal(await page.locator('.leaflet-marker-icon').count(), 2, 'Changing destination must replace its marker');
    await page.screenshot({ path: `/tmp/optimat-address-selection-${viewport.width}.png` });
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    assert.equal(await page.locator('[data-address-choice]').count(), 0);
    console.log(`PASS ${viewport.width}: keyboard selection, correct role/address, draft preserved, retry, map coordinates, deduplication, road warning, new chat`);
    await page.close();
  }
} finally {
  await browser.close();
}
