#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://127.0.0.1:43111/';
const mode = process.argv[3] === 'before' ? 'before' : 'after';
const outputDir = resolve(process.argv[4] || `docs/qa/opt2608/${mode}`);
mkdirSync(outputDir, { recursive: true });

const before = mode === 'before';
const conversationId = '00000000-0000-4000-8000-000000000001';

const oneSeat = {
  provider_id: 2012,
  provider_name: 'One-Seat Regional Ride',
  provider_type: 'ADA Paratransit',
  routing_type: 'door-to-door',
  schedule_type: { type: 'in-advance-book', advance_notice: '1-3 days' },
  fare: { type: 'fixed', cost: '$3.00' },
  booking: { method: 'call', details: '(925) 680-2134' },
  eligibility_reqs: 'Requires ADA certification.',
  service_hours_known: true,
};

const westcat = {
  provider_id: 2007,
  provider_name: 'WestCAT Paratransit',
  provider_type: 'ADA Paratransit',
  routing_type: 'door-to-door',
  schedule_type: before
    ? { type: 'in-advance-book', advance_notice: '1-7 days' }
    : {
        type: 'in-advance-book',
        advance_notice: '1-3 days',
        regional_advance_notice: 'up to 14 days',
      },
  booking: { method: 'call', details: '(510) 724-7433' },
  eligibility_reqs: before ? 'Requires ADA certification.' : 'Requires ADA paratransit eligibility.',
  service_hours_known: true,
};

const eastBay = {
  provider_id: 2009,
  provider_name: 'East Bay Paratransit',
  provider_type: 'ADA Paratransit',
  routing_type: 'door-to-door',
  schedule_type: { type: 'in-advance-book', advance_notice: '1-7 days' },
  booking: { method: 'call', details: '(510) 287-5000' },
  eligibility_reqs: before ? 'Requires ADA certification.' : 'Requires ADA paratransit eligibility.',
  service_hours_known: true,
};

const transit = before
  ? {
      summary: 'Transit option',
      duration_text: '35 mins',
      distance_text: '9.2 mi',
      start_address: 'Lafayette, CA',
      end_address: 'Martinez, CA',
      steps: [],
    }
  : {
      routing_status: 'handoff_only',
      google_maps_url: 'https://www.google.com/maps/dir/?api=1&origin=Lafayette%2C+CA&destination=Martinez%2C+CA&travelmode=transit',
      start_address: 'Lafayette, CA',
      end_address: 'Martinez, CA',
      steps: [],
    };

const providers = before ? [oneSeat, westcat, eastBay] : [westcat, eastBay];
const message = before
  ? 'One-Seat Regional Ride is available for $3. WestCAT Paratransit needs 1–7 days notice. East Bay Paratransit requires ADA certification. Public Transit is also available.'
  : 'WestCAT Paratransit takes ordinary reservations 1–3 days ahead and regional reservations up to 14 days ahead. East Bay Paratransit requires ADA paratransit eligibility. For cross-area travel, the participating agencies coordinate the connection; One Seat Ride is not a separate provider or fare. Use Google Maps to plan fixed-route transit.';

const searchResult = {
  status: 'complete',
  trip_type: 'one_way',
  travel_date: '2026-08-31',
  travel_date_display: 'Monday, August 31, 2026',
  departure_time: '10:00 AM',
  source_address: 'Lafayette, CA',
  destination_address: 'Martinez, CA',
  source_coordinates: { lat: 37.8858, lng: -122.118 },
  destination_coordinates: { lat: 38.0194, lng: -122.1341 },
  data: providers,
  verification_required: [],
  excluded_providers: [],
  public_transit: transit,
  public_transit_available: !before,
  total_found: providers.length,
};

async function mockApis(page) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      await route.continue();
      return;
    }

    const path = url.pathname;
    const json = (body) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (path.endsWith('/health')) return json({ status: 'ok' });
    if (path.endsWith('/providers') && request.method() === 'GET') {
      return json({
        data: [{
          provider_id: 1002,
          provider_name: 'Tri Delta Transit',
          provider_type: 'Fixed Route',
          routing_type: 'fixed-routes',
          eligibility_reqs: before ? 'Open to all' : null,
          service_area_source: before ? 'remote_geojson' : 'unresolved',
          service_area_notes: before
            ? 'Current displayed boundary'
            : 'Public boundary quarantined pending approval of an authoritative route-network source.',
          has_service_zone: before,
          service_zone: before
            ? {
                type: 'FeatureCollection',
                features: [{
                  type: 'Feature',
                  properties: { provider_name: 'Tri Delta Transit' },
                  geometry: {
                    type: 'Polygon',
                    coordinates: [[
                      [-122.15, 37.85], [-121.65, 37.85], [-121.65, 38.15],
                      [-122.15, 38.15], [-122.15, 37.85],
                    ]],
                  },
                }],
              }
            : null,
        }],
      });
    }
    if (path.endsWith('/conversations') && request.method() === 'POST') {
      return json({ id: conversationId, title: 'Visual evidence' });
    }
    if (path.includes('/chat-examples')) return json({ data: [] });
    if (path.endsWith('/chat') && request.method() === 'POST') {
      return json({
        message,
        attachments: [{
          type: 'provider_search',
          data: searchResult,
          metadata: { tool_name: 'assess_eligibility' },
        }],
      });
    }
    if (path.includes('/service-zone')) {
      return json(before
        ? {
            provider_id: 1002,
            has_service_zone: true,
            raw_data: {
              type: 'FeatureCollection',
              features: [{
                type: 'Feature',
                properties: { provider_name: 'Tri Delta Transit' },
                geometry: {
                  type: 'Polygon',
                  coordinates: [[
                    [-122.15, 37.85], [-121.65, 37.85], [-121.65, 38.15],
                    [-122.15, 38.15], [-122.15, 37.85],
                  ]],
                },
              }],
            },
          }
        : { provider_id: 1002, has_service_zone: false, raw_data: null });
    }
    return json({});
  });
}

async function dismissWelcome(page) {
  const button = page.getByRole('button', { name: 'Get started' });
  const appeared = await button.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
  if (appeared) await button.click();
}

async function openReadyPage(browser, viewport, recordVideo = false) {
  const context = await browser.newContext({
    viewport,
    recordVideo: recordVideo ? { dir: outputDir, size: viewport } : undefined,
  });
  const page = await context.newPage();
  await mockApis(page);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  const textarea = page.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea');
    return input && !input.disabled;
  }, null, { timeout: 30_000 });
  return { context, page, textarea };
}

async function sendScenario(page, textarea) {
  await textarea.fill('I need to travel from Lafayette to Martinez on August 31 at 10 AM.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('[data-provider-name="WestCAT Paratransit"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
}

async function saveVideo(page, context, name) {
  const video = page.video();
  await page.close();
  await context.close();
  if (video) {
    const originalPath = await video.path();
    const targetPath = resolve(outputDir, name);
    await video.saveAs(targetPath);
    if (originalPath !== targetPath) rmSync(originalPath, { force: true });
  }
}

const browser = await chromium.launch({ headless: true });
try {
  {
    const { context, page, textarea } = await openReadyPage(browser, { width: 1440, height: 900 }, true);
    await sendScenario(page, textarea);
    const bodyText = await page.locator('body').innerText();
    assert.equal(bodyText.includes('One-Seat Regional Ride'), before);
    assert.equal(/ADA certification/i.test(bodyText), before);
    assert.equal(bodyText.includes('Regional trips may be booked up to 14 days in advance.'), !before);
    assert.equal(await page.getByRole('link', { name: 'Open in Google Maps' }).count() > 0, !before);
    assert.equal(await page.getByTestId('save-example-at-end').count() > 0, !before);
    if (!before) assert.equal(await page.locator('.origin-destination-orientation-line').count(), 0);
    await page.screenshot({ path: resolve(outputDir, 'OPT260810-02-one-seat.png'), fullPage: true });
    await page.screenshot({ path: resolve(outputDir, 'OPT260813-04-one-seat-logic.png'), fullPage: true });
    await page.locator('[data-provider-name="WestCAT Paratransit"]').screenshot({ path: resolve(outputDir, 'OPT260813-01-westcat.png') });
    await page.locator('[data-provider-name="East Bay Paratransit"]').screenshot({ path: resolve(outputDir, 'OPT260813-03-ada-terminology.png') });
    await page.locator('[data-provider-kind="public-transit"]').screenshot({ path: resolve(outputDir, 'OPT260813-02-fixed-route.png') });
    await page.screenshot({ path: resolve(outputDir, 'OPT260817-01-save-example.png'), fullPage: true });
    await saveVideo(page, context, 'OPT260810-02-and-OPT260813-04-trip-flow.webm');
  }

  {
    const { context, page, textarea } = await openReadyPage(browser, { width: 390, height: 844 }, true);
    await sendScenario(page, textarea);
    assert.equal(await page.locator('.leaflet-container').count() > 0, before);
    if (!before) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
    await page.screenshot({ path: resolve(outputDir, 'OPT260813-06-mobile-layout.png'), fullPage: true });
    await page.evaluate(() => document.querySelector('.chat-messages')?.scrollTo({ top: 99999, behavior: 'instant' }));
    await page.waitForTimeout(500);
    await saveVideo(page, context, 'OPT260813-06-mobile-layout.webm');
  }

  {
    const { context, page } = await openReadyPage(browser, { width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Service Map' }).click();
    await page.waitForTimeout(750);
    await page.getByText('Tri Delta Transit', { exact: true }).click();
    await page.waitForTimeout(750);
    await page.screenshot({ path: resolve(outputDir, 'OPT260813-05-tri-delta-pending.png'), fullPage: true });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`OPT2608 ${mode} evidence written to ${outputDir}`);
