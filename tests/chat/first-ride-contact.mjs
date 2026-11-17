// Local or released frontend; all external requests are mocked. No production writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43112/';
const fixtures = [
  { provider_name: 'LINK Paratransit', provider_type: 'ADA Paratransit', booking: JSON.stringify({
    method: 'call', details: '(925)938-7433', application: {
      required: true, source_url: 'https://countyconnection.com/paratransit/eligibility-registration/',
      verified_at: '2026-11-03', instructions: 'Processing starts after receipt of a complete application.',
      processing_time: { kind: 'up_to', unit: 'calendar_days', value: 21 },
    },
  }) },
  { provider_name: 'Mobility Matters', booking: { application: {
    source_url: 'https://mobilitymatterscc.com/become-a-client/',
    instructions: 'Contact the coordinator to confirm when rides can begin.',
  } }, schedule_type: { advance_notice: '7 days' } },
  { provider_name: 'Another provider', booking: { application: { source_url: 'https://example.com/get-started' } } },
  { provider_name: 'Phone contact only', booking: { method: 'call', details: '(925) 555-0100' } },
  { provider_name: 'Unknown contact' },
  { provider_name: 'No application', booking: { phone: '925-555-0100', application: { required: false } } },
  { provider_name: 'Fixed route', provider_type: 'Fixed Route', booking: { phone: '925-555-0100' } },
  { provider_name: 'Unsafe application link', booking: { phone: '925-555-0100', application: { source_url: 'javascript:alert(1)' } } },
  { provider_name: 'Credential-bearing link', booking: { application: { source_url: 'https://user:password@example.com/apply' } } },
];

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const width of [320, 900, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'first-ride-test', messages: [] } });
      if (url.pathname.endsWith('/chat')) return route.fulfill({ json: {
        message: 'Check with the provider before your first ride.',
        attachments: [{ type: 'provider_info', data: fixtures }],
      } });
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('How do I get started?');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const disclosure = page.getByText('View provider details', { exact: true });
    await disclosure.waitFor();
    assert.equal(await page.locator('[data-first-ride-contact]').first().isVisible(), false);
    await disclosure.click();
    for (const [name, href] of [
      ['LINK Paratransit', 'https://countyconnection.com/paratransit/eligibility-registration/'],
      ['Mobility Matters', 'https://mobilitymatterscc.com/become-a-client/'],
      ['Another provider', 'https://example.com/get-started'],
    ]) {
      const details = page.getByRole('region', { name: `Service details for ${name}`, exact: true });
      const link = details.getByRole('link', { name: 'View application information (opens in a new tab)', exact: true });
      assert.equal(await link.getAttribute('href'), href, 'Use the recorded application URL');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await details.locator(`a[href="${href}"]`).count(), 1, 'Do not duplicate the application link');
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      assert.equal(await link.evaluate(el => document.activeElement === el), true);
      assert.ok((await link.boundingBox()).height >= 44);
      assert.equal(await details.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    }
    const mobility = page.getByRole('region', { name: 'Service details for Mobility Matters', exact: true });
    await mobility.getByText('Contact the provider to confirm processing time.', { exact: true }).waitFor();
    await mobility.getByText('7 days', { exact: true }).waitFor();
    for (const name of ['Phone contact only', 'Unsafe application link']) {
      const section = page.getByRole('region', { name: `Before your first ride with ${name}`, exact: true });
      const link = section.getByRole('link');
      assert.equal(await link.getAttribute('href'), 'tel:9255550100');
      assert.match(await link.innerText(), /about getting started/);
    }
    for (const name of ['Unknown contact', 'No application', 'Fixed route', 'Credential-bearing link']) {
      assert.equal(await page.getByRole('region', { name: `Service details for ${name}`, exact: true }).locator('[data-first-ride-contact]').count(), 0);
    }
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await page.getByRole('region', { name: 'Service details for LINK Paratransit', exact: true }).locator('[data-first-ride-contact]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/optimat-first-ride-${width}.png` });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: recorded URLs, unknown processing time, generic phone fallback, absent/unsafe/fixed-route cases, disclosure, keyboard and touch targets`);
    await page.close();
  }
} finally { await browser.close(); }
