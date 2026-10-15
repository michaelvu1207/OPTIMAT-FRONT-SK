// Run against a local dev server; external services are stubbed.
// PLAYWRIGHT_CHANNEL=msedge node tests/chat/navigation-history.mjs [baseUrl]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage();
  let conversations = 0;
  const requests = [];
  let finishReply;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseUrl).origin) return route.continue();
    if (url.pathname.endsWith('/health')) return route.fulfill({ json: { status: 'ok' } });
    if (url.pathname.endsWith('/conversations')) {
      conversations++;
      return route.fulfill({ json: { id: `conversation-${conversations}`, messages: [] } });
    }
    if (url.pathname.endsWith('/chat')) {
      requests.push(route.request().postDataJSON());
      await new Promise(resolve => { finishReply = resolve; });
      return route.fulfill({ json: { message: 'Your trip conversation is still here.' } });
    }
    return route.fulfill({ json: [] });
  });
  // Opening an information page must not create a background conversation.
  await page.goto(`${baseUrl}#/what-is-optimat`);
  assert.equal(conversations, 0);
  await page.getByRole('button', { name: 'Find Your Trip', exact: true }).click();
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Your question', exact: true });
  await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
  assert.equal(conversations, 1);
  await input.fill('Please help me plan my trip.');
  const firstRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await firstRequest;
  await page.getByRole('button', { name: 'Service Map', exact: true }).click();
  await input.waitFor({ state: 'hidden' });
  finishReply();
  await page.getByRole('button', { name: 'Find Your Trip', exact: true }).click();
  await input.waitFor({ state: 'visible' });
  await page.getByText('Your trip conversation is still here.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  await input.fill('Keep this unsent draft');
  for (const path of ['/what-is-optimat', '/architecture', '/api-docs', '/beta-signup', '/provider-portal', '/providers-info']) {
    await page.evaluate(path => { window.location.hash = path; }, path);
    await input.waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.location.hash = '/chat'; });
    await input.waitFor({ state: 'visible' });
    assert.equal(await input.inputValue(), 'Keep this unsent draft');
    assert.equal(await page.getByText('Please help me plan my trip.', { exact: true }).isVisible(), true);
    assert.equal(conversations, 1, `Navigation to ${path} must reuse the conversation`);
  }
  await page.goBack();
  await input.waitFor({ state: 'hidden' });
  await page.goForward();
  await input.waitFor({ state: 'visible' });
  const secondRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/chat'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await secondRequest;
  finishReply();
  await page.getByRole('button', { name: 'Stop generating response' }).waitFor({ state: 'hidden' });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.conversation_id === 'conversation-1'));
  await page.getByRole('button', { name: 'New Chat', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#chat-question')?.disabled);
  assert.equal(conversations, 2, 'Only explicit New Chat starts another conversation');
  assert.equal(await page.getByText('Please help me plan my trip.', { exact: true }).count(), 0);
  console.log('PASS: page navigation, pending reply, draft, back/forward, conversation ID, and explicit New Chat');
} finally {
  await browser.close();
}

