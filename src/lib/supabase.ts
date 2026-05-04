/**
 * Supabase Client Configuration for OPTIMAT-FRONT
 *
 * This module provides:
 * - Supabase client initialization with environment variables
 * - Helper functions for calling Edge Functions
 * - Streaming support for chat functionality
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Environment variables with defaults for development
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Validate required environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    'Supabase environment variables not configured. ' +
    'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable Supabase integration.'
  );
}

/**
 * Supabase client singleton
 * Only created if environment variables are configured
 */
export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false, // No auth needed for public API
        },
      })
    : null;

/**
 * Check if Supabase is configured and available
 */
export function isSupabaseConfigured(): boolean {
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
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<EdgeFunctionResponse<T>> {
  if (!supabase) {
    return {
      data: null,
      error: new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'),
    };
  }

  try {
    const { data, error } = await supabase.functions.invoke<T>(functionName, {
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
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      data: null,
      error: new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'),
    };
  }

  try {
    let url = `${SUPABASE_URL}/functions/v1/${path}`;

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
 * Get the Edge Function URL for streaming endpoints
 * This is needed for SSE connections that cannot use the SDK
 *
 * @param functionName - Name of the Edge Function
 * @returns Full URL to the Edge Function
 */
export function getEdgeFunctionUrl(functionName: string): string {
  if (!SUPABASE_URL) {
    throw new Error('VITE_SUPABASE_URL is not configured');
  }

  // Supabase Edge Functions URL pattern
  // https://<project-ref>.supabase.co/functions/v1/<function-name>
  return `${SUPABASE_URL}/functions/v1/${functionName}`;
}

/**
 * Get authorization headers for Edge Function calls
 * Required for authenticated requests or when using custom fetch
 */
export function getAuthHeaders(): Record<string, string> {
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
