#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { marked } from 'marked';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const comparisons = [
  {
    index: 1,
    title: 'Walnut Creek → North Concord: date and one-way clarification',
    key: 'walnut-creek-concord-date',
    before: 'a8b13038-f96c-497c-a3f5-05ec24b5cc1a',
    after: 'c3e63204-484c-4234-98de-0f691d4e73c4',
  },
  {
    index: 2,
    title: 'San Francisco, Richmond paratransit, and public transit',
    key: 'sf-richmond-public-transit',
    before: '6f4c2981-4812-4e8c-be8d-389e7c638583',
    after: 'cd07d202-e6f5-419e-8cc6-710d358bc36c',
  },
  {
    index: 3,
    title: 'Bay Point → DVC: location and eligibility',
    key: 'bay-point-dvc-eligibility',
    before: '8d6a7a83-b0ec-4653-b676-a25416fcfe12',
    after: 'a5ea0a4a-c39e-430d-ac35-357a63166c43',
  },
  {
    index: 4,
    title: 'Richmond weekend service and exact date',
    key: 'richmond-weekend-date',
    before: '0bca3f58-84a1-4fb6-935a-28069b41e836',
    after: 'f008307f-cfd1-4791-b97e-b9ab0acc1c46',
  },
];

const baseUrl = `${env.VITE_SUPABASE_URL}/functions/v1`;
const headers = {
  apikey: env.VITE_SUPABASE_ANON_KEY,
  authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`,
};
const outputDirectory = path.resolve('tests/chat/rendered');
fs.mkdirSync(outputDirectory, { recursive: true });

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

marked.setOptions({ breaks: true, gfm: true });
marked.use({
  renderer: {
    html(token) {
      return escapeHtml(token.text);
    },
    link(token) {
      const label = this.parser.parseInline(token.tokens || []);
      const href = /^(https?:|mailto:|tel:)/i.test(String(token.href || '')) ? token.href : null;
      return href
        ? `<span class="rendered-link">${label} <span class="link-arrow">↗</span></span>`
        : label;
    },
    image(token) {
      return escapeHtml(token.text || token.href || 'image');
    },
  },
});

async function messagesFor(conversationId) {
  const url = new URL(`${baseUrl}/messages`);
  url.searchParams.set('conversation_id', conversationId);
  url.searchParams.set('limit', '200');
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${conversationId}: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  return payload.messages || [];
}

function normalizeRole(role) {
  return role === 'user' || role === 'human' ? 'user' : 'assistant';
}

function addMissingResponseMarkers(messages) {
  const normalized = messages
    .filter((message) => ['user', 'human', 'assistant', 'ai'].includes(message.role))
    .map((message) => ({ ...message, normalizedRole: normalizeRole(message.role) }));
  const result = [];
  for (const [index, message] of normalized.entries()) {
    result.push(message);
    if (
      message.normalizedRole === 'user' &&
      (!normalized[index + 1] || normalized[index + 1].normalizedRole === 'user')
    ) {
      result.push({
        id: `missing-${message.id || index}`,
        normalizedRole: 'assistant',
        content: '[No assistant response was stored before the tester sent the next message.]',
        missing: true,
        created_at: message.created_at,
      });
    }
  }
  return result;
}

function issueBadges(content, missing, side) {
  const badges = [];
  if (missing) badges.push(side === 'before' ? 'TIMEOUT / GAP' : 'MISSING');
  if (/tomorrow\s*\(July 20|tomorrow July 20/i.test(content)) badges.push('WRONG DATE');
  if (/return time for the search|placeholder return/i.test(content)) badges.push('FAKE RETURN REQUIRED');
  if (/December 20/i.test(content)) badges.push('INVENTED DATE');
  if (/July 21, 2025/i.test(content)) badges.push('WRONG YEAR');
  if (/Changing the date or time will not fix this coverage constraint/i.test(content)) badges.push('CONSTRAINT IDENTIFIED');
  if (/Pleasant Hill, not Antioch/i.test(content)) badges.push('LOCATION CAUGHT EARLY');
  return badges.map((badge) => `<span class="badge ${side}">${escapeHtml(badge)}</span>`).join('');
}

function formatTimestamp(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function messageMarkup(message, side) {
  const role = message.normalizedRole;
  const content = String(message.content || '');
  const rendered = role === 'assistant' && !message.missing
    ? marked.parse(content)
    : `<p>${escapeHtml(content).replaceAll('\n', '<br>')}</p>`;
  return `
    <article class="message ${role} ${message.missing ? 'missing' : ''}">
      <div class="message-meta">
        <span>${role === 'user' ? 'TESTER' : message.missing ? 'SYSTEM NOTE' : 'ASSISTANT'}</span>
        <time>${escapeHtml(formatTimestamp(message.created_at))}</time>
      </div>
      <div class="bubble">${rendered}</div>
      <div class="badges">${issueBadges(content, message.missing, side)}</div>
    </article>`;
}

function panelMarkup(label, conversationId, messages, side) {
  const normalized = addMissingResponseMarkers(messages);
  const testerTurns = normalized.filter((message) => message.normalizedRole === 'user').length;
  const storedResponses = normalized.filter((message) => message.normalizedRole === 'assistant' && !message.missing).length;
  const gaps = normalized.filter((message) => message.missing).length;
  return `
    <section class="panel ${side}">
      <header class="panel-header">
        <div>
          <div class="eyebrow">${escapeHtml(label)}</div>
          <div class="conversation-id">${escapeHtml(conversationId)}</div>
        </div>
        <div class="metrics">
          <span><b>${testerTurns}</b> tester turns</span>
          <span><b>${storedResponses}</b> responses</span>
          <span><b>${gaps}</b> gaps</span>
        </div>
      </header>
      <div class="transcript">${normalized.map((message) => messageMarkup(message, side)).join('')}</div>
    </section>`;
}

function pageMarkup(comparison, beforeMessages, afterMessages) {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>
        :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #e9eef5; color: #18212f; }
        .page-header { padding: 38px 46px 30px; background: #132238; color: white; border-bottom: 7px solid #f3b641; }
        .page-header .kicker { color: #f3c960; font-size: 16px; letter-spacing: .14em; text-transform: uppercase; font-weight: 800; }
        .page-header h1 { margin: 8px 0 6px; font-size: 34px; line-height: 1.18; }
        .page-header p { margin: 0; color: #c8d4e5; font-size: 17px; }
        .comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; padding: 22px; align-items: start; }
        .panel { border-radius: 16px; overflow: hidden; background: white; box-shadow: 0 8px 28px rgba(18, 34, 56, .11); border: 1px solid #cfdae7; }
        .panel.before { border-top: 7px solid #d94a4a; }
        .panel.after { border-top: 7px solid #29966f; }
        .panel-header { min-height: 116px; padding: 20px 22px; display: flex; justify-content: space-between; gap: 18px; border-bottom: 1px solid #dce4ee; background: #f8fafc; }
        .eyebrow { font-size: 22px; font-weight: 900; color: #18212f; }
        .before .eyebrow { color: #b83232; }
        .after .eyebrow { color: #197353; }
        .conversation-id { margin-top: 7px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #6c7889; overflow-wrap: anywhere; }
        .metrics { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; color: #566476; font-size: 13px; white-space: nowrap; }
        .metrics b { color: #172235; font-size: 16px; }
        .transcript { padding: 20px 18px 30px; background: linear-gradient(#f7f9fc, #eef3f8); }
        .message { margin: 0 0 18px; display: flex; flex-direction: column; }
        .message.user { align-items: flex-end; }
        .message.assistant { align-items: flex-start; }
        .message-meta { width: min(90%, 920px); display: flex; justify-content: space-between; padding: 0 5px 5px; font-size: 11px; font-weight: 800; letter-spacing: .07em; color: #718096; }
        .bubble { width: min(90%, 920px); padding: 14px 16px; border-radius: 15px; font-size: 15px; line-height: 1.45; overflow-wrap: anywhere; }
        .user .bubble { background: #1f6feb; color: white; border-bottom-right-radius: 4px; }
        .assistant .bubble { background: white; color: #1d2939; border: 1px solid #d4dde8; border-bottom-left-radius: 4px; }
        .missing .bubble { color: #9b2c2c; border: 2px dashed #dc7e7e; background: #fff5f5; font-style: italic; }
        .bubble > :first-child { margin-top: 0; }
        .bubble > :last-child { margin-bottom: 0; }
        .bubble p { margin: 0 0 9px; }
        .bubble ul, .bubble ol { margin: 7px 0 10px; padding-left: 23px; }
        .bubble h1, .bubble h2, .bubble h3 { margin: 12px 0 7px; line-height: 1.2; }
        .bubble h1 { font-size: 20px; } .bubble h2 { font-size: 18px; } .bubble h3 { font-size: 16px; }
        .bubble code { font: 12px ui-monospace, monospace; background: #edf2f7; padding: 2px 4px; border-radius: 4px; }
        .rendered-link { color: #0a66c2; text-decoration: underline; font-weight: 650; }
        .link-arrow { text-decoration: none; font-size: 11px; }
        .badges { width: min(90%, 920px); min-height: 5px; padding: 6px 4px 0; }
        .badge { display: inline-block; padding: 4px 7px; margin: 0 5px 3px 0; border-radius: 999px; font-size: 10px; font-weight: 900; letter-spacing: .04em; }
        .badge.before { color: #992f2f; background: #ffe3e3; border: 1px solid #f6b4b4; }
        .badge.after { color: #126245; background: #dcf8ed; border: 1px solid #9dddc7; }
        .footer { margin: 0 22px 22px; padding: 15px 20px; border-radius: 12px; background: #fff9e8; border: 1px solid #e6cf8b; color: #5c4a16; font-size: 13px; }
      </style>
    </head>
    <body>
      <header class="page-header">
        <div class="kicker">Conversation ${comparison.index} · Complete database transcript</div>
        <h1>${escapeHtml(comparison.title)}</h1>
        <p>Original July 9 conversation on the left; exact tester messages replayed against the improved deployed chat function on the right.</p>
      </header>
      <main class="comparison">
        ${panelMarkup('BEFORE · Original', comparison.before, beforeMessages, 'before')}
        ${panelMarkup('AFTER · Full replay', comparison.after, afterMessages, 'after')}
      </main>
      <div class="footer">All timestamps are shown in America/Los_Angeles. “Gap” means the database contains no assistant message before the tester's next message. The replay sent every tester message in its original order, even when an improved earlier response changed the natural follow-up.</div>
    </body>
  </html>`;
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 2400, height: 1200 }, deviceScaleFactor: 1 });
  for (const comparison of comparisons) {
    const [beforeMessages, afterMessages] = await Promise.all([
      messagesFor(comparison.before),
      messagesFor(comparison.after),
    ]);
    await page.setContent(pageMarkup(comparison, beforeMessages, afterMessages), { waitUntil: 'load' });
    const outputPath = path.join(
      outputDirectory,
      `${String(comparison.index).padStart(2, '0')}-${comparison.key}-before-after.png`,
    );
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(JSON.stringify({
      index: comparison.index,
      key: comparison.key,
      before_id: comparison.before,
      after_id: comparison.after,
      before_messages: beforeMessages.length,
      after_messages: afterMessages.length,
      width: 2400,
      height,
      output: outputPath,
    }));
  }
} finally {
  await browser.close();
}
