// Raw legacy attachments must be readable without exposing record metadata.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://127.0.0.1:43112/';
const provider = {
  provider_name: 'Mobility Matters', provider_id: 4021, id: 'internal-id-sentinel',
  created_at: 'internal-created-sentinel', updated_at: 'internal-updated-sentinel', investigated: true,
  eligibility_reqs: 'Senior (60+) or veteran, and a Contra Costa County resident.', routing_type: 'door-to-door',
  booking: { method: 'call', details: '(925) 284-6161', metadata: 'internal-booking-sentinel', application: {
    required: true, processing_time: { kind: 'range', minimum: 2, maximum: 4, unit: 'business_days', debug: 'internal-time-sentinel' }, instructions: 'Contact the provider before your first ride.', source_notes: 'internal-source-sentinel',
  } },
  fare: { type: 'free', raw_data: 'internal-fare-sentinel' }, website: 'https://example.com/mobility',
  service_hours: JSON.stringify({ hours: [{ day: '1111100', start: '0900', end: '1700', metadata: 'internal-hours-sentinel' }] }),
  service_area_geojson: { type: 'FeatureCollection', features: [{ geometry: { type: 'MultiPolygon', coordinates: Array.from({ length: 1000 }, () => [-122.123456789, 37.123456789]) } }] },
  contacts: [{ name: 'Example contact', email: 'contact@example.com', metadata: 'internal-contact-sentinel' }],
};
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'provider-detail-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) {
        const body = route.request().postDataJSON();
        const details = body.message === 'Multiple services' ? [provider, { provider_name: 'Another service', eligibility_reqs: [{ type: 'Senior', proof: 'Confirm with provider', metadata: 'internal-rule-sentinel' }] }] : provider;
        return route.fulfill({ json: { message: 'Please confirm application requirements with the provider.', attachments: [
          { type: 'provider_info', data: details },
          { type: 'web_search', data: { debug: 'internal-web-sentinel', metadata: { request_id: 'internal-request-sentinel' }, sources: [{ title: 'Application information', url: 'https://example.com/application', raw_data: 'internal-search-sentinel' }] } },
        ] } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await input.fill('Do I need to apply for Mobility Matters first?');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const details = page.locator('[data-provider-details]').first();
    assert.equal(await details.isVisible(), false, 'Provider details start collapsed');
    await page.getByText('View provider details', { exact: true }).click();
    await details.waitFor();
    await details.getByRole('heading', { name: 'Mobility Matters', exact: true }).waitFor();
    assert.equal(await details.getByRole('link', { name: 'Call (925) 284-6161', exact: true }).getAttribute('href'), 'tel:9252846161');
    assert.equal(await details.getByRole('link', { name: 'Provider website' }).getAttribute('href'), 'https://example.com/mobility');
    assert.equal(await details.getByRole('link', { name: 'contact@example.com', exact: true }).getAttribute('href'), 'mailto:contact@example.com');
    await details.getByText('2–4 business days', { exact: true }).waitFor();
    await details.getByText('Mon, Tue, Wed, Thu, Fri: 9:00 AM–5:00 PM', { exact: true }).waitFor();
    assert.equal(await details.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.getByText('Web search', { exact: true }).click();
    await page.getByRole('link', { name: 'Application information', exact: true }).waitFor();
    const bodyText = await page.locator('body').textContent();
    assert.doesNotMatch(bodyText, /internal-|provider_id|created_at|updated_at|service_area_geojson|FeatureCollection|MultiPolygon|coordinates|metadata|raw_data|\[object Object\]/);
    assert.equal(await page.locator('pre').count(), 0, 'No raw-data viewer should remain in chat');
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-provider-details-${viewport.width}.png` });
    await input.fill('Multiple services');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-provider-details-disclosure]').length === 2);
    await page.getByText('View provider details', { exact: true }).last().click();
    await page.getByRole('heading', { name: 'Another service', exact: true }).waitFor();
    assert.equal(await page.locator('[data-provider-details]').count(), 3);
    assert.doesNotMatch(await page.locator('body').textContent(), /internal-|\[object Object\]|FeatureCollection|metadata/);
    console.log(`PASS ${viewport.width}: readable details, phone/email/website links, application and hours, legacy and multiple records, no metadata or raw JSON`);
    await page.close();
  }
} finally { await browser.close(); }
