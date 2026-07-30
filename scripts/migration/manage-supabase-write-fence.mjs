#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'htjohidcoyfuwfjecazu';
const API_BASE = 'https://api.supabase.com/v1';
const TRIGGER_NAME = 'optimat_aws_cutover_write_fence';
const FUNCTION_NAME = 'optimat.reject_writes_during_aws_cutover';

const MUTABLE_TABLES = [
  'conversations',
  'providers',
  'messages',
  'find_providers_calls',
  'search_addresses_calls',
  'get_provider_info_calls',
  'general_question_calls',
  'chat_examples',
  'conversation_states',
  'chat_feedback',
  'chat_trip_state',
  'trip_record_pairs_raw',
];

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function loadAccessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;

  const stored = execFileSync(
    'security',
    ['find-generic-password', '-s', 'Supabase CLI', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  if (stored.startsWith('go-keyring-base64:')) {
    return Buffer.from(stored.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  }
  return stored;
}

const accessToken = loadAccessToken();

async function query(sql) {
  const response = await fetch(`${API_BASE}/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.message || body?.error || `HTTP ${response.status}`;
    throw new Error(`Supabase database query failed: ${reason}`);
  }
  return body;
}

function triggerFunctionSql() {
  return `
    create or replace function ${FUNCTION_NAME}()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $fence$
    begin
      raise exception using
        errcode = '55000',
        message = 'OPTIMAT is temporarily read-only during the AWS cutover';
    end;
    $fence$;
  `;
}

async function status() {
  const rows = await query(`
    select c.relname as table_name, t.tgenabled as enabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'optimat'
      and t.tgname = '${TRIGGER_NAME}'
    order by c.relname;
  `);
  const enabledTables = new Set(
    rows.filter((row) => row.enabled === 'O' || row.enabled === 'A')
      .map((row) => row.table_name),
  );
  const missing = MUTABLE_TABLES.filter((table) => !enabledTables.has(table));
  return {
    fenced: missing.length === 0,
    enabled: enabledTables.size,
    expected: MUTABLE_TABLES.length,
    missing,
  };
}

async function testFence() {
  await query(`
    begin;
    ${triggerFunctionSql()}
    create temporary table __optimat_fence_test (id integer) on commit drop;
    create trigger ${quoteIdentifier(TRIGGER_NAME)}
      before insert or update or delete or truncate
      on __optimat_fence_test
      for each statement execute function ${FUNCTION_NAME}();
    do $test$
    begin
      begin
        insert into __optimat_fence_test values (1);
        raise exception 'write fence did not reject the test write';
      exception
        when sqlstate '55000' then null;
      end;
    end;
    $test$;
    rollback;
  `);
  console.log('Supabase write-fence rejection test passed; no persistent changes were made.');
}

async function enableFence() {
  const tableSql = MUTABLE_TABLES
    .map((table) => `optimat.${quoteIdentifier(table)}`)
    .join(', ');
  const triggerSql = MUTABLE_TABLES.map((table) => `
    drop trigger if exists ${quoteIdentifier(TRIGGER_NAME)}
      on optimat.${quoteIdentifier(table)};
    create trigger ${quoteIdentifier(TRIGGER_NAME)}
      before insert or update or delete or truncate
      on optimat.${quoteIdentifier(table)}
      for each statement execute function ${FUNCTION_NAME}();
  `).join('\n');

  await query(`
    begin;
    lock table ${tableSql} in share row exclusive mode;
    ${triggerFunctionSql()}
    ${triggerSql}
    commit;
  `);

  const result = await status();
  if (!result.fenced) throw new Error(`Write fence incomplete: ${result.missing.join(', ')}`);
  console.log(`Supabase write fence enabled on all ${result.expected} mutable tables.`);
}

async function disableFence() {
  const triggerSql = MUTABLE_TABLES.map((table) => `
    drop trigger if exists ${quoteIdentifier(TRIGGER_NAME)}
      on optimat.${quoteIdentifier(table)};
  `).join('\n');

  await query(`
    begin;
    ${triggerSql}
    drop function if exists ${FUNCTION_NAME}();
    commit;
  `);

  const result = await status();
  if (result.enabled !== 0) throw new Error('One or more write-fence triggers remain enabled.');
  console.log('Supabase write fence disabled.');
}

const action = process.argv[2] || 'status';

try {
  if (action === 'status') {
    console.log(JSON.stringify(await status()));
  } else if (action === 'test') {
    await testFence();
  } else if (action === 'enable') {
    await enableFence();
  } else if (action === 'disable') {
    await disableFence();
  } else {
    throw new Error('Usage: manage-supabase-write-fence.mjs [status|test|enable|disable]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
