import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { queryOne, TABLES } from '../_shared/db.js';
import { requireMigrationAdmin } from '../_shared/admin.js';

type UpdatePayload = {
  updates?: Array<{ provider_id: number; schedule_type: Record<string, unknown> }>;
};

export const handler = createHandler(async (req) => {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req.origin);
  const unauthorized = await requireMigrationAdmin(req);
  if (unauthorized) return unauthorized;

  const body = req.body as UpdatePayload | null;
  const updates = Array.isArray(body?.updates) ? body.updates : [];
  if (!updates.length) return errorResponse('updates array is required', 400, req.origin);

  const updated: Record<string, unknown>[] = [];
  for (const item of updates) {
    if (!Number.isFinite(item.provider_id) || !item.schedule_type || typeof item.schedule_type !== 'object') {
      return errorResponse('Invalid update payload', 400, req.origin);
    }
    const row = await queryOne(
      `UPDATE ${TABLES.PROVIDERS}
       SET schedule_type = $1::jsonb, updated_at = now()
       WHERE provider_id = $2
       RETURNING provider_id, provider_name, schedule_type`,
      [JSON.stringify(item.schedule_type), item.provider_id],
    );
    if (!row) return errorResponse(`Provider ${item.provider_id} not found`, 404, req.origin);
    updated.push(row);
  }

  return jsonResponse({ success: true, updated_count: updated.length, updated }, 200, req.origin);
});
