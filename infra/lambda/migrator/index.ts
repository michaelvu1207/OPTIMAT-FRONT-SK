import pg from 'pg';
import type { Context } from 'aws-lambda';
import { getSecret } from '../_shared/secrets.js';
import { BASELINE_SQL } from './baseline.js';

const { Client } = pg;

type MigrationEvent = {
  action?: 'status' | 'apply-baseline';
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function connect(secretArn: string): Promise<pg.Client> {
  const secret = await getSecret(secretArn);
  const client = new Client({
    host: secret.host || requiredEnvironment('DB_HOST'),
    port: Number(secret.port || 5432),
    database: secret.dbname || 'optimat',
    user: secret.username,
    password: secret.password,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

async function ensureApplicationRole(client: pg.Client, appSecretArn: string): Promise<void> {
  const appSecret = await getSecret(appSecretArn);
  if (appSecret.username !== 'optimat_app' || !appSecret.password) {
    throw new Error('Application database secret has an unexpected shape');
  }

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'optimat_app') then
        create role optimat_app login nosuperuser nocreatedb nocreaterole noreplication;
      end if;
    end $$;
  `);
  await client.query(`alter role optimat_app password ${quoteLiteral(appSecret.password)}`);
}

async function migrationStatus(client: pg.Client) {
  const tables = await client.query<{ table_name: string }>(`
    select table_name
    from information_schema.tables
    where table_schema = 'optimat' and table_type = 'BASE TABLE'
    order by table_name
  `);
  let migrations: Array<{ version: string; applied_at: string; source_checksum: string }> = [];
  try {
    const result = await client.query(
      'select version, applied_at, source_checksum from optimat.schema_migrations order by applied_at',
    );
    migrations = result.rows;
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error;
  }
  return { table_count: tables.rowCount || 0, tables: tables.rows, migrations };
}

export const handler = async (event: MigrationEvent = {}, _context?: Context) => {
  const action = event.action || 'status';
  if (action !== 'status' && action !== 'apply-baseline') {
    return { success: false, error: 'Unsupported migration action' };
  }

  const masterSecretArn = requiredEnvironment('DB_MASTER_SECRET_ARN');
  const appSecretArn = requiredEnvironment('DB_APP_SECRET_ARN');
  const client = await connect(masterSecretArn);

  try {
    if (action === 'apply-baseline') {
      await ensureApplicationRole(client, appSecretArn);
      const status = await migrationStatus(client);
      if (!status.migrations.some((migration) => migration.version === '0001_supabase_baseline')) {
        await client.query(BASELINE_SQL);
      }
    }

    return { success: true, action, ...(await migrationStatus(client)) };
  } catch (error) {
    console.error('Migration action failed', {
      action,
      code: (error as { code?: string }).code,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await client.end();
  }
};
