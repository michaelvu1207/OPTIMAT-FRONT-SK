#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'htjohidcoyfuwfjecazu';
const API_BASE = 'https://api.supabase.com/v1';

const TABLES_WITHOUT_PRIMARY_KEYS = [
  'demand_response_manifest_review',
  'demands',
  'geoaddress',
  'mobility_matters',
  'providers_backup_service_area_20260518',
  'riderabilities',
  'transit_driving_driving',
  'tri_delta_transit',
  'trip_record_pairs_raw',
];

function loadAccessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const stored = execFileSync(
    'security',
    ['find-generic-password', '-s', 'Supabase CLI', '-w'],
    { encoding: 'utf8' },
  ).trim();
  if (stored.startsWith('go-keyring-base64:')) {
    return Buffer.from(stored.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  }
  return stored;
}

async function query(sql) {
  const response = await fetch(`${API_BASE}/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${loadAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`CDC preparation failed (${response.status}): ${body?.message || 'unknown error'}`);
  }
  return body;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const alterStatements = TABLES_WITHOUT_PRIMARY_KEYS
  .map((table) => `alter table optimat.${quoteIdentifier(table)} replica identity full;`)
  .join('\n');

await query(alterStatements);

const state = await query(`
  select n.nspname as schema_name,
         c.relname as table_name,
         c.relreplident as replica_identity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'optimat'
    and c.relname = any(array[${TABLES_WITHOUT_PRIMARY_KEYS.map((name) => `'${name}'`).join(',')}])
  order by c.relname;
`);

const missing = TABLES_WITHOUT_PRIMARY_KEYS.filter(
  (table) => !state.some((row) => row.table_name === table && row.replica_identity === 'f'),
);
if (missing.length) {
  throw new Error(`Replica identity verification failed for: ${missing.join(', ')}`);
}

console.log(JSON.stringify({
  prepared: state.map((row) => `${row.schema_name}.${row.table_name}`),
  replica_identity: 'FULL',
}, null, 2));
