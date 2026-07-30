#!/usr/bin/env node
/**
 * Migrate remaining data from Supabase to Aurora via Lambda.
 * Pulls data from Supabase Edge Functions, pushes to Aurora via db-setup Lambda.
 *
 * Tables: chat_examples, conversations, messages, conversation_states,
 *         trip_record_pairs_raw, tri_delta_transit, transit_driving_driving
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = 'https://htjohidcoyfuwfjecazu.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const AWS_PROFILE = 'path';
const AWS_REGION = 'us-west-1';
const LAMBDA_FUNCTION = 'optimat-api-DbSetupFunction-5xHdMWRWSxQT';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function supabaseFetch(path) {
  const url = `${SUPABASE_URL}/functions/v1/${path}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ANON_KEY}`,
      'apikey': ANON_KEY,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) {
    console.error(`  Supabase ${path}: HTTP ${resp.status}`);
    return null;
  }
  return resp.json();
}

// Direct Supabase REST API (PostgREST) for raw table access
// Uses Accept-Profile header to access the 'optimat' schema
async function supabaseRest(table, params = '', schema = 'optimat') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ANON_KEY}`,
      'apikey': ANON_KEY,
      'Accept': 'application/json',
      'Accept-Profile': schema,
    },
  });
  if (!resp.ok) {
    console.error(`  Supabase REST ${table}: HTTP ${resp.status} ${await resp.text()}`);
    return null;
  }
  return resp.json();
}

function invokeLambda(payload) {
  const tmpIn = path.join(__dirname, '.lambda-payload.json');
  const tmpOut = path.join(__dirname, '.lambda-response.json');
  fs.writeFileSync(tmpIn, JSON.stringify(payload), 'utf-8');
  try {
    execSync(
      `aws lambda invoke --function-name "${LAMBDA_FUNCTION}" --payload fileb://${tmpIn} --cli-binary-format raw-in-base64-out --profile ${AWS_PROFILE} --region ${AWS_REGION} ${tmpOut}`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000 },
    );
    return JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

function runSql(sql) {
  const r = invokeLambda({ action: 'run-sql', sql });
  if (!r.success) console.error(`  SQL error: ${r.error}`);
  return r;
}

function escapeStr(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function escapeJsonb(obj) {
  if (obj == null) return 'NULL';
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

// ---------------------------------------------------------------------------
// Migration functions
// ---------------------------------------------------------------------------

async function migrateConversationsAndMessages() {
  console.log('\n=== Migrating conversations + messages ===');

  // Pull from Supabase REST API
  const conversations = await supabaseRest('conversations', 'order=created_at.asc&limit=1000');
  if (!conversations || conversations.length === 0) {
    console.log('  No conversations found in Supabase');
    return;
  }
  console.log(`  Found ${conversations.length} conversations`);

  for (const conv of conversations) {
    // Skip test harness conversations
    if (conv.title === '__harness_test__') continue;

    const sql = `INSERT INTO optimat.conversations (id, title, metadata, created_at, updated_at)
      VALUES (${escapeStr(conv.id)}, ${escapeStr(conv.title)}, ${escapeJsonb(conv.metadata)},
              ${escapeStr(conv.created_at)}, ${escapeStr(conv.updated_at)})
      ON CONFLICT (id) DO NOTHING`;
    runSql(sql);
  }

  // Pull messages
  const messages = await supabaseRest('messages', 'order=created_at.asc&limit=5000');
  if (messages && messages.length > 0) {
    console.log(`  Found ${messages.length} messages`);
    for (const msg of messages) {
      const sql = `INSERT INTO optimat.messages (id, conversation_id, role, content, attachments, created_at)
        VALUES (${escapeStr(msg.id)}, ${escapeStr(msg.conversation_id)}, ${escapeStr(msg.role)},
                ${escapeStr(msg.content)}, ${escapeJsonb(msg.attachments)}, ${escapeStr(msg.created_at)})
        ON CONFLICT (id) DO NOTHING`;
      runSql(sql);
    }
  }

  console.log('  ✓ Conversations and messages migrated');
}

async function migrateChatExamples() {
  console.log('\n=== Migrating chat_examples ===');

  const examples = await supabaseRest('chat_examples', 'order=created_at.asc&limit=100');
  if (!examples || examples.length === 0) {
    console.log('  No chat examples found');
    return;
  }
  console.log(`  Found ${examples.length} chat examples`);

  for (const ex of examples) {
    const tags = ex.tags ? `ARRAY[${ex.tags.map(t => escapeStr(t)).join(',')}]::text[]` : 'NULL';
    const sql = `INSERT INTO optimat.chat_examples (id, conversation_id, title, description, tags, category, is_active, replay_config, created_at, updated_at)
      VALUES (${escapeStr(ex.id)}, ${escapeStr(ex.conversation_id)}, ${escapeStr(ex.title)},
              ${escapeStr(ex.description)}, ${tags}, ${escapeStr(ex.category)},
              ${ex.is_active ?? 'NULL'}, ${escapeJsonb(ex.replay_config)},
              ${escapeStr(ex.created_at)}, ${escapeStr(ex.updated_at)})
      ON CONFLICT (id) DO NOTHING`;
    runSql(sql);
  }

  console.log('  ✓ Chat examples migrated');
}

async function migrateConversationStates() {
  console.log('\n=== Migrating conversation_states ===');

  const states = await supabaseRest('conversation_states', 'order=sequence_number.asc&limit=5000');
  if (!states || states.length === 0) {
    console.log('  No conversation states found');
    return;
  }
  console.log(`  Found ${states.length} conversation states`);

  for (const st of states) {
    const sql = `INSERT INTO optimat.conversation_states (id, conversation_id, example_id, sequence_number, state_snapshot, ui_hints, show_providers, show_addresses, map_action, created_at)
      VALUES (${escapeStr(st.id)}, ${escapeStr(st.conversation_id)}, ${escapeStr(st.example_id)},
              ${st.sequence_number}, ${escapeJsonb(st.state_snapshot)}, ${escapeJsonb(st.ui_hints)},
              ${st.show_providers ?? false}, ${st.show_addresses ?? false}, ${escapeStr(st.map_action)},
              ${escapeStr(st.created_at)})
      ON CONFLICT (id) DO NOTHING`;
    runSql(sql);
  }

  console.log('  ✓ Conversation states migrated');
}

async function migrateTripRecords() {
  console.log('\n=== Migrating trip_record_pairs_raw ===');

  const records = await supabaseRest('trip_record_pairs_raw', 'order=trip_id.asc&limit=5000');
  if (!records || records.length === 0) {
    console.log('  No trip records found');
    return;
  }
  console.log(`  Found ${records.length} trip records`);

  // Batch insert in chunks of 20
  for (let i = 0; i < records.length; i += 20) {
    const batch = records.slice(i, i + 20);
    const values = batch.map(r =>
      `(${r.no_pk ?? 'NULL'}, ${r.no_dp ?? 'NULL'}, ${r.trip_id ?? 'NULL'}, ${r.provider_id ?? 'NULL'},
        ${escapeStr(r.pick_time)}, ${escapeStr(r.addr_pk)}, ${escapeStr(r.drop_time)}, ${escapeStr(r.addr_dp)},
        ${r.no_return ?? 'NULL'}, ${r.psg_on_brd ?? 'NULL'}, ${r.trip_id_return ?? 'NULL'},
        ${escapeStr(r.outgo_dura)}, ${escapeStr(r.google_maps_route)},
        ${r.google_route_distance_m ?? 'NULL'}, ${r.google_route_duration_s ?? 'NULL'}, ${escapeStr(r.google_route_summary)})`
    ).join(',\n');

    const sql = `INSERT INTO optimat.trip_record_pairs_raw
      (no_pk, no_dp, trip_id, provider_id, pick_time, addr_pk, drop_time, addr_dp,
       no_return, psg_on_brd, trip_id_return, outgo_dura, google_maps_route,
       google_route_distance_m, google_route_duration_s, google_route_summary)
      VALUES ${values}`;
    runSql(sql);
  }

  console.log(`  ✓ ${records.length} trip records migrated`);
}

async function migrateTriDeltaTransit() {
  console.log('\n=== Migrating tri_delta_transit ===');

  const trips = await supabaseRest('tri_delta_transit', 'order="Trip ID".asc&limit=5000', 'public');
  if (!trips || trips.length === 0) {
    console.log('  No tri_delta_transit records found');
    return;
  }
  console.log(`  Found ${trips.length} tri_delta_transit records`);

  for (let i = 0; i < trips.length; i += 20) {
    const batch = trips.slice(i, i + 20);
    const values = batch.map(r =>
      `(${r['Trip ID'] ?? 'NULL'}, ${escapeStr(r['Origin Address'])}, ${escapeStr(r['Origin City'])},
        ${escapeStr(r['Destination Address'])}, ${escapeStr(r['Destination City'])}, ${r['Duration (hours)'] ?? 'NULL'},
        ${r['Origin Latitude'] ?? 'NULL'}, ${r['Origin Longitude'] ?? 'NULL'},
        ${r['Destination Latitude'] ?? 'NULL'}, ${r['Destination Longitude'] ?? 'NULL'},
        ${escapeStr(r['Origin Geometry'])}, ${escapeStr(r['Destination Geometry'])})`
    ).join(',\n');

    const sql = `INSERT INTO public.tri_delta_transit
      ("Trip ID", "Origin Address", "Origin City", "Destination Address", "Destination City",
       "Duration (hours)", "Origin Latitude", "Origin Longitude",
       "Destination Latitude", "Destination Longitude", "Origin Geometry", "Destination Geometry")
      VALUES ${values}`;
    runSql(sql);
  }

  console.log(`  ✓ ${trips.length} tri_delta_transit records migrated`);
}

async function migrateTransitDriving() {
  console.log('\n=== Migrating transit_driving_driving ===');

  const rows = await supabaseRest('transit_driving_driving', 'order=trip_id.asc&limit=5000', 'public');
  if (!rows || rows.length === 0) {
    console.log('  No transit_driving_driving records found');
    return;
  }
  console.log(`  Found ${rows.length} transit_driving_driving records`);

  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    const values = batch.map(r =>
      `(${r.trip_id ?? 'NULL'}, ${escapeStr(r.driving_summary)}, ${r.driving_distance_meters ?? 'NULL'},
        ${r.driving_duration_seconds ?? 'NULL'}, ${escapeStr(r.driving_polyline)}, ${escapeJsonb(r.driving_warnings)},
        ${escapeStr(r.transit_summary)}, ${r.transit_distance_meters ?? 'NULL'},
        ${r.transit_duration_seconds ?? 'NULL'}, ${escapeStr(r.transit_polyline)}, ${escapeJsonb(r.transit_warnings)})`
    ).join(',\n');

    const sql = `INSERT INTO public.transit_driving_driving
      (trip_id, driving_summary, driving_distance_meters, driving_duration_seconds,
       driving_polyline, driving_warnings, transit_summary, transit_distance_meters,
       transit_duration_seconds, transit_polyline, transit_warnings)
      VALUES ${values}`;
    runSql(sql);
  }

  console.log(`  ✓ ${rows.length} transit_driving_driving records migrated`);
}

async function migrateToolCalls() {
  console.log('\n=== Migrating tool_calls ===');

  const rows = await supabaseRest('tool_calls', 'order=created_at.asc&limit=5000');
  if (!rows || rows.length === 0) {
    console.log('  No tool_calls found');
    return;
  }
  console.log(`  Found ${rows.length} tool_calls`);

  for (const r of rows) {
    const sql = `INSERT INTO optimat.tool_calls (id, conversation_id, tool_name, tool_input, result_data, parameters, created_at)
      VALUES (${escapeStr(r.id)}, ${escapeStr(r.conversation_id)}, ${escapeStr(r.tool_name)},
              ${escapeJsonb(r.tool_input)}, ${escapeJsonb(r.result_data)}, ${escapeJsonb(r.parameters)},
              ${escapeStr(r.created_at)})
      ON CONFLICT (id) DO NOTHING`;
    runSql(sql);
  }

  console.log(`  ✓ ${rows.length} tool_calls migrated`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!ANON_KEY) {
    throw new Error('Set SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY.');
  }
  console.log('=== Migrate remaining Supabase data to Aurora ===');
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Lambda: ${LAMBDA_FUNCTION}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  await migrateConversationsAndMessages();
  await migrateChatExamples();
  await migrateConversationStates();
  await migrateTripRecords();
  await migrateTriDeltaTransit();
  await migrateTransitDriving();
  await migrateToolCalls();

  // Final counts
  console.log('\n=== Final Aurora table counts ===');
  const counts = invokeLambda({ action: 'check' });
  if (counts.success) {
    for (const [table, count] of Object.entries(counts.counts).sort()) {
      console.log(`  ${table}: ${count}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
