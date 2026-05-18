/**
 * Providers Edge Function
 *
 * Handles provider-related API endpoints:
 * - GET /providers - List all providers
 * - POST /providers/filter - Filter providers by location and criteria
 * - GET /providers/search?q=query - Search providers by name
 * - GET /providers/map - Get GeoJSON for map display
 * - GET /providers/geocode?address=... - Geocode an address
 * - GET /providers/:id - Get single provider by provider_id
 * - GET /providers/:id/service-zone - Get provider service zone
 *
 * Uses optimat.providers table in Supabase.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  errorResponse,
  handleCorsPreflightRequest,
  jsonResponse,
} from "../_shared/cors.ts";
import {
  createOptimatClient,
  normalizeProvider,
  TABLES,
} from "../_shared/supabase.ts";

// Types for provider operations

interface ProviderFilter {
  source_address: string;
  destination_address: string;
  provider_type?: string;
  routing_type?: string;
  schedule_type?: string;
  planning_type?: string;
  eligibility_req_contains?: string;
  eligibility_type?: string;
  provider_org?: string;
  provider_name__contains?: string;
  is_operating?: boolean;
  has_service_zone?: boolean;
  booking_method?: string;
  fare_type?: string;
}

interface GeoCoordinate {
  lat: number;
  lon: number;
}

interface GeocodeResult {
  success: boolean;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  message?: string;
}

// Google Places API configuration
const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_FIELD_MASK = "places.location,places.displayName,places.formattedAddress";

// Provider select query fields
const PROVIDER_SELECT_FIELDS = `
  id,
  provider_id,
  provider_name,
  provider_type,
  routing_type,
  schedule_type,
  planning_type,
  eligibility_reqs,
  booking,
  fare,
  service_hours,
  service_zone,
  service_area_cities,
  service_area_source,
  service_area_notes,
  provider_software,
  website,
  provider_org,
  round_trip_booking,
  investigated,
  created_at,
  updated_at
`;

/**
 * Parse the URL path to extract route segments and parameters.
 */
function parseRoute(pathname: string): { segments: string[]; id?: string } {
  // Remove /providers prefix and leading/trailing slashes
  const cleanPath = pathname.replace(/^\/providers\/?/, "").replace(/\/$/, "");
  const segments = cleanPath.split("/").filter(Boolean);

  // Check if the last segment is a numeric ID
  const lastSegment = segments[segments.length - 1];
  if (lastSegment && /^\d+$/.test(lastSegment)) {
    return {
      segments: segments.slice(0, -1),
      id: lastSegment,
    };
  }

  return { segments };
}

/**
 * List all providers from the database.
 */
async function listProviders(origin?: string | null): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select(PROVIDER_SELECT_FIELDS)
      .order("provider_name");

    if (error) {
      console.error("Error fetching providers:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    const normalizedData = (data || []).map((provider) =>
      normalizeProvider(provider as Record<string, unknown>)
    );

    return jsonResponse({ data: normalizedData }, 200, origin);
  } catch (err) {
    console.error("Unexpected error in listProviders:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Get a single provider by provider_id.
 */
async function getProviderById(
  providerId: string,
  origin?: string | null
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select(PROVIDER_SELECT_FIELDS)
      .eq("provider_id", parseInt(providerId, 10))
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return errorResponse(`Provider with id ${providerId} not found`, 404, origin);
      }
      console.error("Error fetching provider:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    if (!data) {
      return errorResponse(`Provider with id ${providerId} not found`, 404, origin);
    }

    const normalizedData = normalizeProvider(data as Record<string, unknown>);
    return jsonResponse(normalizedData, 200, origin);
  } catch (err) {
    console.error("Unexpected error in getProviderById:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Search providers by text query.
 */
async function searchProviders(
  query: string,
  origin?: string | null
): Promise<Response> {
  try {
    if (!query || query.length < 2) {
      return errorResponse("Search query must be at least 2 characters", 400, origin);
    }

    const supabase = createOptimatClient();

    // Use RPC function if available, otherwise fall back to direct query
    const { data, error } = await supabase.rpc("search_providers", {
      search_query: query,
    });

    if (error) {
      // Fall back to direct query if RPC doesn't exist
      if (error.code === "42883") {
        // Function does not exist
        const searchPattern = `%${query}%`;
        const { data: fallbackData, error: fallbackError } = await supabase
          .from(TABLES.PROVIDERS)
          .select(PROVIDER_SELECT_FIELDS)
          .or(
            `provider_name.ilike.${searchPattern},provider_org.ilike.${searchPattern},provider_type.ilike.${searchPattern}`
          )
          .order("provider_name")
          .limit(25);

        if (fallbackError) {
          console.error("Error searching providers:", fallbackError);
          return errorResponse(`Database error: ${fallbackError.message}`, 500, origin);
        }

        const normalizedData = (fallbackData || []).map((provider) =>
          normalizeProvider(provider as Record<string, unknown>)
        );
        return jsonResponse(normalizedData, 200, origin);
      }

      console.error("Error searching providers:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    const normalizedData = (data || []).map((provider: Record<string, unknown>) =>
      normalizeProvider(provider)
    );
    return jsonResponse(normalizedData, 200, origin);
  } catch (err) {
    console.error("Unexpected error in searchProviders:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Get providers as GeoJSON for map display.
 */
async function getProvidersMap(origin?: string | null): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    // First try the RPC function
    const { data, error } = await supabase.rpc("get_providers_geojson");

    if (error) {
      // Fall back to building GeoJSON manually if RPC doesn't exist
      if (error.code === "42883") {
        const { data: providers, error: fetchError } = await supabase
          .from(TABLES.PROVIDERS)
          .select("provider_id, provider_name, provider_type, provider_org, service_zone")
          .not("service_zone", "is", null);

        if (fetchError) {
          console.error("Error fetching providers for map:", fetchError);
          return errorResponse(`Database error: ${fetchError.message}`, 500, origin);
        }

        // Build GeoJSON FeatureCollection from provider centroids
        const features = (providers || [])
          .map((provider) => {
            // Try to extract centroid from service_zone
            const serviceZone = provider.service_zone;
            if (!serviceZone) return null;

            // If service_zone has features, try to get centroid
            let centroid: [number, number] | null = null;
            if (serviceZone.features && Array.isArray(serviceZone.features)) {
              const firstFeature = serviceZone.features[0];
              if (firstFeature?.geometry?.coordinates) {
                // For polygons, calculate rough centroid
                const coords = firstFeature.geometry.coordinates;
                if (firstFeature.geometry.type === "Polygon" && coords[0]) {
                  const ring = coords[0] as [number, number][];
                  const sumLon = ring.reduce((acc, c) => acc + c[0], 0);
                  const sumLat = ring.reduce((acc, c) => acc + c[1], 0);
                  centroid = [sumLon / ring.length, sumLat / ring.length];
                } else if (firstFeature.geometry.type === "Point") {
                  centroid = coords as [number, number];
                }
              }
            }

            if (!centroid) return null;

            return {
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: centroid,
              },
              properties: {
                provider_id: provider.provider_id,
                provider_name: provider.provider_name,
                provider_type: provider.provider_type,
                provider_org: provider.provider_org,
              },
            };
          })
          .filter(Boolean);

        return jsonResponse(
          { type: "FeatureCollection", features },
          200,
          origin
        );
      }

      console.error("Error getting providers map:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    return jsonResponse(data || { type: "FeatureCollection", features: [] }, 200, origin);
  } catch (err) {
    console.error("Unexpected error in getProvidersMap:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Geocode an address using Google Places API (Text Search).
 * Falls back to Supabase RPC if API key is not configured.
 */
async function geocodeAddress(address: string): Promise<GeocodeResult> {
  if (!address.trim()) {
    return {
      success: false,
      message: "Address is required",
    };
  }

  // Try Google Places API first
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (apiKey) {
    try {
      const headers = {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
        "Content-Type": "application/json",
      };

      const payload = {
        textQuery: address,
        locationBias: {
          rectangle: {
            low: { latitude: 24.396308, longitude: -125.0 },
            high: { latitude: 49.384358, longitude: -66.93457 },
          },
        },
      };

      const response = await fetch(PLACES_SEARCH_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        const places = data.places || [];

        if (places.length > 0) {
          const place = places[0];
          const location = place.location;

          if (location?.latitude !== undefined && location?.longitude !== undefined) {
            return {
              success: true,
              coordinates: {
                latitude: location.latitude,
                longitude: location.longitude,
              },
            };
          }
        }

        return {
          success: false,
          message: `No results found for address: ${address}`,
        };
      } else {
        console.warn(`Google Places API error ${response.status}`);
      }
    } catch (err) {
      console.error("Google Places API error:", err);
    }
  }

  // Fall back to Supabase RPC if Google API fails or is not configured
  try {
    const supabase = createOptimatClient();
    const { data, error } = await supabase.rpc("geocode_address", {
      address_text: address,
    });

    if (!error && data?.latitude && data?.longitude) {
      return {
        success: true,
        coordinates: {
          latitude: data.latitude,
          longitude: data.longitude,
        },
      };
    }
  } catch (err) {
    console.error("Geocoding RPC error:", err);
  }

  return {
    success: false,
    message: "Geocoding failed",
  };
}

/**
 * Get provider service zone metadata.
 */
async function getProviderServiceZone(
  providerId: string,
  origin?: string | null
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select("provider_id, service_zone")
      .eq("provider_id", parseInt(providerId, 10))
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return jsonResponse(
          {
            provider_id: providerId,
            has_service_zone: false,
            raw_data: null,
          },
          200,
          origin
        );
      }
      console.error("Error fetching provider service zone:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    if (!data) {
      return jsonResponse(
        {
          provider_id: providerId,
          has_service_zone: false,
          raw_data: null,
        },
        200,
        origin
      );
    }

    // Parse service_zone if it's a string
    let serviceZone = data.service_zone;
    if (typeof serviceZone === "string") {
      try {
        serviceZone = JSON.parse(serviceZone);
      } catch {
        console.warn(`Failed to parse service_zone JSON for provider ${providerId}`);
      }
    }

    return jsonResponse(
      {
        provider_id: data.provider_id,
        has_service_zone: serviceZone !== null && serviceZone !== undefined,
        service_zone: serviceZone,
        raw_data: serviceZone,
      },
      200,
      origin
    );
  } catch (err) {
    console.error("Unexpected error in getProviderServiceZone:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Handle geocode endpoint request.
 */
async function handleGeocodeRequest(
  address: string,
  origin?: string | null
): Promise<Response> {
  if (!address || address.trim().length === 0) {
    return errorResponse("Address parameter is required", 400, origin);
  }

  const result = await geocodeAddress(address);

  if (result.success) {
    return jsonResponse(
      {
        success: true,
        coordinates: result.coordinates,
      },
      200,
      origin
    );
  }

  return jsonResponse(
    {
      success: false,
      message: result.message,
    },
    200,
    origin
  );
}

/**
 * Filter providers by location and criteria.
 */
async function filterProviders(
  filter: ProviderFilter,
  origin?: string | null
): Promise<Response> {
  try {
    // Validate required fields
    if (!filter.source_address || !filter.destination_address) {
      return errorResponse(
        "source_address and destination_address are required",
        400,
        origin
      );
    }

    const supabase = createOptimatClient();

    // Geocode addresses first
    const originGeo = await geocodeAddress(filter.source_address);
    const destGeo = await geocodeAddress(filter.destination_address);

    if (!originGeo.success || !destGeo.success) {
      return jsonResponse(
        {
          data: [],
          source_address: filter.source_address,
          destination_address: filter.destination_address,
          origin: null,
          destination: null,
          public_transit: null,
          message: "Failed to geocode one or both addresses",
        },
        200,
        origin
      );
    }

    const originCoord: GeoCoordinate = {
      lat: originGeo.coordinates!.latitude,
      lon: originGeo.coordinates!.longitude,
    };
    const destCoord: GeoCoordinate = {
      lat: destGeo.coordinates!.latitude,
      lon: destGeo.coordinates!.longitude,
    };

    // Try to use the filter_providers_with_coords RPC function
    const { data, error } = await supabase.rpc("filter_providers_with_coords", {
      p_origin_lat: originCoord.lat,
      p_origin_lon: originCoord.lon,
      p_dest_lat: destCoord.lat,
      p_dest_lon: destCoord.lon,
      p_provider_type: filter.provider_type || null,
      p_routing_type: filter.routing_type || null,
      p_schedule_type: filter.schedule_type || null,
      p_planning_type: filter.planning_type || null,
      p_eligibility_req_contains: filter.eligibility_req_contains || null,
      p_eligibility_type: filter.eligibility_type || null,
      p_provider_org: filter.provider_org || null,
      p_provider_name_contains: filter.provider_name__contains || null,
      p_has_service_zone: filter.has_service_zone ?? null,
      p_booking_method: filter.booking_method || null,
      p_fare_type: filter.fare_type || null,
    });

    if (error) {
      // If RPC doesn't exist, fall back to basic filtering without spatial checks
      if (error.code === "42883") {
        console.warn("filter_providers_with_coords RPC not available, using fallback without spatial filtering");

        // Build filter query (without spatial containment checks)
        let query = supabase.from(TABLES.PROVIDERS).select(PROVIDER_SELECT_FIELDS);

        if (filter.provider_type) {
          query = query.eq("provider_type", filter.provider_type);
        }
        if (filter.routing_type) {
          query = query.eq("routing_type", filter.routing_type);
        }
        if (filter.planning_type) {
          query = query.eq("planning_type", filter.planning_type);
        }
        if (filter.provider_org) {
          query = query.eq("provider_org", filter.provider_org);
        }
        if (filter.provider_name__contains) {
          query = query.ilike("provider_name", `%${filter.provider_name__contains}%`);
        }
        if (filter.has_service_zone === true) {
          query = query.not("service_zone", "is", null);
        } else if (filter.has_service_zone === false) {
          query = query.is("service_zone", null);
        }

        const { data: providers, error: queryError } = await query
          .order("provider_name")
          .limit(200);

        if (queryError) {
          console.error("Error filtering providers:", queryError);
          return errorResponse(`Database error: ${queryError.message}`, 500, origin);
        }

        const normalizedData = (providers || []).map((provider) =>
          normalizeProvider(provider as Record<string, unknown>)
        );

        return jsonResponse(
          {
            data: normalizedData,
            source_address: filter.source_address,
            destination_address: filter.destination_address,
            origin: originCoord,
            destination: destCoord,
            public_transit: null,
            message: "Spatial filtering unavailable - showing all providers matching criteria",
          },
          200,
          origin
        );
      }

      console.error("Error filtering providers:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    // RPC succeeded - normalize and return data
    const normalizedProviders = (data?.providers || []).map(
      (provider: Record<string, unknown>) => normalizeProvider(provider)
    );

    return jsonResponse(
      {
        data: normalizedProviders,
        source_address: filter.source_address,
        destination_address: filter.destination_address,
        origin: originCoord,
        destination: destCoord,
        public_transit: null,
      },
      200,
      origin
    );
  } catch (err) {
    console.error("Unexpected error in filterProviders:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Main request handler.
 */
serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  try {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // Parse route
    const { segments, id } = parseRoute(pathname);

    console.log(`[Providers] ${method} ${pathname} - segments:`, segments, "id:", id);

    // Route handling
    // GET /providers - List all providers
    if (method === "GET" && segments.length === 0 && !id) {
      return await listProviders(origin);
    }

    // GET /providers/search?q=query - Search providers
    if (method === "GET" && segments[0] === "search") {
      const query = url.searchParams.get("q");
      if (!query) {
        return errorResponse("Query parameter 'q' is required", 400, origin);
      }
      return await searchProviders(query, origin);
    }

    // GET /providers/map - Get GeoJSON for map
    if (method === "GET" && segments[0] === "map") {
      return await getProvidersMap(origin);
    }

    // GET /providers/geocode?address=... - Geocode an address
    if (method === "GET" && segments[0] === "geocode") {
      const address = url.searchParams.get("address");
      if (!address) {
        return errorResponse("Query parameter 'address' is required", 400, origin);
      }
      return await handleGeocodeRequest(address, origin);
    }

    // POST /providers/filter - Filter providers by location
    if (method === "POST" && segments[0] === "filter") {
      try {
        const body = await req.json();
        return await filterProviders(body as ProviderFilter, origin);
      } catch (err) {
        return errorResponse("Invalid JSON body", 400, origin);
      }
    }

    // GET /providers/:id/service-zone - Get provider service zone
    if (
      method === "GET" &&
      segments.length === 2 &&
      /^\d+$/.test(segments[0]) &&
      segments[1] === "service-zone"
    ) {
      return await getProviderServiceZone(segments[0], origin);
    }

    // GET /providers/:id - Get single provider
    if (method === "GET" && id && segments.length === 0) {
      return await getProviderById(id, origin);
    }

    // PUT /providers/:id - Provider updates are restricted to backend import/admin workflows.
    if (method === "PUT" && id && segments.length === 0) {
      return errorResponse("Provider updates are disabled on the public API", 405, origin);
    }

    // Route not found
    return errorResponse(`Not found: ${method} ${pathname}`, 404, origin);
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500, origin);
  }
});
