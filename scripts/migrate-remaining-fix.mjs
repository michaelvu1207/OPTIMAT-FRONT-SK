#!/usr/bin/env node
/**
 * Fix remaining migration gaps:
 * 1. Paginate remaining messages (got 1000/1264)
 * 2. Trip records via Edge Function (reverse map columns)
 * 3. Conversation states for chat examples
 * 4. Tri delta transit via Edge Function
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
  if (!resp.ok) return null;
  return resp.json();
}

async function supabaseFetch(path) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    headers: {
      'Authorization': `Bearer ${ANON_KEY}`,
      'apikey': ANON_KEY,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) return null;
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

function esc(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function escJson(obj) {
  if (obj == null) return 'NULL';
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

async function main() {
  if (!ANON_KEY) {
    throw new Error('Set SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY.');
  }
  console.log('=== Fix remaining migration gaps ===\n');

  // ---------------------------------------------------------------
  // 1. Remaining messages (offset 1000)
  // ---------------------------------------------------------------
  console.log('--- 1. Remaining messages ---');
  let offset = 1000;
  let totalNew = 0;
  while (true) {
    const msgs = await supabaseRest('messages', `order=created_at.asc&limit=1000&offset=${offset}`);
    if (!msgs || msgs.length === 0) break;
    console.log(`  Fetched ${msgs.length} messages at offset ${offset}`);
    for (const msg of msgs) {
      runSql(`INSERT INTO optimat.messages (id, conversation_id, role, content, attachments, created_at)
        VALUES (${esc(msg.id)}, ${esc(msg.conversation_id)}, ${esc(msg.role)},
                ${esc(msg.content)}, ${escJson(msg.attachments)}, ${esc(msg.created_at)})
        ON CONFLICT (id) DO NOTHING`);
    }
    totalNew += msgs.length;
    offset += msgs.length;
    if (msgs.length < 1000) break;
  }
  console.log(`  ✓ ${totalNew} additional messages migrated`);

  // ---------------------------------------------------------------
  // 2. Trip records via Edge Function (reverse map columns)
  // ---------------------------------------------------------------
  console.log('\n--- 2. Trip records ---');
  const trips = await supabaseFetch('trip-records/pairs');
  if (trips && trips.length > 0) {
    console.log(`  Fetched ${trips.length} trip records via Edge Function`);

    // Reverse map API columns → DB columns
    for (let i = 0; i < trips.length; i += 10) {
      const batch = trips.slice(i, i + 10);
      const values = batch.map(r => {
        // Reconstruct addr_pk and addr_dp from address + city
        const addrPk = [r.pickup_address, r.pickup_city].filter(Boolean).join(', ');
        const addrDp = [r.drop_address, r.drop_city].filter(Boolean).join(', ');
        return `(${r.pickup_sequence ?? 'NULL'}, ${r.drop_sequence ?? 'NULL'}, ${r.trip_id ?? 'NULL'}, NULL,
          ${esc(r.pick_time)}, ${esc(addrPk)}, ${esc(r.drop_time)}, ${esc(addrDp)},
          NULL, ${r.passengers_on_board ?? 'NULL'}, ${r.trip_id_return ?? 'NULL'},
          ${r.duration_minutes != null ? esc(r.duration_minutes + ' minutes') : 'NULL'},
          ${esc(r.route_polyline)},
          ${r.route_distance_meters ?? 'NULL'}, ${r.route_duration_seconds ?? 'NULL'}, ${esc(r.route_summary)})`;
      }).join(',\n');

      runSql(`INSERT INTO optimat.trip_record_pairs_raw
        (no_pk, no_dp, trip_id, provider_id, pick_time, addr_pk, drop_time, addr_dp,
         no_return, psg_on_brd, trip_id_return, outgo_dura, google_maps_route,
         google_route_distance_m, google_route_duration_s, google_route_summary)
        VALUES ${values}`);
    }
    console.log(`  ✓ ${trips.length} trip records migrated`);
  } else {
    console.log('  No trip records found');
  }

  // ---------------------------------------------------------------
  // 3. Conversation states for chat examples
  // ---------------------------------------------------------------
  console.log('\n--- 3. Conversation states ---');
  // Get the chat example conversation IDs
  const examples = await supabaseRest('chat_examples', 'select=id,conversation_id,title');
  if (examples && examples.length > 0) {
    for (const ex of examples) {
      console.log(`  Fetching states for "${ex.title}" (conv=${ex.conversation_id})`);
      const states = await supabaseFetch(`replay?conversation_id=${ex.conversation_id}`);
      if (states && states.states && Array.isArray(states.states)) {
        console.log(`    Found ${states.states.length} states`);
        for (const st of states.states) {
          runSql(`INSERT INTO optimat.conversation_states
            (id, conversation_id, example_id, sequence_number, state_snapshot, ui_hints,
             show_providers, show_addresses, map_action, created_at)
            VALUES (${esc(st.id)}, ${esc(st.conversation_id)}, ${esc(st.example_id)},
                    ${st.sequence_number}, ${escJson(st.state_snapshot)}, ${escJson(st.ui_hints)},
                    ${st.show_providers ?? false}, ${st.show_addresses ?? false},
                    ${esc(st.map_action)}, ${esc(st.created_at)})
            ON CONFLICT (id) DO NOTHING`);
        }
        console.log(`    ✓ Migrated`);
      } else if (states && states.error) {
        console.log(`    No states: ${states.error}`);
      }
    }
  }

  // ---------------------------------------------------------------
  // 4. Tri Delta Transit via Edge Function
  // ---------------------------------------------------------------
  console.log('\n--- 4. Tri Delta Transit ---');
  const tdtTrips = await supabaseFetch('tri-delta-transit/trips');
  if (tdtTrips && tdtTrips.data && tdtTrips.data.length > 0) {
    const data = tdtTrips.data;
    console.log(`  Fetched ${data.length} TDT trips`);
    for (let i = 0; i < data.length; i += 10) {
      const batch = data.slice(i, i + 10);
      const values = batch.map(r =>
        `(${r.trip_id ?? r['Trip ID'] ?? 'NULL'},
          ${esc(r.origin_address ?? r['Origin Address'])},
          ${esc(r.origin_city ?? r['Origin City'])},
          ${esc(r.destination_address ?? r['Destination Address'])},
          ${esc(r.destination_city ?? r['Destination City'])},
          ${r.duration_hours ?? r['Duration (hours)'] ?? 'NULL'},
          ${r.origin_latitude ?? r['Origin Latitude'] ?? 'NULL'},
          ${r.origin_longitude ?? r['Origin Longitude'] ?? 'NULL'},
          ${r.destination_latitude ?? r['Destination Latitude'] ?? 'NULL'},
          ${r.destination_longitude ?? r['Destination Longitude'] ?? 'NULL'},
          ${esc(r.origin_geometry ?? r['Origin Geometry'])},
          ${esc(r.destination_geometry ?? r['Destination Geometry'])})`
      ).join(',\n');

      runSql(`INSERT INTO public.tri_delta_transit
        ("Trip ID", "Origin Address", "Origin City", "Destination Address", "Destination City",
         "Duration (hours)", "Origin Latitude", "Origin Longitude",
         "Destination Latitude", "Destination Longitude", "Origin Geometry", "Destination Geometry")
        VALUES ${values}`);
    }
    console.log(`  ✓ ${data.length} TDT trips migrated`);
  } else {
    console.log('  No TDT trips found (or endpoint returned error)');
    if (tdtTrips) console.log('  Response:', JSON.stringify(tdtTrips).slice(0, 200));
  }

  // ---------------------------------------------------------------
  // Final counts
  // ---------------------------------------------------------------
  console.log('\n=== Final Aurora table counts ===');
  const counts = invokeLambda({ action: 'check' });
  if (counts.success) {
    for (const [table, count] of Object.entries(counts.counts).sort()) {
      const marker = count > 0 ? '✓' : ' ';
      console.log(`  ${marker} ${table}: ${count}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
