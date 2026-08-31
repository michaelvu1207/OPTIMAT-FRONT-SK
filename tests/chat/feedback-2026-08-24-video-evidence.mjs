#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const mode = process.argv[3] === 'before' ? 'before' : 'after';
const outputDir = resolve(process.argv[4] || `docs/qa/feedback-2026-08-24/${mode}`);
const fixturePath = resolve('tests/chat/feedback-2026-08-24.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
mkdirSync(outputDir, { recursive: true });

const before = mode === 'before';
const conversationId = '00000000-0000-4000-8000-000000000824';

const providerCatalog = {
  lamorinda: {
    provider_id: 4022,
    provider_name: 'Lamorinda Spirit',
    provider_type: 'Non-ADA Paratransit',
    eligibility_reqs: 'Senior (60+) or disabled (18+), and resident of Lafayette, Moraga, or Orinda.',
  },
  rossmoor: {
    provider_id: 3013,
    provider_name: 'Rossmoor Dial-A-Bus',
    provider_type: 'Volunteer Driver or TNC Programs',
    eligibility_reqs: 'Rossmoor community resident with valid Rossmoor ID.',
  },
  link: {
    provider_id: 2006,
    provider_name: 'LINK Paratransit',
    provider_type: 'ADA Paratransit',
    eligibility_reqs: 'Requires approved ADA paratransit eligibility.',
  },
  mobility: {
    provider_id: 4021,
    provider_name: 'Mobility Matters',
    provider_type: 'Volunteer Driver or TNC',
    eligibility_reqs: 'Age 60+ or veteran, Contra Costa County resident; provider verifies additional conditions.',
    service_hours_known: false,
  },
  seniorVan: {
    provider_id: 3017,
    provider_name: 'Senior Express Van (San Ramon)',
    provider_type: 'Non-ADA Paratransit',
    eligibility_reqs: 'Senior (55+).',
  },
  goSanRamon: {
    provider_id: 5028,
    provider_name: 'Go San Ramon!',
    provider_type: 'Volunteer Driver or TNC Programs',
    eligibility_reqs: 'San Ramon resident.',
  },
  wcMini: {
    provider_id: 4025,
    provider_name: 'Walnut Creek Mini Bus',
    provider_type: 'Non-ADA Paratransit',
    eligibility_reqs: 'Senior (60+) or disabled (18+), and Walnut Creek resident.',
  },
  wcLyft: {
    provider_id: 5031,
    provider_name: 'Walnut Creek Lyft Self Access Pass',
    provider_type: 'Volunteer Driver or TNC',
    eligibility_reqs: 'Senior (60+) or disabled (18+), with an approved local residence.',
  },
};

for (const provider of Object.values(providerCatalog)) {
  provider.routing_type = 'door-to-door';
  provider.booking = { method: 'call', details: 'Contact provider to verify and reserve' };
  provider.service_hours_known ??= true;
}

const configurations = {
  'WC-RESIDENCE': {
    before: ['lamorinda'], after: ['wcMini'],
    beforeMessage: 'Lamorinda Spirit is available for this Walnut Creek trip.',
    afterMessage: 'Walnut Creek Mini Bus may match. Lamorinda Spirit is excluded because you live in Walnut Creek, not Lafayette, Moraga, or Orinda.',
  },
  'WC-65-DISABLED-ADA': {
    before: ['lamorinda', 'rossmoor', 'wcMini'], after: ['wcMini', 'wcLyft'],
    beforeMessage: 'You qualify for Lamorinda Spirit, Rossmoor Dial-A-Bus, and Walnut Creek Mini Bus.',
    afterMessage: 'You may qualify for the Walnut Creek programs. Lamorinda requires Lamorinda residence, and Rossmoor requires Rossmoor residency and ID.',
  },
  'WC-65-NOT-DISABLED': {
    before: ['link', 'lamorinda', 'mobility'], after: ['mobility', 'wcLyft'],
    beforeMessage: 'LINK and Lamorinda Spirit are available, along with Mobility Matters.',
    afterMessage: 'You may qualify for Mobility Matters and the Walnut Creek Lyft program. LINK does not match the disability/ADA facts provided, and Lamorinda requires Lamorinda residence.',
  },
  'WC-55-NOT-DISABLED': {
    before: ['link', 'lamorinda', 'mobility', 'wcLyft'], after: [], verification: ['mobility'], nextQuestion: 'veteran',
    beforeMessage: 'LINK, Lamorinda Spirit, Mobility Matters, and Walnut Creek Lyft are options.',
    afterMessage: 'The known facts rule out LINK, Lamorinda, and the 60+ Walnut Creek programs. Are you a veteran? That answer could change whether Mobility Matters may fit.',
  },
  'WC-55-DISABLED-ADA': {
    before: ['lamorinda', 'link', 'wcLyft'], after: ['link', 'wcLyft'],
    beforeMessage: 'Lamorinda Spirit, LINK, and Walnut Creek Lyft can serve this trip.',
    afterMessage: 'You may qualify for LINK and Walnut Creek Lyft. Lamorinda Spirit is excluded because its residence requirement does not include Walnut Creek.',
  },
  'SR-65-DISABLED-ADA': {
    before: ['goSanRamon', 'link', 'mobility'], after: ['goSanRamon', 'link', 'mobility'],
    beforeMessage: 'Go San Ramon, LINK, and Mobility Matters are available.',
    afterMessage: 'You may qualify for these listed programs. Senior Express Van is not shown as available because its stored schedule does not cover the requested 3 PM return; the data team must confirm that schedule.',
  },
  'SR-65-NOT-DISABLED': {
    before: ['goSanRamon', 'link', 'mobility'], after: ['goSanRamon', 'mobility'],
    beforeMessage: 'Go San Ramon, LINK, and Mobility Matters are available.',
    afterMessage: 'You may qualify for Go San Ramon and Mobility Matters. LINK is excluded from the facts provided. Senior Express requires schedule confirmation for the 3 PM return.',
  },
  'SR-55-NOT-DISABLED': {
    before: ['goSanRamon', 'link', 'mobility'], after: ['goSanRamon'], verification: ['mobility'], nextQuestion: 'veteran',
    beforeMessage: 'Go San Ramon, LINK, and Mobility Matters are options.',
    afterMessage: 'Go San Ramon may fit. LINK is excluded. Are you a veteran? That could change Mobility Matters. Senior Express still requires schedule-data confirmation.',
  },
  'SR-55-DISABLED-ADA': {
    before: ['goSanRamon', 'link'], after: ['goSanRamon', 'link'],
    beforeMessage: 'Go San Ramon and LINK are available. Senior Express is missing.',
    afterMessage: 'You may qualify for Go San Ramon and LINK. Senior Express is not asserted as available until its scheduled-return data is confirmed; LINK prioritization remains a product-policy decision.',
  },
  'RICHMOND-65-NOT-ADA': {
    before: ['mobility'], after: ['mobility'],
    beforeMessage: 'You qualify for Mobility Matters.',
    afterMessage: 'You may qualify for Mobility Matters based on age and county residence. Confirm the requested time and the program’s additional conditions with the provider.',
  },
  'RICHMOND-55-DISABLED-ADA': {
    before: ['mobility'], after: [], verification: ['mobility'], nextQuestion: 'veteran',
    beforeMessage: 'You may qualify for Mobility Matters.',
    afterMessage: 'Age 55 and disability alone do not establish a Mobility Matters match. Are you a veteran? That answer could change the result.',
  },
  'RICHMOND-WC-65-ADA': {
    before: ['mobility'], after: ['mobility'],
    beforeMessage: 'Mobility Matters is available, but One-Seat is missing.',
    afterMessage: 'You may qualify for Mobility Matters. One-Seat is not asserted for this Richmond origin until participating-agency coverage is confirmed by the data team.',
  },
  'RICHMOND-WC-65-NOT-DISABLED': {
    before: ['mobility'], after: ['mobility'],
    beforeMessage: 'Mobility Matters may fit; One-Seat is not recommended.',
    afterMessage: 'You may qualify for Mobility Matters based on age and county residence. One-Seat is not recommended from the facts and network data currently confirmed.',
  },
  'RICHMOND-WC-55-ADA': {
    before: ['mobility'], after: [], verification: ['mobility'], nextQuestion: 'veteran',
    beforeMessage: 'Mobility Matters is available, but One-Seat is missing.',
    afterMessage: 'Mobility Matters cannot be recommended from age and disability alone. Are you a veteran? One-Seat also remains pending participating-agency data for this origin.',
  },
};

function provider(key, qualified) {
  return {
    ...providerCatalog[key],
    eligibility_status: qualified ? 'eligible' : 'verification_required',
    eligibility_reason: qualified ? 'The known rider facts match the stored screening rule.' : 'One rider fact is still unknown.',
    missing_facts: qualified ? undefined : ['veteran'],
  };
}

function resultFor(scenario) {
  const config = configurations[scenario.id];
  assert(config, `Missing video configuration for ${scenario.id}`);
  const eligibleKeys = before ? config.before : config.after;
  const verificationKeys = before ? [] : (config.verification || []);
  return {
    message: before ? config.beforeMessage : config.afterMessage,
    result: {
      status: 'complete',
      trip_type: 'round_trip',
      travel_date: '2026-08-31',
      travel_date_display: 'Reviewed feedback scenario',
      departure_time: '12:00 PM',
      return_time: '3:00 PM',
      source_address: scenario.trip.split(' to ')[0],
      destination_address: scenario.trip.includes(' to ') ? scenario.trip.split(' to ')[1] : scenario.trip,
      data: eligibleKeys.map((key) => provider(key, true)),
      verification_required: verificationKeys.map((key) => provider(key, false)),
      excluded_providers: [],
      next_question: config.nextQuestion ? {
        field: config.nextQuestion,
        candidates_if_known: verificationKeys.length,
        provider_names: verificationKeys.map((key) => providerCatalog[key].provider_name),
      } : null,
      total_found: eligibleKeys.length,
      public_transit: null,
    },
  };
}

async function mockApis(page, scenario) {
  const payload = resultFor(scenario);
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/health')) return json({ status: 'ok' });
    if (url.pathname.endsWith('/providers') && request.method() === 'GET') return json({ data: [] });
    if (url.pathname.endsWith('/conversations') && request.method() === 'POST') return json({ id: conversationId });
    if (url.pathname.includes('/chat-examples')) return json({ data: [] });
    if (url.pathname.endsWith('/chat') && request.method() === 'POST') {
      return json({
        message: payload.message,
        attachments: [{
          type: 'provider_search',
          data: payload.result,
          metadata: { tool_name: 'assess_eligibility' },
        }],
      });
    }
    return json({});
  });
}

async function dismissWelcome(page) {
  const button = page.getByRole('button', { name: 'Get started' });
  await page.waitForTimeout(300);
  if (await button.isVisible()) {
    await button.click();
    await button.waitFor({ state: 'hidden', timeout: 5_000 });
  }
}

async function recordScenario(browser, scenario) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: outputDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await mockApis(page, scenario);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const textarea = page.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea');
    return input && !input.disabled;
  }, null, { timeout: 30_000 });
  await dismissWelcome(page);

  const rider = Object.entries(scenario.rider).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(', ');
  const submittedMessage = `${scenario.trip}. Rider facts: ${rider}.`;
  await textarea.fill(submittedMessage);
  await page.getByRole('button', { name: 'Send message' }).click();
  const payload = resultFor(scenario);
  await page.getByText(payload.message, { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_200);

  const body = await page.locator('body').innerText();
  assert(body.includes(payload.message));
  const expectedNames = (before ? configurations[scenario.id].before : configurations[scenario.id].after)
    .map((key) => providerCatalog[key].provider_name);
  for (const name of expectedNames) assert(body.includes(name), `${scenario.id} missing ${name}`);

  // Turn the page into a focused evidence canvas containing only the submitted rider message and
  // its assistant response/provider embeds. The generated videos should be readable without the
  // map, navigation, composer, feedback prompt, or other application chrome.
  await page.evaluate(({ userText, assistantText, scenarioId }) => {
    const messageContainer = document.querySelector('.chat-messages');
    if (!messageContainer) throw new Error('Chat message container not found');
    const children = [...messageContainer.children];
    const userRow = children.find((element) => element.textContent?.includes(userText));
    const assistantRow = children.find((element) => element.textContent?.includes(assistantText));
    if (!userRow || !assistantRow) throw new Error(`Could not isolate message rows for ${scenarioId}`);

    const canvas = document.createElement('main');
    canvas.id = 'evidence-message-canvas';
    canvas.setAttribute('aria-label', `${scenarioId} message comparison`);
    Object.assign(canvas.style, {
      width: '920px',
      maxWidth: 'calc(100vw - 48px)',
      margin: '0 auto',
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      boxSizing: 'border-box',
    });
    canvas.append(userRow.cloneNode(true), assistantRow.cloneNode(true));

    document.body.replaceChildren(canvas);
    Object.assign(document.documentElement.style, {
      background: 'white',
      colorScheme: 'light',
      overflow: 'hidden',
    });
    Object.assign(document.body.style, {
      margin: '0',
      minHeight: '100vh',
      background: 'white',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    });

    const availableHeight = window.innerHeight - 32;
    const naturalHeight = canvas.scrollHeight;
    if (naturalHeight > availableHeight) {
      canvas.style.zoom = String(Math.max(0.62, availableHeight / naturalHeight));
    }
  }, { userText: submittedMessage, assistantText: payload.message, scenarioId: scenario.id });
  await page.waitForTimeout(2_500);

  await page.screenshot({ path: resolve(outputDir, `${scenario.id}.png`), fullPage: true });
  const video = page.video();
  await page.close();
  await context.close();
  if (video) {
    const original = await video.path();
    const raw = resolve(outputDir, `${scenario.id}.raw.webm`);
    const target = resolve(outputDir, `${scenario.id}.webm`);
    await video.saveAs(raw);
    if (original !== raw) rmSync(original, { force: true });
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-sseof', '-2.4', '-i', raw,
      '-an', '-c:v', 'libvpx-vp9', '-crf', '31', '-b:v', '0', target,
    ]);
    rmSync(raw, { force: true });
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of fixture.scenarios) await recordScenario(browser, scenario);
} finally {
  await browser.close();
}

writeFileSync(resolve(outputDir, 'manifest.json'), JSON.stringify({
  mode,
  fixture: fixture.source,
  captured_at: new Date().toISOString(),
  viewport: '1280x720',
  scenarios: fixture.scenarios.map((scenario) => scenario.id),
}, null, 2));

console.log(`Feedback ${mode} evidence written to ${outputDir}`);
