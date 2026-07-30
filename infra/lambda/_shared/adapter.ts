/**
 * Lambda Request/Response Adapter
 *
 * Converts API Gateway HTTP API v2 events into a simplified request format
 * and provides response helpers with CORS headers. This replaces the Deno
 * serve() + Web API pattern used by Supabase Edge Functions.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ParsedRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  origin: string | null;
  pathSegments: string[];   // e.g. ['providers', '123', 'service-zone']
  rawEvent: APIGatewayProxyEventV2;
}

export type LambdaResponse = APIGatewayProxyResultV2;

// ─── CORS Configuration ────────────────────────────────────────────────────

function getCorsHeaders(_origin?: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-requested-with, x-api-key, x-optimat-admin-token, x-admin-token, apikey, x-client-info',
    'Access-Control-Max-Age': '86400',
  };
}

// ─── Request Parsing ────────────────────────────────────────────────────────

/**
 * Parse an API Gateway HTTP API v2 event into a simplified request object.
 * Mirrors the info previously extracted from `new URL(req.url)` and `req.json()`.
 */
export function parseRequest(event: APIGatewayProxyEventV2): ParsedRequest {
  const method = event.requestContext.http.method.toUpperCase();
  const pathname = event.rawPath || '/';
  const searchParams = new URLSearchParams(
    event.rawQueryString || ''
  );

  // Lowercase headers for case-insensitive access
  const headers: Record<string, string> = {};
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      headers[k.toLowerCase()] = v || '';
    }
  }

  // Parse body
  let body: unknown = null;
  if (event.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : event.body;
      body = JSON.parse(raw);
    } catch {
      body = event.body;
    }
  }

  const origin = headers['origin'] || null;

  // Split pathname into segments, stripping leading slashes and the function prefix
  // API Gateway routes: /providers/123/service-zone → ['providers', '123', 'service-zone']
  const pathSegments = pathname.split('/').filter(Boolean);

  return { method, pathname, searchParams, headers, body, origin, pathSegments, rawEvent: event };
}

// ─── Response Helpers ───────────────────────────────────────────────────────

/**
 * Return a JSON response with CORS headers.
 */
export function jsonResponse(data: unknown, status = 200, origin?: string | null): LambdaResponse {
  return {
    statusCode: status,
    headers: {
      ...getCorsHeaders(origin),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

/**
 * Return an error JSON response with CORS headers.
 */
export function errorResponse(message: string, status = 500, origin?: string | null): LambdaResponse {
  return jsonResponse(
    {
      error: message,
      success: false,
      timestamp: new Date().toISOString(),
    },
    status,
    origin
  );
}

/**
 * Return a 204 No Content preflight response.
 */
export function corsPreflightResponse(origin?: string | null): LambdaResponse {
  return {
    statusCode: 204,
    headers: getCorsHeaders(origin),
    body: '',
  };
}

// ─── Handler Wrapper ────────────────────────────────────────────────────────

type HandlerFn = (req: ParsedRequest) => Promise<LambdaResponse>;

/**
 * Wraps a handler function with CORS preflight handling and error catching.
 * This is the main entry point pattern for each Lambda function:
 *
 * ```ts
 * import { createHandler, parseRequest, jsonResponse, errorResponse } from '../_shared/adapter.js';
 *
 * export const handler = createHandler(async (req) => {
 *   if (req.method === 'GET') return jsonResponse({ status: 'ok' });
 *   return errorResponse('Method not allowed', 405, req.origin);
 * });
 * ```
 */
export function createHandler(fn: HandlerFn) {
  return async (event: APIGatewayProxyEventV2): Promise<LambdaResponse> => {
    const req = parseRequest(event);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return corsPreflightResponse(req.origin);
    }

    try {
      return await fn(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Unhandled error:', message, err);
      return errorResponse(`Internal server error: ${message}`, 500, req.origin);
    }
  };
}
