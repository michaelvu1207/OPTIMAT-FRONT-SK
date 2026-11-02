// Local-only UI regression; external APIs and map tiles are stubbed.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const providers = [
  { provider_name: 'LINK Paratransit', eligibility_reqs: 'Proof: Complete County Connection LINK ADA application.', schedule_type: { type: 'in-advance-book', advance_notice: '1-7 days' } },
  { provider_name: 'Mobility Matters', eligibility_reqs: 'Senior (60+) or veteran. Proof: No proof mentioned on website.', schedule_type: { type: 'in-advance-book', advance_notice: '7 days' } },
  { provider_name: 'Example Confirmed Program', booking: { application: { required: true, processing_time: { kind: 'range', minimum: 5, maximum: 10, unit: 'business_days' }, source_url: 'https://provider.example/apply', verified_at: '2026-11-02' } }, schedule_type: { advance_notice: '2-7 days' } },
  { provider_name: 'Example No Application Program', booking: { method: 'none', application: { required: false } } },
  { provider_name: 'Example Fixed Route', provider_type: 'Fixed Route' },
].map(provider => ({ provider_type: 'Non-ADA Paratransit', service_hours_known: true, ...provider }));

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'timeline-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) return route.fulfill({ json: {
        message: providers.map(provider => `${provider.provider_name}: You may qualify; contact the provider to confirm.`).join('\n\n'),
        attachments: [{ type: 'provider_search', metadata: { tool_name: 'assess_eligibility' }, data: { status: 'complete', data: providers, source_address: 'Example origin', destination_address: 'Example destination', total_found: providers.length } }],
      } });
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await page.locator('#chat-question').fill('Show transportation options');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const link = page.locator('article[data-provider-name="LINK Paratransit"]');
    await link.waitFor();
    const timeline = link.locator('[data-provider-timeline]');
    assert.match(await timeline.innerText(), /Required before your first ride/);
    assert.match(await timeline.innerText(), /Contact the provider to confirm processing time/);
    assert.match(await timeline.innerText(), /Booking notice\s+1-7 days/);
    assert.equal(await link.getByText(/Call by|Booking deadline/).count(), 0, 'A booking window must not become a fabricated deadline');
    const mobility = page.locator('article[data-provider-name="Mobility Matters"] [data-provider-timeline]');
    assert.match(await mobility.innerText(), /confirm whether you need to apply/);
    assert.match(await mobility.innerText(), /Booking notice\s+7 days/);
    assert.doesNotMatch(await mobility.innerText(), /30 days/);
    const confirmed = page.locator('article[data-provider-name="Example Confirmed Program"] [data-provider-timeline]');
    assert.match(await confirmed.innerText(), /Application processing time\s+5–10 business days/);
    assert.match(await confirmed.innerText(), /Booking notice\s+2-7 days/);
    assert.equal(await confirmed.getByRole('link').getAttribute('href'), 'https://provider.example/apply');
    const noApplication = page.locator('article[data-provider-name="Example No Application Program"] [data-provider-timeline]');
    assert.match(await noApplication.innerText(), /No application required/);
    assert.equal(await noApplication.getByText('Application processing time', { exact: true }).count(), 0);
    assert.equal(await page.locator('article[data-provider-name="Example Fixed Route"] [data-provider-timeline]').count(), 0);
    for (const card of await page.locator('[data-provider-timeline]').all()) assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await timeline.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    await link.screenshot({ path: `/tmp/optimat-application-timeline-${viewport.width}.png` });
    console.log(`PASS ${viewport.width}: application vs booking separation, unknown-time fallback, confirmed data, no false deadline, no-application and fixed-route handling, no clipping`);
    await page.close();
  }
} finally {
  await browser.close();
}
