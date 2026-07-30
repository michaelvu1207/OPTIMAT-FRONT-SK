import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Context } from 'aws-lambda';
import { getSecret } from '../_shared/secrets.js';

const { Client } = pg;
const BATCH_SIZE = 200;

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
] as const;

const ALL_TABLES = [
  ...MUTABLE_TABLES,
  'demand_response_manifest_review',
  'demands',
  'geoaddress',
  'mobility_matters',
  'providers_backup_service_area_20260518',
  'riderabilities',
  'transit_driving_driving',
  'tri_delta_transit',
] as const;

type SyncEvent = {
  action?: 'status' | 'status-all' | 'verify-all' | 'rehearsal-all' | 'sync-mutable' | 'sync-all';
  confirm_write_fence?: boolean;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function connect(secretArn: string): Promise<pg.Client> {
  const secret = await getSecret(secretArn);
  const client = new Client({
    host: secret.host,
    port: Number(secret.port || 5432),
    database: secret.dbname || secret.database || 'postgres',
    user: secret.username,
    password: secret.password,
    // Supabase's direct database endpoint presents a chain that is not rooted in
    // Lambda's trust store. It is still TLS-encrypted (equivalent to sslmode=require),
    // while Aurora uses full certificate verification.
    ssl: { rejectUnauthorized: !secret.host.endsWith('.supabase.co') },
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  await client.connect();
  return client;
}

async function getCounts(client: pg.Client, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from optimat.${quoteIdentifier(table)}`,
    );
    counts[table] = Number(result.rows[0]?.count || 0);
  }
  return counts;
}

function fingerprintDigestCounts(digestCounts: Map<string, number>): string {
  const fingerprint = createHash('sha256');
  for (const [digest, count] of [...digestCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    fingerprint.update(`${digest}:${count}\n`);
  }
  return fingerprint.digest('hex');
}

function rowDigest(row: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

async function verifySourceRows(
  source: pg.Client,
  target: pg.Client,
  tables: readonly string[],
): Promise<Record<string, {
  source_rows: number;
  target_rows: number;
  missing_source_rows: number;
  post_cutover_rows: number;
  source_fingerprint: string;
}>> {
  const verification: Record<string, {
    source_rows: number;
    target_rows: number;
    missing_source_rows: number;
    post_cutover_rows: number;
    source_fingerprint: string;
  }> = {};

  for (const table of tables) {
    const sourceColumns = await tableColumns(source, table);
    const targetColumns = new Map(
      (await tableColumns(target, table)).map((column) => [column.name, column]),
    );
    const columns = sourceColumns
      .map((column) => targetColumns.get(column.name))
      .filter((column): column is ColumnInfo => Boolean(column));
    if (!columns.length) throw new Error(`No shared columns found for optimat.${table}`);

    const columnSql = columns.map((column) => quoteIdentifier(column.name)).join(', ');
    const sourceResult = await source.query<Record<string, unknown>>(
      `select ${columnSql} from optimat.${quoteIdentifier(table)}`,
    );
    const digestCounts = new Map<string, number>();
    for (const row of sourceResult.rows) {
      const digest = rowDigest(row);
      digestCounts.set(digest, (digestCounts.get(digest) || 0) + 1);
    }
    const sourceRows = sourceResult.rowCount || 0;
    const sourceFingerprint = fingerprintDigestCounts(digestCounts);
    sourceResult.rows.length = 0;

    const targetResult = await target.query<Record<string, unknown>>(
      `select ${columnSql} from optimat.${quoteIdentifier(table)}`,
    );
    let postCutoverRows = 0;
    for (const row of targetResult.rows) {
      const digest = rowDigest(row);
      const remaining = digestCounts.get(digest) || 0;
      if (remaining > 1) digestCounts.set(digest, remaining - 1);
      else if (remaining === 1) digestCounts.delete(digest);
      else postCutoverRows += 1;
    }
    const targetRows = targetResult.rowCount || 0;
    targetResult.rows.length = 0;

    verification[table] = {
      source_rows: sourceRows,
      target_rows: targetRows,
      missing_source_rows: [...digestCounts.values()].reduce((sum, count) => sum + count, 0),
      post_cutover_rows: postCutoverRows,
      source_fingerprint: sourceFingerprint,
    };
  }
  return verification;
}

type ColumnInfo = { name: string; udtName: string };

async function tableColumns(client: pg.Client, table: string): Promise<ColumnInfo[]> {
  const result = await client.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
     where table_schema = 'optimat' and table_name = $1
     order by ordinal_position`,
    [table],
  );
  return result.rows.map((row) => ({ name: row.column_name, udtName: row.udt_name }));
}

async function insertRows(
  target: pg.Client,
  table: string,
  columns: ColumnInfo[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return;
  const columnSql = columns.map((column) => quoteIdentifier(column.name)).join(', ');
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((column) => {
        const value = row[column.name];
        values.push((column.udtName === 'json' || column.udtName === 'jsonb') && value !== null
          ? JSON.stringify(value)
          : value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await target.query(
      `insert into optimat.${quoteIdentifier(table)} (${columnSql}) values ${tuples.join(', ')}`,
      values,
    );
  }
}

async function syncTables(source: pg.Client, target: pg.Client, tables: readonly string[]) {
  await source.query('begin isolation level repeatable read read only');
  await target.query('begin');
  try {
    await target.query("set local session_replication_role = 'replica'");

    const copied: Record<string, number> = {};
    for (const table of tables) {
      const sourceColumns = await tableColumns(source, table);
      const targetColumns = new Map(
        (await tableColumns(target, table)).map((column) => [column.name, column]),
      );
      const columns = sourceColumns
        .map((column) => targetColumns.get(column.name))
        .filter((column): column is ColumnInfo => Boolean(column));
      if (!columns.length) throw new Error(`No shared columns found for optimat.${table}`);

      const columnSql = columns.map((column) => quoteIdentifier(column.name)).join(', ');
      const sourceRows = await source.query<Record<string, unknown>>(
        `select ${columnSql} from optimat.${quoteIdentifier(table)}`,
      );
      await target.query(`delete from optimat.${quoteIdentifier(table)}`);
      await insertRows(target, table, columns, sourceRows.rows);
      copied[table] = sourceRows.rowCount || 0;
    }

    const sourceCounts = await getCounts(source, tables);
    const targetCounts = await getCounts(target, tables);
    const mismatches = tables.filter((table) => sourceCounts[table] !== targetCounts[table]);
    if (mismatches.length) throw new Error(`Row-count verification failed: ${mismatches.join(', ')}`);

    await target.query('commit');
    await source.query('commit');
    return { copied, source_counts: sourceCounts, target_counts: targetCounts };
  } catch (error) {
    await Promise.allSettled([target.query('rollback'), source.query('rollback')]);
    throw error;
  }
}

export const handler = async (event: SyncEvent = {}, _context?: Context) => {
  const action = event.action || 'status';
  if (!['status', 'status-all', 'verify-all', 'rehearsal-all', 'sync-mutable', 'sync-all'].includes(action)) {
    return { success: false, error: 'Unsupported sync action' };
  }
  if ((action === 'sync-mutable' || action === 'sync-all') && event.confirm_write_fence !== true) {
    return { success: false, error: `${action} requires confirm_write_fence=true` };
  }

  const source = await connect(requiredEnvironment('SOURCE_SECRET_ARN'));
  const target = await connect(requiredEnvironment('TARGET_SECRET_ARN'));
  try {
    if (action === 'status' || action === 'status-all') {
      const tables = action === 'status-all' ? ALL_TABLES : MUTABLE_TABLES;
      return {
        success: true,
        action,
        source_counts: await getCounts(source, tables),
        target_counts: await getCounts(target, tables),
      };
    }
    if (action === 'verify-all') {
      const verification = await verifySourceRows(source, target, ALL_TABLES);
      const missingSourceRows = Object.values(verification)
        .reduce((sum, table) => sum + table.missing_source_rows, 0);
      const postCutoverRows = Object.values(verification)
        .reduce((sum, table) => sum + table.post_cutover_rows, 0);
      return {
        success: missingSourceRows === 0,
        action,
        verified_tables: ALL_TABLES.length,
        missing_source_rows: missingSourceRows,
        post_cutover_rows: postCutoverRows,
        tables: verification,
      };
    }
    const tables = action === 'sync-mutable' ? MUTABLE_TABLES : ALL_TABLES;
    return { success: true, action, ...(await syncTables(source, target, tables)) };
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
};
