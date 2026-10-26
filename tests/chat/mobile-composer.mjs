// Run against a local dev server. All external requests are stubbed.
// PLAYWRIGHT_CHANNEL=msedge node tests/chat/mobile-composer.mjs [baseUrl]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

async function assertComposerVisible(page, availableHeight) {
  const input = page.getByRole('textbox', { name: 'Your question', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const voice = page.getByRole('button', { name: 'Start voice input', exact: true });
  for (const control of [input, voice, send]) {
    const box = await control.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= availableHeight + 1,
      `Control must fit the visible viewport: ${JSON.stringify(box)}, height=${availableHeight}`);
    assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1,
      `Control must fit the viewport width: ${JSON.stringify(box)}`);
  }
  const history = page.getByRole('region', { name: 'Conversation history' });
  assert.ok((await history.boundingBox()).height >= 80, 'History must retain usable space');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'No page scrolling needed');
}

try {
  // 640x400 and 320x400 also cover effective viewport sizes at 200% / 400% desktop zoom.
  for (const viewport of [
    { width: 320, height: 568 }, { width: 390, height: 664 }, { width: 430, height: 740 },
    { width: 768, height: 1024 }, { width: 820, height: 1180 }, { width: 1024, height: 768 },
    { width: 844, height: 390 }, { width: 640, height: 400 }, { width: 320, height: 400 },
    { width: 1280, height: 800 }
  ]) {
    const mobile = viewport.width < 768;
    const compact = viewport.width <= 1024;
    const page = await browser.newPage({ viewport, isMobile: compact, hasTouch: compact });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) return route.continue();
      if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
      if (url.pathname.endsWith('/conversations')) return route.fulfill({ json: { id: 'layout-test', messages: [] } });
      if (url.pathname.endsWith('/chat-examples')) return route.fulfill({ json: { data: [
        { id: 'example-1', title: 'A ride to the hospital' },
        { id: 'example-2', title: 'Find transportation nearby' }
      ] } });
      if (url.pathname.endsWith('/chat')) return route.fulfill({ json: {
        message: Array.from({ length: 30 }, (_, i) => `Travel advice ${i + 1}.`).join('\n\n') +
          '\n\nhttps://example.com/' + 'long-address-'.repeat(50), attachments: []
      } });
      return route.fulfill({ json: [] });
    });
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Get started', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
    await assertComposerVisible(page, viewport.height);
    assert.equal(await page.locator('.app-nav').evaluate(el => el.scrollWidth > el.clientWidth + 1), false,
      'Navigation should wrap instead of requiring sideways scrolling');
    assert.equal(await page.locator('.leaflet-container').count(), compact ? 0 : 1);
    assert.ok(Number(await page.locator('#chat-question').evaluate(el => parseFloat(getComputedStyle(el).fontSize))) >= 16,
      'Input text should not trigger iOS focus zoom');
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `chat-${viewport.width}x${viewport.height}.png`) });

    if (mobile) {
      assert.equal(await page.locator('#chat-question').getAttribute('placeholder'), 'Start search here.');
      assert.equal(await page.getByTestId('mobile-greeting').count(), 1);
      assert.ok((await page.getByTestId('mobile-greeting').boundingBox()).height < 230);
      await page.getByRole('button', { name: 'New Chat', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
      assert.equal(await page.getByTestId('mobile-greeting').count(), 1);
      await assertComposerVisible(page, viewport.height);

    } else {
      assert.equal(await page.getByTestId('mobile-greeting').count(), 0);
      assert.ok(await page.getByText('Find Providers', { exact: false }).count() > 0);
    }

    if (viewport.height >= 568) {
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
    }

    await page.locator('#chat-question').fill('Find a ride');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Travel advice 30.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    const history = page.getByRole('region', { name: 'Conversation history' });
    await page.waitForFunction(() => {
      const el = document.querySelector('.chat-messages');
      return el.scrollWidth <= el.clientWidth + 1;
    }, undefined, { timeout: 3000 });
    assert.equal(await history.evaluate(el => el.scrollWidth > el.clientWidth + 1), false,
      'Long content must wrap inside the history');
    await history.focus();
    await history.evaluate(el => { el.scrollTop = 0; });
    await assertComposerVisible(page, viewport.height);
    await history.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await assertComposerVisible(page, viewport.height);

    // Pinch zoom magnifies the existing layout; it must not shrink the app a second time.
    const session = await page.context().newCDPSession(page);
    const shellHeight = await page.locator('.page-shell').evaluate(el => el.getBoundingClientRect().height);
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await page.waitForFunction(() => visualViewport.scale === 2);
    assert.equal(await page.locator('.page-shell').evaluate(el => el.getBoundingClientRect().height), shellHeight);
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });

    // Crossing the tablet/desktop breakpoint preserves both the conversation and draft.
    await page.locator('#chat-question').fill('Keep this draft');
    const resized = { width: compact ? 1280 : 820, height: 800 };
    await page.setViewportSize(resized);
    await page.waitForFunction(width => innerWidth === width, resized.width);
    assert.equal(await page.locator('#chat-question').inputValue(), 'Keep this draft');
    assert.equal(await page.getByText('Travel advice 30.', { exact: true }).count(), 1);
    await assertComposerVisible(page, resized.height);
    console.log(`PASS ${viewport.width}x${viewport.height}: controls, history, long content, keyboard, pinch zoom, resize state`);
    await page.close();
  }
} finally {
  await browser.close();
}
