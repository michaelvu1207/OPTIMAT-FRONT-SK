// Run against a local dev server. All external requests are stubbed.
// PLAYWRIGHT_CHANNEL=msedge node tests/chat/mobile-composer.mjs [baseUrl]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });

async function assertComposerVisible(page, availableHeight) {
  const input = page.getByRole('textbox', { name: 'Your question', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  for (const control of [input, send]) {
    const box = await control.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= availableHeight + 1,
      `Control must fit the visible viewport: ${JSON.stringify(box)}, height=${availableHeight}`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'No page scrolling needed');
}

try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 664 }, { width: 430, height: 740 }, { width: 1280, height: 800 }]) {
    const mobile = viewport.width < 768;
    const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'layout-test', messages: [] } });
      if (url.pathname.endsWith('/chat-examples')) return route.fulfill({ json: { data: [
        { id: 'example-1', title: 'A ride to the hospital' },
        { id: 'example-2', title: 'Find transportation nearby' }
      ] } });
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await assertComposerVisible(page, viewport.height);

    if (mobile) {
      assert.equal(await page.locator('#chat-question').getAttribute('placeholder'), 'Start search here');
      assert.equal(await page.getByTestId('mobile-greeting').count(), 1);
      assert.ok((await page.getByTestId('mobile-greeting').boundingBox()).height < 230);
      await page.getByRole('button', { name: 'New Chat', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
      assert.equal(await page.getByTestId('mobile-greeting').count(), 1);
      await assertComposerVisible(page, viewport.height);

      // Emulate the VisualViewport resize signal from browser chrome / a keyboard,
      // while keeping the CSS layout viewport unchanged (unlike setViewportSize).
      const reducedHeight = viewport.height - 220;
      await page.evaluate(height => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: height });
        window.visualViewport.dispatchEvent(new Event('resize'));
      }, reducedHeight);
      await page.waitForFunction(height => Math.abs(document.querySelector('.page-shell').getBoundingClientRect().height - height) < 1, reducedHeight);
      await assertComposerVisible(page, reducedHeight);
      await page.locator('#chat-question').fill('I need a ride');
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true);
      await page.locator('.chat-messages').evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
      await assertComposerVisible(page, reducedHeight);

      await page.evaluate(() => {
        delete window.visualViewport.height;
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(height => Math.abs(document.querySelector('.page-shell').getBoundingClientRect().height - height) < 1, viewport.height);
      await assertComposerVisible(page, viewport.height);
    } else {
      assert.equal(await page.getByTestId('mobile-greeting').count(), 0);
      assert.ok(await page.getByText('Find Providers', { exact: false }).count() > 0);
    }
    console.log(`PASS ${viewport.width}x${viewport.height}: composer visible${mobile ? ', compact greeting, new chat, viewport shrink/restore' : ', desktop greeting preserved'}`);
    await page.close();
  }
} finally {
  await browser.close();
}
