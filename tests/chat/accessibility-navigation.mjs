// Local-only regression: all external API and map requests are stubbed.
// Start server: VITE_API_BACKEND=aws VITE_AWS_API_URL=https://optimat-test.invalid npm run dev -- --port 43111
// PLAYWRIGHT_CHANNEL=msedge node tests/chat/accessibility-navigation.mjs [baseUrl]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 664 }]) {
    const page = await browser.newPage({ viewport });
    let turn = 0;
    let releaseResponse;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'a11y-test', messages: [] } });
      if (url.pathname.endsWith('/chat-examples')) return route.fulfill({ json: { data: [] } });
      if (url.pathname.endsWith('/chat')) {
        turn++;
        if (turn === 2) await new Promise(resolve => { releaseResponse = resolve; });
        return route.fulfill({ json: { message: turn === 1
          ? Array.from({ length: 40 }, (_, i) => `Transportation information paragraph ${i + 1}.`).join('\n\n')
          : 'Your new transportation response.', attachments: [] } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    const dialog = page.getByRole('dialog', { name: 'Welcome to OPTIMAT' });
    await dialog.waitFor();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'Modal must contain keyboard focus');
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'Modal must contain reverse keyboard focus');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const input = page.getByRole('textbox', { name: 'Your question', exact: true });
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await input.fill('First request');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Transportation information paragraph 40.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    await input.fill('Second request');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Stop generating response"]'));
    const history = page.getByRole('region', { name: 'Conversation history' });
    const originalReply = page.locator('[data-message-role="ai"]').filter({ hasText: 'Transportation information paragraph 1.' });
    await originalReply.focus();
    await history.evaluate(el => { el.scrollTop = 100; });
    await page.waitForTimeout(150);
    const previousScroll = await history.evaluate(el => el.scrollTop);
    assert.ok(previousScroll < await history.evaluate(el => el.scrollHeight - el.clientHeight - 48));
    assert.equal(typeof releaseResponse, 'function', 'The second response should be waiting on the mock API');
    releaseResponse();
    await page.getByText('Your new transportation response.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    assert.ok(Math.abs(await history.evaluate(el => el.scrollTop) - previousScroll) < 2, 'Reply must preserve history scroll position');
    assert.equal(await originalReply.evaluate(el => el === document.activeElement), true, 'Reply must preserve reading focus');
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'Outer page must not jump');
    await page.getByRole('button', { name: 'Jump to latest message', exact: true }).click();
    assert.equal(await page.getByRole('article', { name: 'OPTIMAT response' }).last().evaluate(el => el === document.activeElement), true);
    assert.ok(await history.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop) < 2);
    await page.screenshot({ path: `/private/tmp/optimat-a11y-${viewport.width}.png` });
    console.log(`PASS ${viewport.width}: modal keyboard containment/Escape, named history, scroll/focus preservation, explicit jump`);
    await page.close();
  }
} finally {
  await browser.close();
}
