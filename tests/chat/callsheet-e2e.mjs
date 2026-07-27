#!/usr/bin/env node
/**
 * Provider details are cards inside the reply, placed under the paragraph that names the provider.
 * These checks cover the three states that used to belong to the separate results panel: a trip
 * that is not pinned down yet, a fully specified trip, and a replayed example.
 *
 * Usage: node tests/chat/callsheet-e2e.mjs [baseUrl]
 */
import { chromium } from 'playwright';
const baseUrl = process.argv[2] || 'http://localhost:4173/';
const browser = await chromium.launch({ headless: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : ` — ${detail}`}`); };

/** Cards must live in the transcript, not in a panel beside it. */
const CARDS = '.chat-messages article[data-provider-kind="callable"], .chat-messages article[data-provider-kind="verification-required"]';

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
  // ── Partial trip: no cards, no trip strip ──────────────────────────────
  console.log('\nState 1 — trip not yet pinned down');
  {
    const { page, ta, replies } = await open();
    await send(page, ta, 'I need to get over to my doctor. It is the Kaiser on Nevin, in Richmond. I am right by the Civic Center there.', replies, 1);
    const cards = page.locator(CARDS);
    const tripStrip = page.locator('[aria-label="Trip to book"]');
    check('no provider cards before results exist',
      await cards.count() === 0 && await tripStrip.count() === 0,
      `cards=${await cards.count()} tripStrip=${await tripStrip.count()}`);
    check('the results panel is gone for good',
      await page.locator('[aria-label="Provider results count"]').count() === 0,
      'the old panel header is still rendering');
    check('the bottom pane is the examples list',
      await page.locator('text=EXAMPLES').count() > 0, 'examples pane not shown');
    await page.screenshot({ path: 'tests/chat/rendered/callsheet-1-not-ready.png', fullPage: true });
    await page.close();
  }

  // ── Fully specified trip: cards embedded in the reply ──────────────────
  console.log('\nState 2 — trip fully specified');
  {
    const { page, ta, replies } = await open();
    const reply = await send(page, ta, 'One way from San Ramon City Hall to San Ramon Regional Medical Center on August 12th 2026, pickup at 10:00 AM. I am 72, live in San Ramon, not disabled, not ADA certified, not a veteran.', replies, 1);
    const search = (reply.attachments || []).find(a => a?.metadata?.tool_name === 'find_providers');
    const expected = (search?.data?.data || []).length + (search?.data?.verification_required || []).length;

    const cards = page.locator(CARDS);
    await cards.first().waitFor({ state: 'visible', timeout: 30000 });
    check('one card per callable provider, inside the reply',
      await cards.count() === expected, `${await cards.count()} cards for ${expected} providers`);
    check('every provider from the search has a card',
      await page.locator(CARDS).evaluateAll((nodes) => nodes.map((n) => n.dataset.providerName))
        .then((names) => [
          ...(search?.data?.data || []),
          ...(search?.data?.verification_required || [])
        ].every((p) => names.includes(p.provider_name))),
      'a returned provider has no card');

    const telLinks = page.locator('.chat-messages article[data-provider-kind] a[href^="tel:"]');
    check('cards offer a number to call', await telLinks.count() >= 1, 'no tel: links rendered');

    // Placement is the point of the rework: the card belongs to the sentence that raised it.
    const placedUnderMention = await page.locator(CARDS).evaluateAll((nodes) => nodes.some((node) => {
      const previous = node.previousElementSibling;
      const name = String(node.dataset.providerName || '');
      const bare = name.replace(/\s*\([^)]*\)/g, '').trim();
      return Boolean(previous?.classList.contains('chat-markdown')) &&
        (previous.textContent.includes(name) || (bare.length >= 5 && previous.textContent.includes(bare)));
    }));
    check('at least one card sits directly under the paragraph naming it', placedUnderMention,
      'no card follows a paragraph that mentions it');

    const tripStrip = page.locator('[aria-label="Trip to book"]');
    check('shows the trip to read out on the phone', await tripStrip.count() > 0, 'trip strip missing');
    const tripText = await tripStrip.first().innerText().catch(() => '');
    check('trip strip states date, time and both ends',
      /August 12/.test(tripText) && /10:00 AM/.test(tripText) && /→/.test(tripText), tripText.slice(0, 140));
    check('trip strip says OPTIMAT cannot book', /can'?t book/i.test(tripText), tripText.slice(0, 140));
    check('the trip strip precedes the first card',
      await page.evaluate(() => {
        const strip = document.querySelector('[aria-label="Trip to book"]');
        const card = document.querySelector('.chat-messages article[data-provider-kind]');
        return Boolean(strip && card) &&
          (strip.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      }), 'the strip is not above the cards');

    // The card's own button is now the only way to draw a service area on the map.
    const areaButton = page.locator(CARDS).first().locator('button').first();
    if (await areaButton.count() > 0 && /service area/i.test(await areaButton.innerText())) {
      await areaButton.click();
      await page.waitForTimeout(1200);
      const label = await areaButton.innerText();
      check('"Show service area" toggles to hide, so the map took the selection',
        /hide area/i.test(label), label);
    } else {
      check('"Show service area" toggles to hide, so the map took the selection', false, 'no service-area button on the first card');
    }
    await page.screenshot({ path: 'tests/chat/rendered/callsheet-2-ready.png', fullPage: true });
    await page.close();
  }

  // ── Replayed example: providers, but no date/time in the payload ────────
  console.log('\nState 3 — replaying a saved example');
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let listUrl = null;
    let listHeaders = null;
    let examples = [];
    page.on('response', async (r) => {
      if (!r.url().includes('chat-examples')) return;
      listUrl = r.url();
      listHeaders = await r.request().allHeaders();
      try { examples = (await r.json())?.data || []; } catch {}
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('text=Click to play').first().waitFor({ state: 'visible', timeout: 30000 });

    // Replay snapshots carry providers but no travel date or time. Pick an example that actually
    // has providers, otherwise "no cards" would pass for the wrong reason.
    const replayBase = listUrl.replace(/\/chat-examples.*$/, '/replay');
    const headers = Object.fromEntries(Object.entries(listHeaders || {})
      .filter(([key]) => ['apikey', 'authorization'].includes(key.toLowerCase())));
    let target = null;
    for (const [index, example] of examples.slice(0, 8).entries()) {
      const response = await page.request.get(`${replayBase}?conversation_id=${example.conversation_id}`, { headers });
      if (!response.ok()) continue;
      const states = (await response.json())?.states || [];
      const providers = Math.max(0, ...states.map((state) => (state?.state_snapshot?.providers || []).length));
      if (providers > 0) { target = { index, providers, title: example.title }; break; }
    }

    if (!target) {
      check('a saved example with providers exists to replay', false, 'no example replay carries providers');
    } else {
      console.log(`  · replaying "${target.title}" (${target.providers} providers in its snapshot)`);
      await page.locator('text=Click to play').nth(target.index).click();
      // Replays do not auto-advance, so step through every state.
      const next = page.locator('button[title="Next"]');
      await next.waitFor({ state: 'visible', timeout: 30000 });
      for (let step = 0; step < 20 && await next.isEnabled(); step += 1) {
        await next.click();
        await page.waitForTimeout(1500);
      }
      await page.locator(CARDS).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      const cards = await page.locator(CARDS).count();
      check('a replayed example renders its provider cards inline', cards > 0,
        'no cards rendered for the replayed providers');
      check('a replayed example never asks for a date it already has',
        await page.locator('[aria-label="Trip not ready to book"]').count() === 0,
        'the not-ready state is back');
    }
    await page.screenshot({ path: 'tests/chat/rendered/callsheet-3-replay.png', fullPage: true });
    await page.close();
  }
} finally { await browser.close(); }

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
