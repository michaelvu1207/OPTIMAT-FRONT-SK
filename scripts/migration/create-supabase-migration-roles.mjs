#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'htjohidcoyfuwfjecazu';
const API_BASE = 'https://api.supabase.com/v1';
const OP = '/Users/maikyon/bin/op-michaelagents';
const VAULT = 'MichaelAgents';

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
    throw new Error(`Role setup failed (${response.status}): ${body?.message || 'unknown error'}`);
  }
  return body;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function findVaultItem(title) {
  const items = JSON.parse(
    execFileSync(OP, ['item', 'list', '--vault', VAULT, '--format', 'json'], {
      encoding: 'utf8',
    }),
  );
  return items.find((item) => item.title === title) || null;
}

function storeCredential(title, username, password) {
  const existing = findVaultItem(title);
  if (existing) {
    execFileSync(
      OP,
      ['item', 'edit', existing.id, '--vault', VAULT, `username=${username}`, `password=${password}`],
      { stdio: 'ignore' },
    );
    return existing.id;
  }

  const created = JSON.parse(
    execFileSync(
      OP,
      [
        'item',
        'create',
        '--category',
        'login',
        '--title',
        title,
        '--vault',
        VAULT,
        `username=${username}`,
        `password=${password}`,
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    ),
  );
  return created.id;
}

const readerPassword = randomBytes(36).toString('base64url');
const dmsPassword = randomBytes(36).toString('base64url');

await query(`
  do $$
  begin
    if exists (select 1 from pg_roles where rolname = 'optimat_migration_reader') then
      alter role optimat_migration_reader with password ${quoteLiteral(readerPassword)};
    else
      create role optimat_migration_reader with login password ${quoteLiteral(readerPassword)}
        nosuperuser nocreatedb nocreaterole noreplication;
    end if;

    if exists (select 1 from pg_roles where rolname = 'optimat_dms') then
      alter role optimat_dms with password ${quoteLiteral(dmsPassword)};
    else
      create role optimat_dms with login password ${quoteLiteral(dmsPassword)}
        nosuperuser nocreatedb nocreaterole replication;
    end if;
  end $$;

  grant connect on database postgres to optimat_migration_reader, optimat_dms;
  grant usage on schema optimat, public to optimat_migration_reader, optimat_dms;
  grant select on all tables in schema optimat, public to optimat_migration_reader, optimat_dms;
  grant select on all sequences in schema optimat, public to optimat_migration_reader, optimat_dms;
  alter default privileges in schema optimat grant select on tables to optimat_migration_reader, optimat_dms;
  alter default privileges in schema optimat grant select on sequences to optimat_migration_reader, optimat_dms;

  do $$
  declare
    target record;
  begin
    for target in
      select n.nspname as schema_name, c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('optimat', 'public')
        and c.relkind in ('r', 'p')
        and c.relrowsecurity
    loop
      execute format(
        'drop policy if exists optimat_migration_read_all on %I.%I',
        target.schema_name,
        target.table_name
      );
      execute format(
        'create policy optimat_migration_read_all on %I.%I for select to optimat_migration_reader, optimat_dms using (true)',
        target.schema_name,
        target.table_name
      );
    end loop;
  end $$;
`);

const readerItem = storeCredential(
  'OPTIMAT Supabase Migration Reader',
  `optimat_migration_reader.${PROJECT_REF}`,
  readerPassword,
);
const dmsItem = storeCredential('OPTIMAT Supabase DMS Source', 'optimat_dms', dmsPassword);

const roles = await query(`
  select rolname as name, rolcanlogin as can_login, rolreplication as replication,
    rolsuper as superuser, rolcreatedb as create_db, rolcreaterole as create_role,
    rolbypassrls as bypass_rls
  from pg_roles
  where rolname in ('optimat_migration_reader', 'optimat_dms')
  order by rolname
`);

console.log(JSON.stringify({ roles, vault_items: [readerItem, dmsItem] }, null, 2));
