import { createHandler, jsonResponse } from '../_shared/adapter.js';

export const handler = createHandler(async (req) =>
  jsonResponse({ error: 'Provider import endpoint is disabled' }, 410, req.origin),
);
