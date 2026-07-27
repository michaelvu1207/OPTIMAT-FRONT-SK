#!/usr/bin/env node
/**
 * The provider panel is a call sheet: it appears only once the trip is fully pinned down and
 * there are providers worth phoning. These checks cover the three states it can be in.
 */
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://localhost:4173/';
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : ` — ${detail}`}`); };

async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const replies = [];
  page.on('response', async (r) => {
    if (r.url().includes('/functions/v1/chat') && r.request().method() === 'POST') {
      try { replies.push(await r.json()); } catch {}
    }
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const ta = page.locator('textarea[placeholder="Type your message..."]');
  await ta.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => { const i = document.querySelector('textarea[placeholder="Type your message..."]'); return i && !i.disabled; }, null, { timeout: 30000 });
  return { page, ta, replies };
}
async function send(page, ta, msg, replies, n) {
  await ta.fill(msg);
  await page.getByRole('button', { name: 'Send message' }).click();
  const deadline = Date.now() + 200000;
  while (replies.length < n) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise(r => setTimeout(r, 500)); }
  await page.waitForTimeout(1500);
  return replies[n - 1];
}

try {
  // ── Partial trip: must NOT show a call sheet ────────────────────────────
  console.log('\nState 1 — trip not yet pinned down');
  {
    const { page, ta, replies } = await open();
    await send(page, ta, 'I need to get over to my doctor. It is the Kaiser on Nevin, in Richmond. I am right by the Civic Center there.', replies, 1);
    // Two legitimate not-ready presentations: no search has run at all (the panel stays on
    // Examples), or a search ran but the trip is still incomplete (the "still working out" panel).
    // What must never happen is a call sheet built from a half-specified trip.
    const notReady = page.locator('[aria-label="Trip not ready to book"]');
    const examples = page.locator('text=EXAMPLES');
    const callCards = page.locator('article[data-provider-kind="callable"], article[data-provider-kind="verification-required"]');
    const tripBar = page.locator('[aria-label="Trip to book"]');
    check('does not present a call sheet yet', await callCards.count() === 0 && await tripBar.count() === 0,
      `${await callCards.count()} call cards and ${await tripBar.count()} trip bars rendered too early`);
    check('panel shows a not-ready state rather than empty results',
      (await notReady.count()) > 0 || (await examples.count()) > 0, 'neither the not-ready panel nor examples were shown');
    await page.screenshot({ path: 'tests/chat/rendered/callsheet-1-not-ready.png', fullPage: true });
    await page.close();
  }

  // ── Fully specified trip: call sheet with phone numbers ─────────────────
  console.log('\nState 2 — trip fully specified');
  {
    const { page, ta, replies } = await open();
    const reply = await send(page, ta, 'One way from San Ramon City Hall to San Ramon Regional Medical Center on August 12th 2026, pickup at 10:00 AM. I am 72, live in San Ramon, not disabled, not ADA certified, not a veteran.', replies, 1);
    const search = (reply.attachments || []).find(a => a?.metadata?.tool_name === 'find_providers');
    const expected = (search?.data?.data || []).length + (search?.data?.verification_required || []).length;

    const header = page.locator('[aria-label="Provider results count"]');
    await header.first().waitFor({ state: 'visible', timeout: 30000 });
    check('header says ready to book', /ready to book/i.test(await header.first().innerText()), await header.first().innerText());

    const tripBar = page.locator('[aria-label="Trip to book"]');
    check('shows the trip to read out on the phone', await tripBar.count() > 0, 'trip summary bar missing');
    const tripText = await tripBar.first().innerText().catch(() => '');
    check('trip bar states date, time and both ends', /August 12/.test(tripText) && /10:00 AM/.test(tripText) && /→/.test(tripText), tripText.slice(0, 120));
    check('trip bar says OPTIMAT cannot book', /can'?t book/i.test(tripText), tripText.slice(0, 120));

    const callCards = page.locator('article[data-provider-kind="callable"], article[data-provider-kind="verification-required"]');
    check('one card per callable provider', await callCards.count() === expected, `${await callCards.count()} cards for ${expected} providers`);
    const telLinks = page.locator('article[data-provider-kind] a[href^="tel:"]');
    check('every card offers a phone number to call', await telLinks.count() >= 1, 'no tel: links rendered');
    await page.screenshot({ path: 'tests/chat/rendered/callsheet-2-ready.png', fullPage: true });
    await page.close();
  }
} finally { await browser.close(); }

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
