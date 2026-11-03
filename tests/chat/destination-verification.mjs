// Local browser regression. Network dependencies are stubbed; no production chat is created.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://127.0.0.1:43112/';
const officialUrl = 'https://healthy.kaiserpermanente.org/northern-california/facilities/Park-Shadelands-Medical-Offices-100343/departments/vision-care-dlp-102926';
const verifiedPlace = { name: 'Vision Essentials - Optometry at Park Shadelands Medical Offices', address: '320 Lennon Ln, Walnut Creek, CA 94598', location: { lat: 37.928, lng: -122.029 }, place_type: 'PointOfInterest', selectable: true, role: 'destination', building: 'Building 4 - Shasta', verification_status: 'official', source_url: officialUrl };
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    const requests = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'destination-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.message.startsWith('Use ')) return route.fulfill({ json: { message: 'Destination saved. What date would you like to travel?', attachments: [] } });
        if (body.message === 'Try official verification') return route.fulfill({ json: {
          message: 'Please confirm the official department address.',
          attachments: [
            { type: 'address_search', data: { role: 'pickup', places: [{ name: 'Danville Community Center', address: '420 Front St, Danville, CA 94526', role: 'pickup', place_type: 'PointOfInterest', location: { lat: 37.82, lng: -121.99 } }] } },
            { type: 'address_search', data: { status: 'verified', role: 'destination', places: [verifiedPlace] } },
          ],
        } });
        return route.fulfill({ json: { message: 'The destination remains unconfirmed.', attachments: [{ type: 'address_search', data: {
          role: 'destination', status: 'verification_required', places: [
            { name: 'Kaiser Quarry Rd', address: 'Kaiser Quarry Rd, Concord, CA 94521', place_type: 'Street', selectable: false },
            { name: 'Other Clinic', address: '123 Main St, Concord, CA 94521', place_type: 'PointOfInterest', selectable: false },
          ],
        } }] } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await input.fill('Find Kaiser'); await send.click();
    const pending = page.locator('[data-destination-pending]');
    await pending.waitFor();
    assert.equal(await page.locator('[data-address-choice]').getByRole('button').count(), 0, 'Roads and mismatched organizations must never have selection buttons');
    await input.fill('Try official verification'); await send.click();
    const destination = page.locator('[data-address-choice="320 Lennon Ln, Walnut Creek, CA 94598"]');
    await destination.waitFor();
    assert.equal(await destination.getByRole('button', { name: 'Use as pickup', exact: true }).count(), 0);
    const select = destination.getByRole('button', { name: 'Use as destination', exact: true });
    await select.waitFor();
    assert.equal(await destination.getByRole('link', { name: 'Verified official department address' }).getAttribute('href'), officialUrl);
    await destination.getByText('Building 4 - Shasta', { exact: true }).waitFor();
    const pickup = page.locator('[data-address-choice="420 Front St, Danville, CA 94526"]');
    assert.equal(await pickup.getByRole('button', { name: 'Use as pickup', exact: true }).count(), 1);
    assert.equal(await pickup.getByRole('button', { name: 'Use as destination', exact: true }).count(), 0);
    assert.equal(await destination.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await destination.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-destination-verification-${viewport.width}.png` });
    await input.fill('Keep this draft');
    await select.focus(); await page.keyboard.press('Enter');
    await destination.getByRole('button', { name: 'Destination selected', exact: true }).waitFor();
    assert.match(requests.at(-1).message, /320 Lennon Ln, Walnut Creek, CA 94598 as my destination/);
    assert.doesNotMatch(requests.at(-1).message, /370 Lennon/);
    assert.equal(await input.inputValue(), 'Keep this draft');
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    assert.equal(await page.locator('[data-destination-pending]').count(), 0);
    console.log(`PASS ${viewport.width}: pending state, unsafe results disabled, official source/building, independent roles, keyboard confirmation, draft preservation, reset`);
    await page.close();
  }
} finally { await browser.close(); }
