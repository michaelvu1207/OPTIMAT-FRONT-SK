/**
 * Database Connection Layer for AWS Lambda
 *
 * Provides a pg Pool connected directly to Aurora PostgreSQL.
 * Replaces the Supabase JS client used by the Edge Functions.
 *
 * Connection is lazy-initialized on first query and reused across
 * warm Lambda invocations. The pool is configured for Lambda's
 * concurrency model (max 1 connection per invocation).
 */

import pg from 'pg';
import { getSecret } from './secrets.js';

const { Pool } = pg;

// ─── Schema & Table Constants ───────────────────────────────────────────────

export const OPTIMAT_SCHEMA = 'optimat';

export const TABLES = {
  PROVIDERS: `${OPTIMAT_SCHEMA}.providers`,
  CONVERSATIONS: `${OPTIMAT_SCHEMA}.conversations`,
  MESSAGES: `${OPTIMAT_SCHEMA}.messages`,
  CHAT_EXAMPLES: `${OPTIMAT_SCHEMA}.chat_examples`,
  CHAT_FEEDBACK: `${OPTIMAT_SCHEMA}.chat_feedback`,
  FIND_PROVIDERS_CALLS: `${OPTIMAT_SCHEMA}.find_providers_calls`,
  SEARCH_ADDRESSES_CALLS: `${OPTIMAT_SCHEMA}.search_addresses_calls`,
  GET_PROVIDER_INFO_CALLS: `${OPTIMAT_SCHEMA}.get_provider_info_calls`,
  GENERAL_QUESTION_CALLS: `${OPTIMAT_SCHEMA}.general_question_calls`,
  CONVERSATION_STATES: `${OPTIMAT_SCHEMA}.conversation_states`,
  CHAT_TRIP_STATE: `${OPTIMAT_SCHEMA}.chat_trip_state`,
  TOOL_CALLS: `${OPTIMAT_SCHEMA}.tool_calls`,
  TRIP_RECORD_PAIRS_RAW: `${OPTIMAT_SCHEMA}.trip_record_pairs_raw`,
  DEMAND_RESPONSE_MANIFEST_REVIEW: `${OPTIMAT_SCHEMA}.demand_response_manifest_review`,
  TRI_DELTA_TRANSIT: `${OPTIMAT_SCHEMA}.tri_delta_transit`,
  TRANSIT_DRIVING_DRIVING: `${OPTIMAT_SCHEMA}.transit_driving_driving`,
} as const;

// ─── Pool Management ────────────────────────────────────────────────────────

let pool: pg.Pool | null = null;

/**
 * Get (or create) the database connection pool.
 * Uses the Aurora endpoint from the application database secret.
 * Credentials are loaded from Secrets Manager on first call.
 */
export async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const dbSecretArn = process.env.DB_SECRET_ARN;
  let config: pg.PoolConfig;

  if (dbSecretArn) {
    // Production: load credentials from Secrets Manager
    const secret = await getSecret(dbSecretArn);
    config = {
      host: process.env.DB_PROXY_ENDPOINT || secret.host,
      port: parseInt(secret.port || '5432'),
      database: secret.dbname || 'optimat',
      user: secret.username,
      password: secret.password,
      ssl: { rejectUnauthorized: true },
      max: 1, // Lambda runs one invocation at a time
      idleTimeoutMillis: 120_000,
      connectionTimeoutMillis: 5_000,
    };
  } else {
    // Local development: use direct env vars
    config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'optimat',
      user: process.env.DB_USER || 'optimat_admin',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: true },
      max: 1,
      idleTimeoutMillis: 120_000,
      connectionTimeoutMillis: 5_000,
    };
  }

  pool = new Pool(config);

  // Log connection errors (don't crash the Lambda)
  pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
  });

  return pool;
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

/**
 * Execute a parameterized query against the database.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const p = await getPool();
  return p.query<T>(text, params);
}

/**
 * Execute a query and return the rows array.
 */
export async function queryRows<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

/**
 * Execute a query expecting a single row. Returns null if no rows.
 */
export async function queryOne<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] || null;
}

/**
 * Execute a query expecting a single row. Throws if no rows.
 */
export async function queryOneOrFail<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<T> {
  const row = await queryOne<T>(text, params);
  if (!row) throw new Error('Expected a row but got none');
  return row;
}

// ─── Provider Normalization ─────────────────────────────────────────────────

/**
 * Normalize a provider record from the database for API response.
 * Mirrors the behavior of the Supabase Edge Function's normalizeProvider().
 */
export function normalizeProvider(record: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...record };

  // Provider contacts are administrative data and must never be emitted by the
  // public API, even when an internal query selected the full row.
  delete normalized.contacts;

  // Ensure provider_id is a string
  if (normalized.provider_id !== undefined) {
    normalized.provider_id = String(normalized.provider_id);
  }

  // Parse service_zone if it's a string
  if (typeof normalized.service_zone === 'string') {
    try {
      normalized.service_zone = JSON.parse(normalized.service_zone);
    } catch {
      // leave as-is
    }
  }

  // Convert JSONB fields to JSON strings for frontend display
  const jsonbFields = ['eligibility_reqs', 'booking', 'fare', 'contacts', 'schedule_type', 'service_hours'];
  for (const field of jsonbFields) {
    const value = normalized[field];
    if (value !== null && value !== undefined && typeof value === 'object') {
      normalized[field] = JSON.stringify(value);
    }
  }

  // Calculate has_service_zone
  normalized.has_service_zone = normalized.service_zone !== null && normalized.service_zone !== undefined;

  return normalized;
}

/**
 * Sanitize a database record for API response.
 * Ensures UUIDs and dates are strings.
 */
export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...record };
  if (sanitized.id !== undefined) sanitized.id = String(sanitized.id);
  if (sanitized.conversation_id !== undefined) sanitized.conversation_id = String(sanitized.conversation_id);
  if (sanitized.example_id !== undefined) sanitized.example_id = String(sanitized.example_id);
  return sanitized;
}
