import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://127.0.0.1:43112/';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const width of [1280, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const sent = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'shortcuts', messages: [] } });
      if (url.pathname.endsWith('/chat')) {
        const message = route.request().postDataJSON().message;
        sent.push(message);
        const attachments = message === 'Ambiguous time' ? [{ type: 'time_choices', data: { question: 'What does noon mean for your trip?', options: [
          { label: 'Pickup time', message: 'noon is my requested pickup time.' },
          { label: 'Arrival time', message: 'I need to arrive by noon. This is not my pickup time.' },
        ] } }] : [{ type: 'route_planner', data: { mode: 'bicycling', url: 'https://www.google.com/maps/dir/?api=1&travelmode=bicycling&origin=Danville' } }];
        return route.fulfill({ json: { message: 'Choose an option below.', attachments } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await input.fill('Ambiguous time');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('button', { name: 'Arrival time', exact: true }).waitFor();
    await input.fill('Keep this draft');
    await page.getByRole('button', { name: 'Arrival time', exact: true }).click();
    const link = page.getByRole('link', { name: 'Plan a bike trip (opens in a new tab)', exact: true });
    await link.waitFor();
    assert.equal(sent[1], 'I need to arrive by noon. This is not my pickup time.');
    assert.equal(await input.inputValue(), 'Keep this draft');
    assert.equal(new URL(await link.getAttribute('href')).hostname, 'www.google.com');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('[data-route-planner]').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await link.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-trip-shortcuts-${width}.png` });
    console.log(`PASS ${width}: time buttons preserve draft and arrival meaning; route handoff fits without an API request`);
    await page.close();
  }
} finally { await browser.close(); }
