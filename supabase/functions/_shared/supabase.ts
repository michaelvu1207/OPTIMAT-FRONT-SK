/**
 * Supabase client helper for Edge Functions.
 * Provides standardized client initialization and utilities.
 *
 * IMPORTANT: All OPTIMAT tables are in the 'optimat' schema.
 * Use the helper functions to query with proper schema prefix.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Schema configuration
export const OPTIMAT_SCHEMA = "optimat";

// Table names (without schema prefix - use with schemaTable helper)
export const TABLES = {
  PROVIDERS: "providers",
  CONVERSATIONS: "conversations",
  MESSAGES: "messages",
  CHAT_EXAMPLES: "chat_examples",
  FIND_PROVIDERS_CALLS: "find_providers_calls",
  SEARCH_ADDRESSES_CALLS: "search_addresses_calls",
  GET_PROVIDER_INFO_CALLS: "get_provider_info_calls",
  GENERAL_QUESTION_CALLS: "general_question_calls",
  CONVERSATION_STATES: "conversation_states",
  TOOL_CALLS: "tool_calls",
  CHAT_TRIP_STATE: "chat_trip_state",
  CHAT_FEEDBACK: "chat_feedback",
} as const;

// Environment variables for Supabase connection
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/**
 * Create a Supabase client with the anonymous key.
 * Use this for client-facing operations where RLS should apply.
 * @returns SupabaseClient instance
 */
export function createAnonClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Create a Supabase client with the service role key.
 * Use this for administrative operations that bypass RLS.
 * IMPORTANT: Only use when necessary for admin operations.
 * @returns SupabaseClient instance with service role privileges
 */
export function createServiceClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing Supabase service role environment variables");
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Create a Supabase client from request authorization header.
 * This allows operations to run under the context of the requesting user.
 * @param request - The incoming request with Authorization header
 * @returns SupabaseClient instance with user context
 */
export function createClientFromRequest(request: Request): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase environment variables");
  }

  const authHeader = request.headers.get("Authorization");

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });

  return client;
}

/**
 * Extract and validate JWT from request.
 * @param request - The incoming request
 * @returns The JWT token or null if not present
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7);
}

/**
 * Verify that the request has a valid authentication token.
 * @param request - The incoming request
 * @returns User object if authenticated, null otherwise
 */
export async function getAuthenticatedUser(request: Request) {
  const client = createClientFromRequest(request);
  const token = extractToken(request);

  if (!token) {
    return null;
  }

  const { data: { user }, error } = await client.auth.getUser(token);

  if (error || !user) {
    return null;
  }

  return user;
}

/**
 * Get the Supabase URL for use in edge functions.
 * @returns The Supabase project URL
 */
export function getSupabaseUrl(): string {
  return SUPABASE_URL;
}

/**
 * Create a Supabase client configured to use the optimat schema.
 * This is the preferred method for OPTIMAT operations.
 * @returns SupabaseClient instance configured for optimat schema
 */
export function createOptimatClient(): SupabaseClient<any, any, any> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing Supabase service role environment variables");
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: OPTIMAT_SCHEMA,
    },
  });
}

/**
 * Normalize provider data from database format to API format.
 * Converts JSONB fields to strings for frontend consumption.
 * @param record - The database record
 * @returns Normalized provider object
 */
export function normalizeProvider(record: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...record };

  // Ensure provider_id is a string
  if (normalized.provider_id !== undefined) {
    normalized.provider_id = String(normalized.provider_id);
  }

  // Public provider responses must not expose operational contacts.
  delete normalized.contacts;

  // Parse GeoJSON JSONB fields if they arrive as strings.
  for (const field of ["service_zone", "service_area_geojson"]) {
    if (typeof normalized[field] === "string") {
      try {
        normalized[field] = JSON.parse(normalized[field] as string);
      } catch {
        console.warn(`Failed to parse ${field} JSON for provider ${normalized.provider_id}`);
      }
    }
  }

  // Convert JSONB fields to JSON strings for frontend display
  const jsonbFields = ["eligibility_reqs", "booking", "fare", "schedule_type", "service_hours"];
  for (const field of jsonbFields) {
    const value = normalized[field];
    if (value !== null && value !== undefined && typeof value === "object") {
      normalized[field] = JSON.stringify(value);
    }
  }

  // Calculate has_service_zone
  normalized.has_service_zone = normalized.service_zone !== null && normalized.service_zone !== undefined;

  return normalized;
}

/**
 * Sanitize a database record for API response.
 * Converts UUIDs and dates to strings.
 * @param record - The database record
 * @returns Sanitized record
 */
export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...record };

  // Convert id to string
  if (sanitized.id !== undefined) {
    sanitized.id = String(sanitized.id);
  }

  // Convert conversation_id to string
  if (sanitized.conversation_id !== undefined) {
    sanitized.conversation_id = String(sanitized.conversation_id);
  }

  // Convert example_id to string
  if (sanitized.example_id !== undefined) {
    sanitized.example_id = String(sanitized.example_id);
  }

  return sanitized;
}
