import { timingSafeEqual } from 'node:crypto';
import type { ParsedRequest, LambdaResponse } from './adapter.js';
import { errorResponse } from './adapter.js';
import { getApiKeys } from './secrets.js';

const ADMIN_TOKEN_HEADER = 'x-optimat-admin-token';

export async function isMigrationAdminRequest(req: ParsedRequest): Promise<boolean> {
  const secrets = await getApiKeys();
  const expected = secrets.OPTIMAT_MIGRATION_ADMIN_TOKEN || '';
  const provided = req.headers[ADMIN_TOKEN_HEADER] || req.headers['x-admin-token'] || '';
  if (expected.length < 32 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function requireMigrationAdmin(
  req: ParsedRequest,
): Promise<LambdaResponse | null> {
  if (await isMigrationAdminRequest(req)) return null;
  return errorResponse('Administrative authentication required', 401, req.origin);
}
