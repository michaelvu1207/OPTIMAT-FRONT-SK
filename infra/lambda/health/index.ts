/**
 * Health Check Lambda Function
 *
 * Simple health probe endpoint for service monitoring.
 *
 * Routes:
 *   GET /health → { status: "ok" }
 */

import { createHandler, jsonResponse } from '../_shared/adapter.js';

export const handler = createHandler(async (req) => {
  return jsonResponse({ status: 'ok' }, 200, req.origin);
});
