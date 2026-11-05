// Local browser regression; all external services are stubbed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://127.0.0.1:43112/';
const explanation = 'Also serves Concord. Your pickup and destination matched its recorded service area.';
const provider = { provider_name: 'Walnut Creek Lyft Concierge Pass', service_area_explanation: explanation, booking: { method: 'call', details: '925-555-0100' }, eligibility_reqs: 'Senior (60+) or disabled (18+).', service_hours_known: true };
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'cross-city-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) {
        const unknown = route.request().postDataJSON().message === 'Need confirmation';
        return route.fulfill({ json: { message: `${provider.provider_name}: ${unknown ? 'Confirm remaining eligibility with the provider.' : 'You may qualify.'}\n\nWalnut Creek Mini Bus: Contact the provider.`, attachments: [{ type: 'provider_search', metadata: { tool_name: 'assess_eligibility' }, data: {
          status: 'complete', data: unknown ? [] : [provider, { provider_name: 'Walnut Creek Mini Bus', service_area_explanation: null }],
          verification_required: unknown ? [{ ...provider, eligibility_status: 'verification_required' }] : [],
          source_address: '123 Main St, Concord, CA 94520', destination_address: '456 Oak St, Concord, CA 94520',
        } }] } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await input.fill('Find a ride in Concord'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const card = page.locator(`article[data-provider-name="${provider.provider_name}"]`).first();
    await card.locator('[data-service-area-explanation]').waitFor();
    assert.equal(await card.locator('[data-service-area-explanation]').innerText(), explanation);
    assert.equal(await page.locator('article[data-provider-name="Walnut Creek Mini Bus"] [data-service-area-explanation]').count(), 0);
    assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await card.locator('[data-service-area-explanation]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-cross-city-${viewport.width}.png` });
    await input.fill('Need confirmation'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const unconfirmed = page.locator(`article[data-provider-name="${provider.provider_name}"][data-provider-kind="verification-required"]`);
    await unconfirmed.waitFor();
    assert.equal(await unconfirmed.locator('[data-service-area-explanation]').innerText(), explanation);
    assert.equal(await unconfirmed.getByText('You may qualify', { exact: true }).count(), 0);
    console.log(`PASS ${viewport.width}: cross-city explanation, no unsupported note, no clipping, unknown eligibility retained`);
    await page.close();
  }
} finally { await browser.close(); }
