import type { ParsedRequest } from './adapter.js';
import { errorResponse } from './adapter.js';
import { queryOne } from './db.js';
import { hashToken } from './portal-password.js';

export interface PortalAccount {
  id: string; username: string; display_name: string;
  role: 'super_admin' | 'provider'; active: boolean;
}
export function sessionHash(req: ParsedRequest): string | null {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  return match ? hashToken(match[1]) : null;
}
export async function getAccount(req: ParsedRequest): Promise<PortalAccount | null> {
  const hash = sessionHash(req);
  if (!hash) return null;
  return queryOne<PortalAccount>(`SELECT a.id, a.username, a.display_name, a.role, a.active
    FROM optimat.portal_sessions s JOIN optimat.portal_accounts a ON a.id = s.account_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`, [hash]);
}
export async function requireProviderAccess(req: ParsedRequest, providerId: unknown) {
  const account = await getAccount(req);
  if (!account) return errorResponse('Please sign in to your provider account.', 401, req.origin);
  if (!/^\d+$/.test(String(providerId)) || !Number.isSafeInteger(Number(providerId)) || Number(providerId) <= 0) {
    return errorResponse('Invalid provider ID', 400, req.origin);
  }
  if (account.role === 'super_admin') return null;
  const permission = await queryOne(`SELECT 1 FROM optimat.portal_account_providers WHERE account_id = $1 AND provider_id = $2`, [account.id, providerId]);
  return permission ? null : errorResponse('You do not have permission to manage this provider.', 403, req.origin);
}
