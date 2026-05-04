/**
 * Backend Client Configuration for OPTIMAT-FRONT
 *
 * This module provides:
 * - Backend-agnostic API client (Supabase Edge Functions or AWS API Gateway)
 * - Helper functions for calling backend endpoints
 * - Streaming support for chat functionality
 *
 * Set VITE_API_BACKEND to 'aws' to use AWS API Gateway instead of Supabase.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── Backend Selection ──────────────────────────────────────────────────────

type BackendType = 'supabase' | 'aws';

const API_BACKEND: BackendType =
  (import.meta.env.VITE_API_BACKEND as BackendType) || 'supabase';

// Supabase configuration
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// AWS configuration
const AWS_API_URL = import.meta.env.VITE_AWS_API_URL || '';
const AWS_API_KEY = import.meta.env.VITE_AWS_API_KEY || '';

// Validate configuration based on active backend
if (API_BACKEND === 'supabase' && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.warn(
    'Supabase environment variables not configured. ' +
    'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable Supabase integration.'
  );
}
if (API_BACKEND === 'aws' && !AWS_API_URL) {
  console.warn(
    'AWS API Gateway URL not configured. ' +
    'Set VITE_AWS_API_URL to enable AWS backend.'
  );
}

/**
 * Get the base URL for API calls (without trailing slash).
 */
function getBaseUrl(): string {
  if (API_BACKEND === 'aws') {
    return AWS_API_URL.replace(/\/$/, '');
  }
  return `${SUPABASE_URL}/functions/v1`;
}

/**
 * Supabase client singleton
 * Only created when using Supabase backend
 */
export const supabase: SupabaseClient | null =
  API_BACKEND === 'supabase' && SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,
        },
      })
    : null;

/**
 * Check if the backend is configured and available
 */
export function isSupabaseConfigured(): boolean {
  if (API_BACKEND === 'aws') {
    return !!AWS_API_URL;
  }
  return supabase !== null;
}

/**
 * Edge Function response type
 */
export interface EdgeFunctionResponse<T = unknown> {
  data: T | null;
  error: Error | null;
}

/**
 * Call a Supabase Edge Function with JSON body (legacy action-based routing)
 *
 * @param functionName - Name of the Edge Function (e.g., 'providers', 'chat', 'geocode')
 * @param body - Request body to send
 * @param options - Additional fetch options
 * @returns Response data or error
 * @deprecated Use fetchEdgeFunction for REST-style routing
 */
export async function invokeEdgeFunction<T = unknown>(
  functionName: string,
  body: Record<string, unknown> = {},
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; headers?: Record<string, string> } = {}
): Promise<EdgeFunctionResponse<T>> {
  if (!isSupabaseConfigured()) {
    return {
      data: null,
      error: new Error('Backend is not configured. Set VITE_API_BACKEND and the corresponding URL/key variables.'),
    };
  }

  // For AWS backend, delegate to fetchEdgeFunction
  if (API_BACKEND === 'aws') {
    return fetchEdgeFunction<T>(functionName, { method: options.method || 'POST', body });
  }

  try {
    const { data, error } = await supabase!.functions.invoke<T>(functionName, {
      body,
      headers: options.headers,
    });

    if (error) {
      return { data: null, error };
    }

    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Call a Supabase Edge Function with REST-style routing
 * Supports GET, POST, PUT, DELETE with proper path handling
 *
 * @param path - Full path including function name and sub-route (e.g., 'providers/filter')
 * @param options - Request options
 * @returns Response data or error
 */
export async function fetchEdgeFunction<T = unknown>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: object;
    params?: Record<string, string>;
  } = {}
): Promise<EdgeFunctionResponse<T>> {
  if (!isSupabaseConfigured()) {
    return {
      data: null,
      error: new Error('Backend is not configured. Set VITE_API_BACKEND and the corresponding URL/key variables.'),
    };
  }

  try {
    let url = `${getBaseUrl()}/${path}`;

    // Add query parameters for GET requests
    if (options.params && Object.keys(options.params).length > 0) {
      const searchParams = new URLSearchParams(options.params);
      url += `?${searchParams.toString()}`;
    }

    const fetchOptions: RequestInit = {
      method: options.method || 'GET',
      headers: getAuthHeaders(),
    };

    // Add body for POST/PUT requests
    if (options.body && (options.method === 'POST' || options.method === 'PUT')) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorText;
      } catch {
        errorMessage = errorText || `HTTP ${response.status}`;
      }
      return {
        data: null,
        error: new Error(errorMessage),
      };
    }

    // Handle empty responses
    const text = await response.text();
    if (!text.trim()) {
      return { data: null, error: null };
    }

    const data = JSON.parse(text) as T;
    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Get the full URL for a backend endpoint.
 * Used for streaming endpoints that cannot use the SDK.
 *
 * @param functionName - Name of the endpoint (e.g., 'chat', 'providers')
 * @returns Full URL to the endpoint
 */
export function getEdgeFunctionUrl(functionName: string): string {
  const base = getBaseUrl();
  if (!base) {
    throw new Error('Backend URL is not configured');
  }
  return `${base}/${functionName}`;
}

/**
 * Get authorization headers for backend API calls.
 * Returns appropriate headers based on the active backend.
 */
export function getAuthHeaders(): Record<string, string> {
  if (API_BACKEND === 'aws') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (AWS_API_KEY) {
      headers['x-api-key'] = AWS_API_KEY;
    }
    return headers;
  }

  return {
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Stream response from an Edge Function (for SSE)
 * Used for chat streaming functionality
 *
 * @param functionName - Name of the Edge Function
 * @param body - Request body
 * @returns Fetch Response for streaming
 */
export async function streamEdgeFunction(
  functionName: string,
  body: Record<string, unknown>
): Promise<Response> {
  const url = getEdgeFunctionUrl(functionName);
  const headers = getAuthHeaders();

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Edge function error: ${response.status} ${response.statusText}`);
  }

  return response;
}

/**
 * Health check for Supabase Edge Functions
 *
 * @param functionName - Optional function to check, defaults to general health
 * @returns True if the function is reachable
 */
export async function checkEdgeFunctionHealth(functionName: string = 'health'): Promise<boolean> {
  try {
    const response = await invokeEdgeFunction(functionName, {});
    return response.error === null;
  } catch {
    return false;
  }
}

// Re-export types that might be useful
export type { SupabaseClient } from '@supabase/supabase-js';
