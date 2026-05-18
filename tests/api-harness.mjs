#!/usr/bin/env node
/**
 * OPTIMAT API Test Harness
 *
 * Tests all Supabase Edge Function endpoints and snapshots responses.
 * Designed to run against both the current Supabase backend and the
 * future AWS Lambda backend to validate migration correctness.
 *
 * Usage:
 *   node tests/api-harness.mjs                          # test current Supabase
 *   node tests/api-harness.mjs --target aws             # test AWS Lambda backend
 *   node tests/api-harness.mjs --compare                # run both & diff
 *   node tests/api-harness.mjs --snapshot               # save response snapshots
 *   node tests/api-harness.mjs --from-snapshot <file>    # compare against saved snapshot
 *   node tests/api-harness.mjs --only chat,providers     # run specific groups
 *   node tests/api-harness.mjs --skip chat               # skip specific groups
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = resolve(__dirname, 'snapshots');

// ─── Configuration ──────────────────────────────────────────────────────────

const ENV_PATH = resolve(__dirname, '..', '.env');
let envVars = {};
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

const TARGETS = {
  supabase: {
    baseUrl: envVars.VITE_SUPABASE_URL
      ? `${envVars.VITE_SUPABASE_URL}/functions/v1`
      : 'https://htjohidcoyfuwfjecazu.supabase.co/functions/v1',
    anonKey: envVars.VITE_SUPABASE_ANON_KEY || '',
  },
  aws: {
    baseUrl: process.env.AWS_API_URL || 'https://api.optimat.us',
    anonKey: process.env.AWS_API_KEY || envVars.VITE_SUPABASE_ANON_KEY || '',
  },
};

// ─── CLI arg parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return null;
  return args[idx + 1] || true;
}
const hasFlag = (name) => args.includes(`--${name}`);

const targetName = getArg('target') || 'supabase';
const doCompare = hasFlag('compare');
const doSnapshot = hasFlag('snapshot');
const fromSnapshot = getArg('from-snapshot');
const onlyGroups = getArg('only')?.split?.(',');
const skipGroups = getArg('skip')?.split?.(',');
const verbose = hasFlag('verbose') || hasFlag('v');

// ─── Helpers ────────────────────────────────────────────────────────────────

function headers(target) {
  return {
    Authorization: `Bearer ${target.anonKey}`,
    apikey: target.anonKey,
    'Content-Type': 'application/json',
  };
}

async function request(target, method, path, body = null, timeoutMs = 15000) {
  const url = `${target.baseUrl}/${path}`;
  const opts = { method, headers: headers(target) };
  if (body && (method === 'POST' || method === 'PUT')) {
    opts.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  opts.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, opts);
    const elapsed = Date.now() - start;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, text, elapsed, error: null };
  } catch (err) {
    return { status: 0, ok: false, json: null, text: '', elapsed: Date.now() - start, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Test result tracking ───────────────────────────────────────────────────

const results = [];
let cleanupFns = [];

function record(group, name, result) {
  const passed = result.ok && !result.error;
  results.push({ group, name, passed, status: result.status, elapsed: result.elapsed, error: result.error });

  const icon = passed ? '✅' : '❌';
  const ms = `${result.elapsed}ms`.padStart(7);
  const statusStr = result.status ? `${result.status}` : 'ERR';
  console.log(`  ${icon} ${statusStr.padStart(3)} ${ms}  ${name}`);
  if (!passed && verbose) {
    console.log(`         Error: ${result.error || result.text?.slice(0, 200)}`);
  }
  return result;
}

function recordCustom(group, name, passed, details = {}) {
  results.push({ group, name, passed, status: details.status || 0, elapsed: details.elapsed || 0, error: details.error || null });
  const icon = passed ? '✅' : '❌';
  const ms = `${details.elapsed || 0}ms`.padStart(7);
  console.log(`  ${icon} ${(details.status || '').toString().padStart(3)} ${ms}  ${name}`);
  if (!passed && verbose && details.error) {
    console.log(`         Error: ${details.error}`);
  }
}

function hasOwnDeep(value, key) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasOwnDeep(item, key));
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((item) => hasOwnDeep(item, key));
}

function featureCount(zone) {
  if (!zone || typeof zone !== 'object') return 0;
  if (zone.type === 'FeatureCollection' && Array.isArray(zone.features)) {
    return zone.features.length;
  }
  if (zone.type === 'Feature' || zone.type === 'Polygon' || zone.type === 'MultiPolygon') {
    return 1;
  }
  return 0;
}

// ─── Snapshot helpers ───────────────────────────────────────────────────────

const snapshots = {};

function captureSnapshot(group, name, result) {
  if (!snapshots[group]) snapshots[group] = {};
  snapshots[group][name] = {
    status: result.status,
    json: result.json,
    ok: result.ok,
  };
}

function normalizeForComparison(obj) {
  // Strip volatile fields (timestamps, IDs) for structural comparison
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(normalizeForComparison);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (['id', 'created_at', 'updated_at', 'timestamp', 'conversation_id', 'message_id'].includes(k)) continue;
      out[k] = normalizeForComparison(v);
    }
    return out;
  }
  return obj;
}

// ─── Test groups ────────────────────────────────────────────────────────────

async function testHealth(target) {
  console.log('\n📡 Health');
  const r = await request(target, 'GET', 'health');
  record('health', 'GET /health', r);
  captureSnapshot('health', 'GET /health', r);

  // Validate shape
  if (r.json) {
    recordCustom('health', 'health response has status field', r.json.status === 'ok', { status: r.status, elapsed: 0 });
  }
}

async function testProviders(target) {
  console.log('\n🚌 Providers');

  // GET all providers
  const all = await request(target, 'GET', 'providers');
  record('providers', 'GET /providers', all);
  captureSnapshot('providers', 'GET /providers', all);

  const providerList = all.json?.data;
  const providerCount = Array.isArray(providerList) ? providerList.length : 0;
  recordCustom('providers', `providers count > 0 (got ${providerCount})`, providerCount > 0, { elapsed: 0 });
  recordCustom('providers', `providers count matches workbook import (got ${providerCount})`, providerCount === 29, {
    elapsed: 0,
    error: providerCount === 29 ? null : 'expected 29 providers from Updated providers import',
  });
  recordCustom('providers', 'GET /providers does not expose contacts', !hasOwnDeep(providerList, 'contacts'), { elapsed: 0 });

  // Validate provider shape
  if (providerCount > 0) {
    const p = providerList[0];
    const hasRequiredFields = p.provider_name && p.provider_type;
    recordCustom('providers', 'provider has required fields (provider_name, provider_type)', !!hasRequiredFields, { elapsed: 0 });
    const hasServiceMetadata = [
      'service_area_cities',
      'service_area_source',
      'service_area_notes',
      'provider_software',
    ].every((field) => Object.prototype.hasOwnProperty.call(p, field));
    recordCustom('providers', 'provider includes service-area metadata fields', hasServiceMetadata, { elapsed: 0 });
  }

  // GET single provider
  let testProviderId = null;
  if (providerCount > 0) {
    testProviderId = providerList[0].provider_id || providerList[0].id;
    const single = await request(target, 'GET', `providers/${testProviderId}`);
    record('providers', `GET /providers/${testProviderId}`, single);
    recordCustom('providers', `GET /providers/${testProviderId} does not expose contacts`, !hasOwnDeep(single.json, 'contacts'), {
      status: single.status,
      elapsed: 0,
    });
    captureSnapshot('providers', 'GET /providers/:id', single);

    const rejectedUpdate = await request(target, 'PUT', `providers/${testProviderId}`, {
      provider_name: '__harness_should_not_save__',
    });
    const updateRejected = rejectedUpdate.status === 401 || rejectedUpdate.status === 405;
    recordCustom('providers', `PUT /providers/${testProviderId} is rejected`, updateRejected, {
      status: rejectedUpdate.status,
      elapsed: rejectedUpdate.elapsed,
      error: updateRejected ? null : rejectedUpdate.text?.slice(0, 200),
    });
  }

  // GET provider service zone — pick one that actually has zone data
  const withZoneProv = providerList?.find((p) => p.has_service_zone && p.service_zone);
  const zoneProviderId = withZoneProv?.provider_id || withZoneProv?.id || testProviderId;
  if (zoneProviderId) {
    const zone = await request(target, 'GET', `providers/${zoneProviderId}/service-zone`);
    const zoneOk = Boolean(zone.ok && zone.json?.has_service_zone && (zone.json?.raw_data || zone.json?.service_zone));
    recordCustom('providers', `GET /providers/${zoneProviderId}/service-zone`, zoneOk, { status: zone.status, elapsed: zone.elapsed });
    captureSnapshot('providers', 'GET /providers/:id/service-zone', zone);
  }

  // Search providers
  const search = await request(target, 'GET', 'providers/search?q=transit');
  record('providers', 'GET /providers/search?q=transit', search);
  captureSnapshot('providers', 'GET /providers/search', search);

  // GET map GeoJSON
  const map = await request(target, 'GET', 'providers/map');
  record('providers', 'GET /providers/map', map);
  captureSnapshot('providers', 'GET /providers/map', map);

  // POST filter providers
  const filter = await request(target, 'POST', 'providers/filter', {
    source_address: '1000 Broadway, Oakland, CA',
    destination_address: '500 Terry Francine St, San Francisco, CA',
  });
  record('providers', 'POST /providers/filter', filter);
  captureSnapshot('providers', 'POST /providers/filter', filter);

  if (filter.json?.data) {
    recordCustom('providers', `filter returned providers (got ${filter.json.data.length})`, Array.isArray(filter.json.data), { elapsed: 0 });
    recordCustom('providers', 'POST /providers/filter does not expose contacts', !hasOwnDeep(filter.json.data, 'contacts'), { elapsed: 0 });
  }
}

async function testGeocode(target) {
  console.log('\n📍 Geocode');

  const r = await request(target, 'GET', 'geocode?address=' + encodeURIComponent('1000 Broadway, Oakland, CA'));
  record('geocode', 'GET /geocode?address=...', r);
  captureSnapshot('geocode', 'GET /geocode', r);

  if (r.json) {
    const hasCoords = (r.json.lat && r.json.lng) || r.json.coordinates;
    recordCustom('geocode', 'geocode returned coordinates', !!hasCoords, { elapsed: 0 });
    if (r.json.lat) {
      const latOk = Math.abs(r.json.lat - 37.8) < 0.5;
      const lngOk = Math.abs(r.json.lng - (-122.27)) < 0.5;
      recordCustom('geocode', 'coordinates are in Oakland area', latOk && lngOk, { elapsed: 0 });
    }
  }
}

async function testDirections(target) {
  console.log('\n🗺️  Directions');

  const r = await request(target, 'POST', 'directions', {
    origin: '1000 Broadway, Oakland, CA',
    destination: '500 Market St, San Francisco, CA',
    mode: 'driving',
  });
  record('directions', 'POST /directions (driving)', r);
  captureSnapshot('directions', 'POST /directions driving', r);

  if (r.json) {
    const hasDist = !!(r.json.distance || r.json.distance_text || r.json.distance_meters);
    const hasDur = !!(r.json.duration || r.json.duration_text || r.json.duration_seconds);
    recordCustom('directions', 'directions has distance', hasDist, { elapsed: 0 });
    recordCustom('directions', 'directions has duration', hasDur, { elapsed: 0 });
  }

  // Transit mode
  const transit = await request(target, 'POST', 'directions', {
    origin: '1000 Broadway, Oakland, CA',
    destination: '500 Market St, San Francisco, CA',
    mode: 'transit',
  });
  record('directions', 'POST /directions (transit)', transit);
  captureSnapshot('directions', 'POST /directions transit', transit);
}

async function testConversations(target) {
  console.log('\n💬 Conversations & Messages');

  // Create conversation
  const create = await request(target, 'POST', 'conversations', { title: '__harness_test__' });
  record('conversations', 'POST /conversations (create)', create);
  captureSnapshot('conversations', 'POST /conversations', create);

  const convId = create.json?.id;
  if (!convId) {
    recordCustom('conversations', 'conversation created with id', false, { error: 'no id returned' });
    return;
  }
  recordCustom('conversations', 'conversation created with id', true, { elapsed: 0 });

  // Schedule cleanup
  cleanupFns.push(async () => {
    await request(target, 'DELETE', `conversations/${convId}`);
  });

  // Get conversation
  const get = await request(target, 'GET', `conversations/${convId}`);
  record('conversations', `GET /conversations/${convId}`, get);
  captureSnapshot('conversations', 'GET /conversations/:id', get);

  // List conversations
  const list = await request(target, 'GET', 'conversations');
  record('conversations', 'GET /conversations (list)', list);

  // Create message
  const msg = await request(target, 'POST', 'messages', {
    conversation_id: convId,
    role: 'human',
    content: 'Hello, this is a test message from the harness',
  });
  record('conversations', 'POST /messages', msg);
  captureSnapshot('conversations', 'POST /messages', msg);

  // Get messages
  const msgs = await request(target, 'GET', `messages?conversation_id=${convId}`);
  record('conversations', `GET /messages?conversation_id=${convId}`, msgs);
  captureSnapshot('conversations', 'GET /messages', msgs);

  if (Array.isArray(msgs.json)) {
    recordCustom('conversations', `messages returned (got ${msgs.json.length})`, msgs.json.length > 0, { elapsed: 0 });
  }

  // Delete conversation
  const del = await request(target, 'DELETE', `conversations/${convId}`);
  record('conversations', `DELETE /conversations/${convId}`, del);
  captureSnapshot('conversations', 'DELETE /conversations/:id', del);
  // Remove cleanup since we already deleted
  cleanupFns.pop();
}

async function testChat(target) {
  console.log('\n🤖 Chat (AI)');

  // First create a conversation for chat
  const conv = await request(target, 'POST', 'conversations', { title: '__harness_chat_test__' });
  const convId = conv.json?.id;
  if (!convId) {
    recordCustom('chat', 'create conversation for chat', false, { error: 'no id' });
    return;
  }
  cleanupFns.push(async () => {
    await request(target, 'DELETE', `conversations/${convId}`);
  });

  // Non-streaming chat
  const chat = await request(target, 'POST', 'chat', {
    conversation_id: convId,
    message: 'What paratransit providers serve Oakland, CA?',
    stream: false,
  }, 30000); // 30s timeout for AI
  record('chat', 'POST /chat (non-streaming)', chat);
  captureSnapshot('chat', 'POST /chat', chat);

  if (chat.json) {
    const hasMessage = !!(chat.json.message || chat.json.response);
    recordCustom('chat', 'chat returned a message', hasMessage, { elapsed: 0 });
  }

  // Streaming chat — just verify we get a 200 with SSE content-type
  const streamUrl = `${target.baseUrl}/chat`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const start = Date.now();
    const res = await fetch(streamUrl, {
      method: 'POST',
      headers: headers(target),
      body: JSON.stringify({
        conversation_id: convId,
        message: 'Hello',
        stream: true,
      }),
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    clearTimeout(timer);

    const ct = res.headers.get('content-type') || '';
    const isSSE = ct.includes('text/event-stream');
    const isJSON = ct.includes('application/json');

    recordCustom('chat', 'POST /chat (streaming) returns 200', res.ok, { status: res.status, elapsed });
    recordCustom('chat', 'streaming content-type is SSE or JSON', isSSE || isJSON, { elapsed: 0, error: isSSE || isJSON ? null : `got ${ct}` });

    // Consume and validate SSE events
    if (isSSE && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let eventCount = 0;
      let gotDone = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              eventCount++;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.event === 'done') gotDone = true;
              } catch {}
            }
          }
        }
      } catch {}
      recordCustom('chat', `streaming produced events (got ${eventCount})`, eventCount > 0, { elapsed: 0 });
      recordCustom('chat', 'streaming ended with done event', gotDone, { elapsed: 0 });
    }
  } catch (err) {
    recordCustom('chat', 'POST /chat (streaming)', false, { error: err.message });
  }

  // Cleanup
  await request(target, 'DELETE', `conversations/${convId}`);
  cleanupFns.pop();
}

async function testToolCalls(target) {
  console.log('\n🔧 Tool Calls');

  // Tool calls with a non-existent conversation — 404 is expected
  const r = await request(target, 'GET', 'tool-calls?conversation_id=00000000-0000-0000-0000-000000000000');
  const toolCallOk = r.ok || r.status === 404; // 404 expected for missing conversation
  recordCustom('tool-calls', 'GET /tool-calls?conversation_id=... (404 expected)', toolCallOk, { status: r.status, elapsed: r.elapsed });
  captureSnapshot('tool-calls', 'GET /tool-calls', r);

  // Also test with a real conversation that has tool calls
  const conv = await request(target, 'POST', 'conversations', { title: '__harness_toolcall_test__' });
  if (conv.json?.id) {
    const realR = await request(target, 'GET', `tool-calls?conversation_id=${conv.json.id}`);
    const realOk = realR.ok || realR.status === 404; // empty is fine
    recordCustom('tool-calls', 'GET /tool-calls with real conversation', realOk, { status: realR.status, elapsed: realR.elapsed });
    await request(target, 'DELETE', `conversations/${conv.json.id}`);
  }
}

async function testReplay(target) {
  console.log('\n🔄 Replay');

  // Replay with non-existent conversation — 404 expected
  const r = await request(target, 'GET', 'replay?conversation_id=00000000-0000-0000-0000-000000000000');
  const replayOk = r.ok || r.status === 404; // 404 expected for missing conversation
  recordCustom('replay', 'GET /replay?conversation_id=... (404 expected)', replayOk, { status: r.status, elapsed: r.elapsed });
  captureSnapshot('replay', 'GET /replay', r);
}

async function testChatExamples(target) {
  console.log('\n📋 Chat Examples');

  const list = await request(target, 'GET', 'chat-examples');
  record('chat-examples', 'GET /chat-examples', list);
  captureSnapshot('chat-examples', 'GET /chat-examples', list);

  if (list.json?.data) {
    recordCustom('chat-examples', `examples listed (got ${list.json.data.length})`, Array.isArray(list.json.data), { elapsed: 0 });
  }
}

async function testTripRecords(target) {
  console.log('\n📊 Trip Records');

  const pairs = await request(target, 'GET', 'trip-records/pairs');
  record('trip-records', 'GET /trip-records/pairs', pairs);
  captureSnapshot('trip-records', 'GET /trip-records/pairs', pairs);

  const grouped = await request(target, 'GET', 'trip-records/pairs-grouped');
  record('trip-records', 'GET /trip-records/pairs-grouped', grouped);
  captureSnapshot('trip-records', 'GET /trip-records/pairs-grouped', grouped);

  const stats = await request(target, 'GET', 'trip-records/stats');
  record('trip-records', 'GET /trip-records/stats', stats);
  captureSnapshot('trip-records', 'GET /trip-records/stats', stats);

  if (stats.json) {
    recordCustom('trip-records', 'stats has total_records', stats.json.total_records !== undefined, { elapsed: 0 });
  }

  // Manifest endpoints
  const manifestPairs = await request(target, 'GET', 'trip-records/manifest/pairs?service_date=2024-01-15');
  record('trip-records', 'GET /trip-records/manifest/pairs', manifestPairs);
  captureSnapshot('trip-records', 'GET /trip-records/manifest/pairs', manifestPairs);

  const manifestSummaries = await request(target, 'GET', 'trip-records/manifest/pair-summaries');
  record('trip-records', 'GET /trip-records/manifest/pair-summaries', manifestSummaries);
  captureSnapshot('trip-records', 'GET /trip-records/manifest/pair-summaries', manifestSummaries);
}

async function testTriDeltaTransit(target) {
  console.log('\n🚍 Tri Delta Transit');

  // These endpoints depend on optional tables — 500 with "table not found" is a known state
  const trips = await request(target, 'GET', 'tri-delta-transit/trips');
  const tripsOk = trips.ok || (trips.status === 500 && (trips.json?.error?.includes('not found') || trips.json?.error?.includes('schema cache')));
  recordCustom('tri-delta-transit', `GET /tri-delta-transit/trips (${trips.ok ? 'data' : 'table missing'})`, tripsOk, { status: trips.status, elapsed: trips.elapsed });
  captureSnapshot('tri-delta-transit', 'GET /tri-delta-transit/trips', trips);

  if (Array.isArray(trips.json)) {
    recordCustom('tri-delta-transit', `trips returned (got ${trips.json.length})`, trips.json.length > 0, { elapsed: 0 });
  }

  const drivingRoutes = await request(target, 'GET', 'tri-delta-transit/routes?mode=driving');
  const drivOk = drivingRoutes.ok || (drivingRoutes.status === 500 && (drivingRoutes.json?.error?.includes('not found') || drivingRoutes.json?.error?.includes('schema cache')));
  recordCustom('tri-delta-transit', `GET /tri-delta-transit/routes?mode=driving (${drivingRoutes.ok ? 'data' : 'table missing'})`, drivOk, { status: drivingRoutes.status, elapsed: drivingRoutes.elapsed });
  captureSnapshot('tri-delta-transit', 'GET /tri-delta-transit/routes driving', drivingRoutes);

  const transitRoutes = await request(target, 'GET', 'tri-delta-transit/routes?mode=transit');
  const transOk = transitRoutes.ok || (transitRoutes.status === 500 && (transitRoutes.json?.error?.includes('not found') || transitRoutes.json?.error?.includes('schema cache')));
  recordCustom('tri-delta-transit', `GET /tri-delta-transit/routes?mode=transit (${transitRoutes.ok ? 'data' : 'table missing'})`, transOk, { status: transitRoutes.status, elapsed: transitRoutes.elapsed });
  captureSnapshot('tri-delta-transit', 'GET /tri-delta-transit/routes transit', transitRoutes);
}

// ─── Data integrity checks ──────────────────────────────────────────────────

async function testDataIntegrity(target) {
  console.log('\n🔍 Data Integrity');

  // Count providers and verify all have required fields
  const all = await request(target, 'GET', 'providers');
  const providers = all.json?.data || [];
  let missingFields = 0;
  let missingZones = 0;
  for (const p of providers) {
    if (!p.provider_name || !p.provider_type) missingFields++;
    // Count how many claim has_service_zone but return empty
  }
  recordCustom('data-integrity', `all ${providers.length} providers have required fields`, missingFields === 0, {
    elapsed: 0,
    error: missingFields > 0 ? `${missingFields} providers missing provider_name or provider_type` : null,
  });
  recordCustom('data-integrity', `provider import count is 29 (got ${providers.length})`, providers.length === 29, {
    elapsed: 0,
    error: providers.length === 29 ? null : 'provider count no longer matches the reviewed workbook import',
  });

  // Verify provider IDs are unique
  const ids = providers.map((p) => p.provider_id || p.id).filter(Boolean);
  const uniqueIds = new Set(ids);
  recordCustom('data-integrity', 'provider IDs are unique', ids.length === uniqueIds.size, {
    elapsed: 0,
    error: ids.length !== uniqueIds.size ? `${ids.length - uniqueIds.size} duplicates` : null,
  });

  // Check a sample of service zones are valid GeoJSON
  // Zone data may be inline on the provider record or via the /service-zone endpoint
  const withZone = providers.filter((p) => p.has_service_zone || p.service_zone);
  recordCustom('data-integrity', `providers with service zones: ${withZone.length}/${providers.length}`, withZone.length > 0, { elapsed: 0 });

  let validZones = 0;
  const sampleSize = Math.min(3, withZone.length);
  for (let i = 0; i < sampleSize; i++) {
    const p = withZone[i];
    // Try inline zone first
    let geo = typeof p.service_zone === 'object' ? p.service_zone : null;
    if (!geo) {
      // Try endpoint
      const pid = p.provider_id || p.id;
      const zr = await request(target, 'GET', `providers/${pid}/service-zone`);
      if (zr.ok && zr.json) {
        geo = zr.json.service_zone || zr.json;
      }
    }
    if (geo && (geo.type === 'FeatureCollection' || geo.type === 'Feature' || geo.type === 'Polygon' || geo.type === 'MultiPolygon')) {
      validZones++;
    }
  }
  recordCustom('data-integrity', `service zones are valid GeoJSON (${validZones}/${sampleSize} sampled)`, validZones === sampleSize || sampleSize === 0, { elapsed: 0 });

  const byId = new Map(providers.map((provider) => [String(provider.provider_id || provider.id), provider]));
  const requiredSources = [
    ['1004', 'AC Transit', 'custom_geojson'],
    ['2006', 'LINK Paratransit', 'custom_geojson'],
    ['2009', 'East Bay Paratransit', 'custom_geojson'],
    ['5031', 'Walnut Creek Lyft Self Access Pass', 'city_list'],
    ['5032', 'Walnut Creek Lyft Concierge Pass', 'city_list'],
  ];
  for (const [id, label, source] of requiredSources) {
    const provider = byId.get(id);
    const count = featureCount(provider?.service_zone);
    const sourceOk = provider?.service_area_source === source;
    const zoneOk = count >= 1;
    recordCustom('data-integrity', `${label} service area source is ${source}`, sourceOk && zoneOk, {
      elapsed: 0,
      error: provider
        ? `source=${provider.service_area_source ?? 'null'} feature_count=${count}`
        : `provider ${id} missing`,
    });
  }
}

// ─── Snapshot comparison ────────────────────────────────────────────────────

function compareSnapshots(baseline, current) {
  console.log('\n📊 Snapshot Comparison');
  let diffs = 0;
  let matches = 0;

  for (const group of Object.keys(baseline)) {
    for (const name of Object.keys(baseline[group])) {
      const base = baseline[group][name];
      const curr = current[group]?.[name];
      if (!curr) {
        console.log(`  ⚠️  MISSING: ${group} / ${name}`);
        diffs++;
        continue;
      }

      // Compare status codes
      if (base.status !== curr.status) {
        console.log(`  ❌ STATUS DIFF: ${group} / ${name}: ${base.status} → ${curr.status}`);
        diffs++;
        continue;
      }

      // Structural comparison (ignoring volatile fields)
      const baseNorm = JSON.stringify(normalizeForComparison(base.json));
      const currNorm = JSON.stringify(normalizeForComparison(curr.json));
      if (baseNorm !== currNorm) {
        console.log(`  ⚠️  SHAPE DIFF: ${group} / ${name}`);
        if (verbose) {
          console.log(`     baseline keys: ${base.json ? Object.keys(base.json).join(', ') : 'null'}`);
          console.log(`     current keys:  ${curr.json ? Object.keys(curr.json).join(', ') : 'null'}`);
        }
        diffs++;
      } else {
        matches++;
      }
    }
  }

  console.log(`\n  Matches: ${matches}, Diffs: ${diffs}`);
  return diffs === 0;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const ALL_GROUPS = {
  health: testHealth,
  providers: testProviders,
  geocode: testGeocode,
  directions: testDirections,
  conversations: testConversations,
  chat: testChat,
  'tool-calls': testToolCalls,
  replay: testReplay,
  'chat-examples': testChatExamples,
  'trip-records': testTripRecords,
  'tri-delta-transit': testTriDeltaTransit,
  'data-integrity': testDataIntegrity,
};

function shouldRun(group) {
  if (onlyGroups) return onlyGroups.includes(group);
  if (skipGroups) return !skipGroups.includes(group);
  return true;
}

async function runSuite(targetName) {
  const target = TARGETS[targetName];
  if (!target) {
    console.error(`Unknown target: ${targetName}. Use 'supabase' or 'aws'.`);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  OPTIMAT API Test Harness — target: ${targetName}`);
  console.log(`  Base URL: ${target.baseUrl}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  for (const [group, testFn] of Object.entries(ALL_GROUPS)) {
    if (!shouldRun(group)) continue;
    try {
      await testFn(target);
    } catch (err) {
      recordCustom(group, `${group} (uncaught error)`, false, { error: err.message });
    }
  }

  // Run cleanup
  for (const fn of cleanupFns) {
    try { await fn(); } catch {}
  }
  cleanupFns = [];

  return { results: [...results], snapshots: { ...snapshots } };
}

function printSummary(results) {
  console.log(`\n${'─'.repeat(60)}`);
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;
  const totalTime = results.reduce((sum, r) => sum + r.elapsed, 0);

  console.log(`  Results: ${passed} passed, ${failed} failed, ${total} total`);
  console.log(`  Total time: ${totalTime}ms`);

  if (failed > 0) {
    console.log(`\n  Failed tests:`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    ❌ [${r.group}] ${r.name}${r.error ? ` — ${r.error}` : ''}`);
    }
  }
  console.log(`${'─'.repeat(60)}\n`);
  return failed === 0;
}

async function main() {
  if (doCompare) {
    // Run against both targets and compare
    const supaResult = await runSuite('supabase');
    results.length = 0;
    const awsResult = await runSuite('aws');

    console.log('\n' + '═'.repeat(60));
    console.log('  COMPARISON RESULTS');
    console.log('═'.repeat(60));
    const same = compareSnapshots(supaResult.snapshots, awsResult.snapshots);
    process.exit(same ? 0 : 1);
  }

  const suite = await runSuite(targetName);
  const allPassed = printSummary(results);

  // Save snapshot
  if (doSnapshot) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const filename = `snapshot-${targetName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const filepath = resolve(SNAPSHOTS_DIR, filename);
    writeFileSync(filepath, JSON.stringify(suite.snapshots, null, 2));
    console.log(`  📸 Snapshot saved: ${filepath}\n`);
  }

  // Compare against saved snapshot
  if (fromSnapshot) {
    const baselinePath = resolve(fromSnapshot);
    if (!existsSync(baselinePath)) {
      console.error(`Snapshot file not found: ${baselinePath}`);
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const same = compareSnapshots(baseline, suite.snapshots);
    process.exit(same ? 0 : 1);
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
