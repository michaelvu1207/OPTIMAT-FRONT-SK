#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'htjohidcoyfuwfjecazu';
const API_BASE = 'https://api.supabase.com/v1';
const DEFAULT_OUTPUT = resolve(
  'docs/migration/inventory',
  `live-supabase-${new Date().toISOString().slice(0, 10)}.json`,
);
const positionalOutput = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const outputPath = resolve(positionalOutput || DEFAULT_OUTPUT);
const skipChecksums = process.argv.includes('--skip-checksums');
const previousInventory = existsSync(outputPath)
  ? JSON.parse(readFileSync(outputPath, 'utf8'))
  : null;

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

const accessToken = loadAccessToken();

async function managementRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.message || body?.error || 'unknown error';
    throw new Error(`Supabase Management API ${path} failed (${response.status}): ${reason}`);
  }
  return body;
}

async function query(sql) {
  return managementRequest(`/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query: sql }),
  });
}

async function optionalManagementRequest(path) {
  try {
    return await managementRequest(path);
  } catch {
    return null;
  }
}

async function optionalQuery(sql) {
  try {
    return await query(sql);
  } catch {
    return [];
  }
}

const SQL = {
  system: `
    select
      current_database() as database,
      current_setting('server_version') as server_version,
      current_setting('server_encoding') as server_encoding,
      (select datcollate from pg_database where datname = current_database()) as lc_collate,
      (select datctype from pg_database where datname = current_database()) as lc_ctype,
      current_setting('TimeZone') as timezone,
      pg_database_size(current_database())::bigint as database_bytes
  `,
  settings: `
    select name, setting, unit, source
    from pg_settings
    where name in (
      'wal_level', 'max_wal_senders', 'max_replication_slots',
      'max_connections', 'shared_preload_libraries', 'track_commit_timestamp'
    )
    order by name
  `,
  extensions: `
    select e.extname as name, e.extversion as version, n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    order by e.extname
  `,
  tables: `
    select
      n.nspname as schema,
      c.relname as name,
      c.relkind,
      c.relreplident as replica_identity,
      c.reltuples::bigint as estimated_rows,
      pg_relation_size(c.oid)::bigint as table_bytes,
      pg_indexes_size(c.oid)::bigint as index_bytes,
      pg_total_relation_size(c.oid)::bigint as total_bytes,
      obj_description(c.oid, 'pg_class') as comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('optimat', 'public')
      and c.relkind in ('r', 'p')
    order by n.nspname, c.relname
  `,
  columns: `
    select
      table_schema as schema,
      table_name,
      ordinal_position,
      column_name,
      data_type,
      udt_schema,
      udt_name,
      is_nullable,
      column_default,
      is_identity,
      identity_generation,
      character_maximum_length,
      numeric_precision,
      numeric_scale
    from information_schema.columns
    where table_schema in ('optimat', 'public')
    order by table_schema, table_name, ordinal_position
  `,
  constraints: `
    select
      n.nspname as schema,
      c.relname as table_name,
      con.conname as name,
      con.contype as type,
      con.condeferrable as deferrable,
      con.condeferred as initially_deferred,
      pg_get_constraintdef(con.oid, true) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('optimat', 'public')
    order by n.nspname, c.relname, con.conname
  `,
  indexes: `
    select schemaname as schema, tablename as table_name, indexname as name, indexdef as definition
    from pg_indexes
    where schemaname in ('optimat', 'public')
    order by schemaname, tablename, indexname
  `,
  views: `
    select schemaname as schema, viewname as name, definition
    from pg_views
    where schemaname in ('optimat', 'public')
    order by schemaname, viewname
  `,
  routines: `
    select
      n.nspname as schema,
      p.proname as name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments,
      pg_get_function_result(p.oid) as result_type,
      p.prosecdef as security_definer,
      l.lanname as language,
      p.proconfig as configuration,
      pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname in ('optimat', 'public')
    order by n.nspname, p.proname, identity_arguments
  `,
  triggers: `
    select
      n.nspname as schema,
      c.relname as table_name,
      t.tgname as name,
      pg_get_triggerdef(t.oid, true) as definition,
      t.tgenabled as enabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('optimat', 'public') and not t.tgisinternal
    order by n.nspname, c.relname, t.tgname
  `,
  policies: `
    select schemaname as schema, tablename as table_name, policyname as name,
      permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname in ('optimat', 'public', 'storage')
    order by schemaname, tablename, policyname
  `,
  grants: `
    select table_schema as schema, table_name, grantee, privilege_type, is_grantable
    from information_schema.role_table_grants
    where table_schema in ('optimat', 'public', 'storage')
    order by table_schema, table_name, grantee, privilege_type
  `,
  sequences: `
    select sequence_schema as schema, sequence_name as name, data_type,
      start_value, minimum_value, maximum_value, increment, cycle_option
    from information_schema.sequences
    where sequence_schema in ('optimat', 'public')
    order by sequence_schema, sequence_name
  `,
  publications: `
    select p.pubname as publication, p.puballtables as all_tables,
      p.pubinsert as publish_insert, p.pubupdate as publish_update,
      p.pubdelete as publish_delete, p.pubtruncate as publish_truncate,
      n.nspname as schema, c.relname as table_name
    from pg_publication p
    left join pg_publication_rel pr on pr.prpubid = p.oid
    left join pg_class c on c.oid = pr.prrelid
    left join pg_namespace n on n.oid = c.relnamespace
    order by p.pubname, n.nspname, c.relname
  `,
  replicationSlots: `
    select slot_name, plugin, slot_type, database, temporary, active,
      restart_lsn::text, confirmed_flush_lsn::text, wal_status
    from pg_replication_slots
    order by slot_name
  `,
  roles: `
    select rolname as name, rolsuper as superuser, rolinherit as inherit,
      rolcreaterole as create_role, rolcreatedb as create_db,
      rolcanlogin as can_login, rolreplication as replication,
      rolbypassrls as bypass_rls
    from pg_roles
    where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_admin')
       or rolname like 'dms_%'
       or rolname like 'optimat_%'
    order by rolname
  `,
  authCounts: `
    select
      (select count(*)::bigint from auth.users) as users,
      (select count(*)::bigint from auth.identities) as identities,
      (select count(*)::bigint from auth.sessions) as sessions
  `,
  storageBuckets: `
    select b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types,
      count(o.id)::bigint as object_count,
      coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint as object_bytes
    from storage.buckets b
    left join storage.objects o on o.bucket_id = b.id
    group by b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types
    order by b.id
  `,
  cronJobs: `
    select jobid, schedule, command, nodename, nodeport, database, username, active, jobname
    from cron.job
    order by jobid
  `,
};

function safeAuthConfig(config) {
  const safe = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (
      key.endsWith('_enabled') ||
      [
        'disable_signup',
        'external_anonymous_users_enabled',
        'external_email_enabled',
        'external_phone_enabled',
        'mailer_autoconfirm',
        'mailer_allow_unverified_email_sign_ins',
        'password_min_length',
        'jwt_exp',
        'security_captcha_enabled',
        'sessions_timebox',
        'sessions_inactivity_timeout',
        'api_max_request_duration',
      ].includes(key)
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

console.log('Capturing Supabase management configuration...');
const [
  project,
  authConfig,
  storageConfig,
  functions,
  secrets,
  networkRestrictions,
  sslEnforcement,
  backups,
] = await Promise.all([
  managementRequest(`/projects/${PROJECT_REF}`),
  managementRequest(`/projects/${PROJECT_REF}/config/auth`),
  managementRequest(`/projects/${PROJECT_REF}/config/storage`),
  managementRequest(`/projects/${PROJECT_REF}/functions`),
  managementRequest(`/projects/${PROJECT_REF}/secrets`),
  optionalManagementRequest(`/projects/${PROJECT_REF}/network-restrictions`),
  optionalManagementRequest(`/projects/${PROJECT_REF}/ssl-enforcement`),
  optionalManagementRequest(`/projects/${PROJECT_REF}/database/backups`),
]);

console.log('Capturing PostgreSQL catalog...');
const database = {};
for (const [name, sql] of Object.entries(SQL)) {
  console.log(`- ${name}`);
  const optional = ['cronJobs', 'replicationSlots', 'authCounts', 'storageBuckets'].includes(name);
  database[name] = optional ? await optionalQuery(sql) : await query(sql);
}

if (skipChecksums) {
  database.tableChecksums = previousInventory?.database?.tableChecksums || [];
  console.log('Reusing prior exact table checksums.');
} else {
  console.log('Computing exact table counts and content checksums...');
  database.tableChecksums = [];
  for (const table of database.tables) {
    const tableRef = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
    const [result] = await query(`
      select count(*)::bigint as row_count,
        md5(coalesce(string_agg(row_hash, '' order by row_hash), '')) as content_checksum
      from (select md5(to_jsonb(t)::text) as row_hash from ${tableRef} t) rows
    `);
    database.tableChecksums.push({
      schema: table.schema,
      table_name: table.name,
      row_count: result?.row_count ?? 0,
      content_checksum: result?.content_checksum ?? null,
    });
  }
}

const inventory = {
  captured_at: new Date().toISOString(),
  project: {
    ref: PROJECT_REF,
    name: project.name,
    region: project.region,
    status: project.status,
    database: project.database
      ? {
          host: project.database.host,
          version: project.database.version,
          postgres_engine: project.database.postgres_engine,
        }
      : null,
  },
  auth: safeAuthConfig(authConfig),
  storage: {
    fileSizeLimit: storageConfig.fileSizeLimit,
    features: storageConfig.features,
    capabilities: storageConfig.capabilities,
  },
  network_restrictions: networkRestrictions,
  ssl_enforcement: sslEnforcement,
  backups: backups
    ? {
        region: backups.region,
        pitr_enabled: backups.pitr_enabled,
        walg_enabled: backups.walg_enabled,
        backup_count: Array.isArray(backups.backups) ? backups.backups.length : null,
      }
    : null,
  edge_functions: functions.map((fn) => ({
    id: fn.id,
    name: fn.name,
    slug: fn.slug,
    status: fn.status,
    version: fn.version,
    verify_jwt: fn.verify_jwt,
    entrypoint_path: fn.entrypoint_path,
    import_map_path: fn.import_map_path,
    created_at: fn.created_at,
    updated_at: fn.updated_at,
  })),
  secret_names: secrets.map((secret) => ({
    name: secret.name,
    updated_at: secret.updated_at,
  })),
  database,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
console.log(`Inventory written to ${outputPath}`);
console.log(`Tables: ${database.tables.length}; functions: ${inventory.edge_functions.length}`);
