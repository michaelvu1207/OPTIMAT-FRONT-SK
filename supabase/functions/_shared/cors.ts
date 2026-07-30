/**
 * CORS headers utility for Supabase Edge Functions.
 * Provides standardized CORS handling for API responses.
 */

// Allowed origins for CORS - configure based on your deployment
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://optimat.example.com", // Replace with your production domain
];

/**
 * Standard CORS headers for all responses.
 * These headers enable cross-origin requests from allowed origins.
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // In production, restrict this to specific origins
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-requested-with, x-optimat-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Max-Age": "86400", // Cache preflight for 24 hours
};

/**
 * Get CORS headers with dynamic origin handling.
 * @param origin - The request origin header
 * @returns CORS headers with appropriate origin
 */
export function getCorsHeaders(origin?: string | null): Record<string, string> {
  // If origin is in allowed list, reflect it back
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      ...corsHeaders,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    };
  }

  // Default to wildcard for development or non-browser requests
  return corsHeaders;
}

/**
 * Handle OPTIONS preflight request.
 * @param origin - The request origin header
 * @returns Response for preflight request
 */
export function handleCorsPreflightRequest(origin?: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

/**
 * Create a JSON response with CORS headers.
 * @param data - The response body data
 * @param status - HTTP status code (default: 200)
 * @param origin - The request origin header for CORS
 * @returns Response with JSON body and CORS headers
 */
export function jsonResponse(
  data: unknown,
  status = 200,
  origin?: string | null,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...getCorsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

/**
 * Create an error response with CORS headers.
 * @param message - Error message
 * @param status - HTTP status code (default: 500)
 * @param origin - The request origin header for CORS
 * @returns Response with error JSON and CORS headers
 */
export function errorResponse(
  message: string,
  status = 500,
  origin?: string | null,
): Response {
  return jsonResponse(
    {
      error: message,
      success: false,
      timestamp: new Date().toISOString(),
    },
    status,
    origin,
  );
}
