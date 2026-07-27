#!/usr/bin/env node
/**
 * Drive the rider conversations in example-conversations.json through the real UI and save each
 * one as a chat example via the app's own "Save as Example" flow.
 *
 * Uses the browser rather than the API so the saved example carries exactly what a rider would
 * have produced — the same turns, attachments and rendered state.
 *
 * Usage:
 *   node tests/chat/record-examples.mjs [baseUrl] [--only dialysis,sunday] [--headed]
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const baseUrl = argv.find((arg) => arg.startsWith('http')) || 'http://localhost:4173/';
const onlyArg = argv.indexOf('--only');
const ONLY = onlyArg === -1 ? [] : String(argv[onlyArg + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const HEADED = argv.includes('--headed');
const SHOTS = resolve(__dirname, 'rendered', 'examples');
mkdirSync(SHOTS, { recursive: true });

const { examples } = JSON.parse(readFileSync(resolve(__dirname, 'example-conversations.json'), 'utf8'));
const selected = ONLY.length ? examples.filter((e) => ONLY.some((k) => e.id.includes(k))) : examples;

const browser = await chromium.launch({ headless: !HEADED });
const results = [];

async function openChat() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const chatResponses = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/functions/v1/chat') && response.request().method() === 'POST') {
      try { chatResponses.push({ status: response.status(), body: await response.json() }); } catch { /* ignore */ }
    }
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const textarea = page.locator('textarea[placeholder="Type your message..."]');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[placeholder="Type your message..."]');
    return input && !input.disabled;
  }, null, { timeout: 30_000 });
  return { page, textarea, chatResponses };
}

async function sendTurn(page, textarea, message, chatResponses, expectedCount) {
  await textarea.fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  const deadline = Date.now() + 220_000;
  while (chatResponses.length < expectedCount) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for reply ${expectedCount}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const turn = chatResponses[expectedCount - 1];
  if (turn.status !== 200) throw new Error(`Chat returned ${turn.status}: ${JSON.stringify(turn.body).slice(0, 200)}`);
  // Let the panel finish rendering before the next turn or the screenshot.
  await page.waitForTimeout(1_200);
  return turn.body;
}

async function saveAsExample(page, example) {
  await page.getByRole('button', { name: 'Save as Example' }).click();
  await page.locator('#example-title').waitFor({ state: 'visible', timeout: 15_000 });

  await page.locator('#example-title').fill(example.title);
  await page.locator('#example-category').selectOption(example.category);
  const description = page.locator('#example-description');
  if (await description.count()) await description.fill(example.description);
  const tags = page.locator('#example-tags');
  if (await tags.count()) await tags.fill(example.tags);

  // The app tries replay/save-as-example first (which also generates replay states) and only
  // falls back to chat-examples, so either endpoint can be the one that saves. Match on the path
  // alone: these calls go to <ref>.functions.supabase.co/<name>, not the /functions/v1/ form the
  // chat endpoint uses, and requiring that prefix silently matched nothing.
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /(replay\/save-as-example|chat-examples)(\?|$)/.test(new URL(response.url()).pathname + (new URL(response.url()).search || '')),
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: 'Save Example' }).click();
  const response = await saveResponse;
  const body = await response.json().catch(() => null);
  if (response.status() >= 300) {
    throw new Error(`Saving the example returned ${response.status()}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body?.data?.id || body?.id || null;
}

for (const [index, example] of selected.entries()) {
  const label = `${index + 1}/${selected.length} ${example.id}`;
  process.stdout.write(`\n[${label}] ${example.title}\n`);
  let page;
  try {
    const chat = await openChat();
    page = chat.page;
    const replies = [];
    for (const [turnIndex, message] of example.turns.entries()) {
      process.stdout.write(`  → "${message.slice(0, 70)}${message.length > 70 ? '…' : ''}"\n`);
      const reply = await sendTurn(chat.page, chat.textarea, message, chat.chatResponses, turnIndex + 1);
      replies.push(reply);
      process.stdout.write(`  ← ${String(reply.message || '').replace(/\s+/g, ' ').slice(0, 110)}…\n`);
    }

    await page.screenshot({ path: `${SHOTS}/${example.id}.png`, fullPage: true });
    const exampleId = await saveAsExample(page, example);
    process.stdout.write(`  ✓ saved as example ${exampleId || '(id not returned)'}\n`);

    results.push({
      id: example.id,
      title: example.title,
      example_id: exampleId,
      saved: true,
      turns: example.turns.length,
      replies: replies.map((reply) => reply.message),
    });
  } catch (error) {
    process.stdout.write(`  ✗ ${error.message}\n`);
    results.push({ id: example.id, title: example.title, saved: false, error: error.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

await browser.close();

const saved = results.filter((result) => result.saved);
console.log(`\n${saved.length}/${results.length} examples saved`);
for (const result of results.filter((r) => !r.saved)) console.log(`  ✗ ${result.id}: ${result.error}`);
console.log(`Screenshots in ${SHOTS}/`);
process.exitCode = saved.length === results.length ? 0 : 1;
