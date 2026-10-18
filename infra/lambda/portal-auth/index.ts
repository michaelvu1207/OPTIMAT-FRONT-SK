import { randomBytes, randomUUID } from 'node:crypto';
import { createHandler, jsonResponse, errorResponse, type ParsedRequest } from '../_shared/adapter.js';
import { getPool, query, queryOne, queryRows, normalizeProvider } from '../_shared/db.js';
import { getAccount, sessionHash } from '../_shared/portal-auth.js';
import { hashPassword, verifyPassword, validPassword, hashToken } from '../_shared/portal-password.js';

const safeColumns = 'id, username, display_name, role, active, created_at';
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Unknown usernames also run scrypt, avoiding a fast username enumeration path.
const dummyHash = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;

async function route(req: ParsedRequest) {
  const path = req.pathSegments.slice(1).join('/');
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const fail = (message: string, code = 400) => errorResponse(message, code, req.origin);
  if (req.method === 'POST' && path === 'login') {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    if (!username || username.length > 80 || typeof body.password !== 'string' || body.password.length > 128) return fail('Invalid username or password.', 401);
    // Both source IP and username limits are shared across Lambda instances.
    for (const key of [`ip:${req.rawEvent.requestContext.http.sourceIp}`, `user:${username}`]) {
      const limit = await queryOne(`INSERT INTO optimat.portal_login_limits(key, attempts, resets_at)
        VALUES ($1, 1, now() + interval '15 minutes') ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN portal_login_limits.resets_at <= now() THEN 1 ELSE portal_login_limits.attempts + 1 END,
        resets_at = CASE WHEN portal_login_limits.resets_at <= now() THEN now() + interval '15 minutes' ELSE portal_login_limits.resets_at END
        RETURNING attempts`, [hashToken(key)]);
      if (limit!.attempts > (key.startsWith('ip:') ? 50 : 10)) return fail('Too many login attempts. Try again in 15 minutes.', 429);
    }
    const account = await queryOne(`SELECT * FROM optimat.portal_accounts WHERE username = $1`, [username]);
    const valid = await verifyPassword(body.password, account?.password_hash || dummyHash);
    if (!account?.active || !valid) return fail('Invalid username or password.', 401);
    const token = randomBytes(32).toString('hex');
    // Re-check the password/active state atomically against concurrent resets.
    const inserted = await queryOne(`INSERT INTO optimat.portal_sessions(token_hash, account_id, expires_at)
      SELECT $1, id, now() + interval '8 hours' FROM optimat.portal_accounts
      WHERE id = $2 AND active AND password_hash = $3 FOR SHARE RETURNING expires_at`, [hashToken(token), account.id, account.password_hash]);
    if (!inserted) return fail('Invalid username or password.', 401);
    await query('DELETE FROM optimat.portal_sessions WHERE expires_at <= now()');
    await query('DELETE FROM optimat.portal_login_limits WHERE resets_at <= now() OR key = $1', [hashToken(`user:${username}`)]);
    return jsonResponse({ token, expires_at: inserted.expires_at }, 200, req.origin);
  }
  const account = await getAccount(req);
  if (!account) return fail('Please sign in to your provider account.', 401);
  if (req.method === 'POST' && path === 'logout') {
    await query('DELETE FROM optimat.portal_sessions WHERE token_hash = $1', [sessionHash(req)]);
    return jsonResponse({ success: true });
  }
  if (req.method === 'GET' && path === 'me') return jsonResponse(account);
  if (req.method === 'POST' && path === 'password') {
    if (!validPassword(body.password)) return fail('Use a password of 8–128 characters.');
    if (typeof body.current_password !== 'string' || body.current_password.length > 128) return fail('Current password is required.');
    if (body.password === body.current_password) return fail('Choose a different password.');
    const pool = await getPool(); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT password_hash FROM optimat.portal_accounts WHERE id = $1 FOR UPDATE', [account.id]);
      if (!await verifyPassword(body.current_password, rows[0].password_hash)) { await client.query('ROLLBACK'); return fail('Current password is incorrect.', 400); }
      await client.query('UPDATE optimat.portal_accounts SET password_hash = $2 WHERE id = $1', [account.id, await hashPassword(body.password)]);
      await client.query('DELETE FROM optimat.portal_sessions WHERE account_id = $1', [account.id]);
      await client.query('COMMIT');
      return jsonResponse({ success: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (req.method === 'GET' && path === 'providers') {
    const rows = await queryRows(`SELECT p.* FROM optimat.providers p WHERE $1 = 'super_admin' OR EXISTS
      (SELECT 1 FROM optimat.portal_account_providers ap WHERE ap.account_id = $2 AND ap.provider_id = p.provider_id)
      ORDER BY p.provider_name`, [account.role, account.id]);
    return jsonResponse(rows.map(normalizeProvider));
  }
  if (account.role !== 'super_admin') return fail('Super administrator access required.', 403);
  if (req.method === 'GET' && path === 'accounts') {
    return jsonResponse(await queryRows(`SELECT ${safeColumns}, COALESCE((SELECT json_agg(provider_id ORDER BY provider_id)
      FROM optimat.portal_account_providers WHERE account_id = a.id), '[]'::json) AS provider_ids FROM optimat.portal_accounts a ORDER BY username`));
  }
  const targetId = req.pathSegments[2];
  const creating = req.method === 'POST' && path === 'accounts';
  const updating = req.method === 'PUT' && req.pathSegments.length === 3 && req.pathSegments[1] === 'accounts' && uuidPattern.test(targetId || '');
  if (creating || updating) {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    if (creating && !/^[a-z0-9][a-z0-9._@+-]{2,79}$/.test(username)) return fail('Username must contain 3–80 letters, numbers, or . _ @ + -');
    if (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.length > 120) return fail('Display name is required (up to 120 characters).');
    if (!['provider', 'super_admin'].includes(String(body.role)) || typeof body.active !== 'boolean') return fail('Invalid role or account status.');
    if (!Array.isArray(body.provider_ids) || body.provider_ids.length > 1000 || body.provider_ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return fail('Invalid provider assignments.');
    if ((creating || body.password !== undefined) && !validPassword(body.password)) return fail('Use a password of 8–128 characters.');
    // Self-editing role, status, and password is handled through explicit safeguards.
    if (targetId === account.id && (body.role !== 'super_admin' || !body.active || body.password !== undefined)) return fail('You cannot disable, demote, or reset yourself. Use Change password.');
    const passwordHash = body.password === undefined ? null : await hashPassword(body.password as string);
    const pool = await getPool(); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes administrative mutations, including re-checking the acting admin.
      await client.query("SELECT pg_advisory_xact_lock(17640201)");
      const actor = await client.query("SELECT 1 FROM optimat.portal_accounts a JOIN optimat.portal_sessions s ON s.account_id = a.id WHERE a.id = $1 AND a.active AND a.role = 'super_admin' AND s.token_hash = $2 AND s.expires_at > now()", [account.id, sessionHash(req)]);
      if (!actor.rowCount) { await client.query('ROLLBACK'); return fail('Administrator session is no longer valid.', 401); }
      const id = creating ? randomUUID() : targetId;
      if (creating) {
        await client.query(`INSERT INTO optimat.portal_accounts(id, username, display_name, password_hash, role, active) VALUES ($1,$2,$3,$4,$5,$6)`, [id, username, body.display_name.trim(), passwordHash, body.role, body.active]);
      } else {
        const updated = await client.query(`UPDATE optimat.portal_accounts SET display_name=$2, role=$3, active=$4,
          password_hash=COALESCE($5,password_hash) WHERE id=$1`, [id, body.display_name.trim(), body.role, body.active, passwordHash]);
        if (!updated.rowCount) { await client.query('ROLLBACK'); return fail('Account not found.', 404); }
      }
      await client.query('DELETE FROM optimat.portal_account_providers WHERE account_id = $1', [id]);
      for (const providerId of new Set(body.provider_ids as number[])) await client.query('INSERT INTO optimat.portal_account_providers(account_id, provider_id) VALUES ($1,$2)', [id, providerId]);
      if (!creating && id !== account.id) await client.query('DELETE FROM optimat.portal_sessions WHERE account_id = $1', [id]);
      await client.query('COMMIT');
      return jsonResponse({ success: true }, creating ? 201 : 200);
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') return fail('Username already exists.', 409);
      if ((error as { code?: string }).code === '23503') return fail('One or more providers no longer exist.');
      throw error;
    } finally { client.release(); }
  }
  return fail('Not found', 404);
}
export const handler = createHandler(async req => {
  try {
    const result = await route(req);
    if (typeof result === 'object') result.headers = { ...result.headers, 'Cache-Control': 'no-store' };
    return result;
  } catch {
    console.error('Portal authentication request failed');
    return errorResponse('Account service is unavailable. Please try again later.', 503, req.origin);
  }
});
