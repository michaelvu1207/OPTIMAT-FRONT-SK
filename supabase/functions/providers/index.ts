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
import { requireMigrationAdmin } from "../_shared/admin.ts";
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

interface ProviderRecord {
  provider_type?: string | null;
  routing_type?: string | null;
  schedule_type?: unknown;
  planning_type?: string | null;
  eligibility_reqs?: unknown;
  booking?: unknown;
  fare?: unknown;
  service_zone?: unknown;
  provider_org?: string | null;
  provider_name?: string | null;
  is_operating?: boolean | null;
}

function isPubliclyAvailableProvider(provider: Record<string, unknown>): boolean {
  const properties = provider.properties && typeof provider.properties === "object"
    ? provider.properties as Record<string, unknown>
    : provider;
  const normalizedName = String(properties.provider_name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return properties.is_operating !== false &&
    normalizedName !== "oneseatregionalride" &&
    normalizedName !== "oneseatride";
}

function isFixedRouteType(type: unknown): boolean {
  return String(type || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "fixedroute";
}

/** The current Tri Delta polygon is not an approved representation of its route network. */
function hasVerifiedPublicServiceArea(provider: Record<string, unknown>): boolean {
  const properties = provider.properties && typeof provider.properties === "object"
    ? provider.properties as Record<string, unknown>
    : provider;
  const name = String(properties.provider_name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return !(name === "trideltatransit" && isFixedRouteType(properties.provider_type));
}

const PROVIDER_UPDATE_FIELDS = [
  "provider_name",
  "provider_type",
  "routing_type",
  "schedule_type",
  "planning_type",
  "eligibility_reqs",
  "booking",
  "fare",
  "service_hours",
  "service_zone",
  "service_area_cities",
  "service_area_source",
  "service_area_notes",
  "provider_software",
  "website",
  "provider_org",
  "round_trip_booking",
  "investigated",
  "is_operating",
] as const;

type ProviderUpdateField = typeof PROVIDER_UPDATE_FIELDS[number];

// Google Places API configuration
const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_FIELD_MASK =
  "places.location,places.displayName,places.formattedAddress";

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
  is_operating,
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

    const normalizedData = (data || [])
      .filter((provider) => isPubliclyAvailableProvider(provider as Record<string, unknown>))
      .map((provider) => normalizeProvider(provider as Record<string, unknown>));

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
  origin?: string | null,
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
        return errorResponse(
          `Provider with id ${providerId} not found`,
          404,
          origin,
        );
      }
      console.error("Error fetching provider:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    if (!data || !isPubliclyAvailableProvider(data as Record<string, unknown>)) {
      return errorResponse(
        `Provider with id ${providerId} not found`,
        404,
        origin,
      );
    }

    const normalizedData = normalizeProvider(data as Record<string, unknown>);
    return jsonResponse(normalizedData, 200, origin);
  } catch (err) {
    console.error("Unexpected error in getProviderById:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

function normalizeTextUpdate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeBooleanUpdate(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "no") return false;
  }
  return Boolean(value);
}

function normalizeJsonUpdate(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function normalizeCitiesUpdate(value: unknown): string[] | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    const cities = value
      .map((city) => String(city ?? "").trim())
      .filter(Boolean);
    return cities.length ? cities : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeCitiesUpdate(parsed);
    } catch {
      // Fall through to comma/newline parsing.
    }
    const cities = trimmed
      .split(/[,\n]/)
      .map((city) => city.trim())
      .filter(Boolean);
    return cities.length ? cities : null;
  }
  return null;
}

function buildProviderUpdate(
  body: Record<string, unknown>,
): Record<ProviderUpdateField, unknown> {
  const update: Partial<Record<ProviderUpdateField, unknown>> = {};

  for (const field of PROVIDER_UPDATE_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];

    if (
      field === "schedule_type" ||
      field === "eligibility_reqs" ||
      field === "booking" ||
      field === "fare" ||
      field === "service_hours" ||
      field === "service_zone"
    ) {
      update[field] = normalizeJsonUpdate(value);
      continue;
    }

    if (field === "service_area_cities") {
      update[field] = normalizeCitiesUpdate(value);
      continue;
    }

    if (field === "round_trip_booking" || field === "investigated") {
      update[field] = normalizeBooleanUpdate(value);
      continue;
    }

    update[field] = normalizeTextUpdate(value);
  }

  return update as Record<ProviderUpdateField, unknown>;
}

/**
 * Update known provider profile fields.
 */
async function updateProviderById(
  providerId: string,
  body: Record<string, unknown>,
  origin?: string | null,
): Promise<Response> {
  try {
    const parsedProviderId = parseInt(providerId, 10);
    if (!Number.isFinite(parsedProviderId)) {
      return errorResponse("Provider id must be numeric", 400, origin);
    }

    const update = buildProviderUpdate(body);
    if (Object.keys(update).length === 0) {
      return errorResponse(
        "No editable provider fields were supplied",
        400,
        origin,
      );
    }

    if ("provider_name" in update && !update.provider_name) {
      return errorResponse("Provider name is required", 400, origin);
    }

    if (isFixedRouteType(update.provider_type)) update.eligibility_reqs = null;

    const supabase = createOptimatClient();
    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .update(update)
      .eq("provider_id", parsedProviderId)
      .select(PROVIDER_SELECT_FIELDS)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return errorResponse(
          `Provider with id ${providerId} not found`,
          404,
          origin,
        );
      }
      console.error("Error updating provider:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    return jsonResponse(
      normalizeProvider(data as Record<string, unknown>),
      200,
      origin,
    );
  } catch (err) {
    console.error("Unexpected error in updateProviderById:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Create or upsert a provider profile by provider_id.
 */
async function createProvider(
  body: Record<string, unknown>,
  origin?: string | null,
): Promise<Response> {
  try {
    const rawProviderId = body.provider_id;
    const parsedProviderId = typeof rawProviderId === "number"
      ? rawProviderId
      : parseInt(String(rawProviderId ?? ""), 10);

    if (!Number.isFinite(parsedProviderId)) {
      return errorResponse("provider_id must be numeric", 400, origin);
    }

    const update = buildProviderUpdate(body);
    if (!update.provider_name) {
      return errorResponse("Provider name is required", 400, origin);
    }

    if (isFixedRouteType(update.provider_type)) update.eligibility_reqs = null;

    const supabase = createOptimatClient();
    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .upsert(
        {
          provider_id: parsedProviderId,
          ...update,
        },
        { onConflict: "provider_id" },
      )
      .select(PROVIDER_SELECT_FIELDS)
      .single();

    if (error) {
      console.error("Error creating provider:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    return jsonResponse(
      normalizeProvider(data as Record<string, unknown>),
      200,
      origin,
    );
  } catch (err) {
    console.error("Unexpected error in createProvider:", err);
    return errorResponse("Internal server error", 500, origin);
  }
}

/**
 * Search providers by text query.
 */
async function searchProviders(
  query: string,
  origin?: string | null,
): Promise<Response> {
  try {
    if (!query || query.length < 2) {
      return errorResponse(
        "Search query must be at least 2 characters",
        400,
        origin,
      );
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
            `provider_name.ilike.${searchPattern},provider_org.ilike.${searchPattern},provider_type.ilike.${searchPattern}`,
          )
          .order("provider_name")
          .limit(25);

        if (fallbackError) {
          console.error("Error searching providers:", fallbackError);
          return errorResponse(
            `Database error: ${fallbackError.message}`,
            500,
            origin,
          );
        }

        const normalizedData = (fallbackData || [])
          .filter((provider) => isPubliclyAvailableProvider(provider as Record<string, unknown>))
          .map((provider) => normalizeProvider(provider as Record<string, unknown>));
        return jsonResponse(normalizedData, 200, origin);
      }

      console.error("Error searching providers:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    const normalizedData = (data || [])
      .filter((provider: Record<string, unknown>) => isPubliclyAvailableProvider(provider))
      .map((provider: Record<string, unknown>) => normalizeProvider(provider));
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
          .select(
            "provider_id, provider_name, provider_type, provider_org, is_operating, service_zone",
          )
          .not("service_zone", "is", null);

        if (fetchError) {
          console.error("Error fetching providers for map:", fetchError);
          return errorResponse(
            `Database error: ${fetchError.message}`,
            500,
            origin,
          );
        }

        // Build GeoJSON FeatureCollection from provider centroids
        const features = (providers || [])
          .filter((provider) =>
            isPubliclyAvailableProvider(provider as Record<string, unknown>) &&
            hasVerifiedPublicServiceArea(provider as Record<string, unknown>)
          )
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
          origin,
        );
      }

      console.error("Error getting providers map:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    const mapData = data && typeof data === "object" && Array.isArray(data.features)
      ? {
        ...data,
        features: data.features.filter((feature: Record<string, unknown>) =>
          isPubliclyAvailableProvider(feature) && hasVerifiedPublicServiceArea(feature)
        ),
      }
      : { type: "FeatureCollection", features: [] };
    return jsonResponse(
      mapData,
      200,
      origin,
    );
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

          if (
            location?.latitude !== undefined &&
            location?.longitude !== undefined
          ) {
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
  origin?: string | null,
): Promise<Response> {
  try {
    const supabase = createOptimatClient();

    const { data, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select("provider_id, provider_name, provider_type, is_operating, service_zone")
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
          origin,
        );
      }
      console.error("Error fetching provider service zone:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    if (
      !data ||
      !isPubliclyAvailableProvider(data as Record<string, unknown>) ||
      !hasVerifiedPublicServiceArea(data as Record<string, unknown>)
    ) {
      return jsonResponse(
        {
          provider_id: providerId,
          has_service_zone: false,
          raw_data: null,
        },
        200,
        origin,
      );
    }

    // Parse service_zone if it's a string
    let serviceZone = data.service_zone;
    if (typeof serviceZone === "string") {
      try {
        serviceZone = JSON.parse(serviceZone);
      } catch {
        console.warn(
          `Failed to parse service_zone JSON for provider ${providerId}`,
        );
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
      origin,
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
  origin?: string | null,
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
      origin,
    );
  }

  return jsonResponse(
    {
      success: false,
      message: result.message,
    },
    200,
    origin,
  );
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function getObjectType(value: unknown): string | null {
  const parsed = parseJsonIfString(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const type = (parsed as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function matchesEligibilityText(
  provider: ProviderRecord,
  needle?: string,
): boolean {
  if (isFixedRouteType(provider.provider_type)) return true;
  if (!needle) return true;
  const haystack = JSON.stringify(
    parseJsonIfString(provider.eligibility_reqs) ?? "",
  ).toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

function matchesProviderFilters(
  provider: ProviderRecord,
  filter: ProviderFilter,
): boolean {
  if (filter.provider_type && provider.provider_type !== filter.provider_type) {
    return false;
  }
  if (filter.routing_type && provider.routing_type !== filter.routing_type) {
    return false;
  }
  if (filter.planning_type && provider.planning_type !== filter.planning_type) {
    return false;
  }
  if (
    filter.schedule_type &&
    getObjectType(provider.schedule_type) !== filter.schedule_type
  ) return false;
  if (
    filter.booking_method &&
    getObjectType(provider.booking) !== filter.booking_method
  ) return false;
  if (filter.fare_type && getObjectType(provider.fare) !== filter.fare_type) {
    return false;
  }
  if (filter.provider_org && provider.provider_org !== filter.provider_org) {
    return false;
  }
  if (
    filter.provider_name__contains &&
    !String(provider.provider_name || "").toLowerCase().includes(
      filter.provider_name__contains.toLowerCase(),
    )
  ) {
    return false;
  }
  if (filter.has_service_zone === true && !provider.service_zone) return false;
  if (filter.has_service_zone === false && provider.service_zone) return false;
  if (!matchesEligibilityText(provider, filter.eligibility_req_contains)) {
    return false;
  }
  return true;
}

function isPointInSinglePolygon(
  lat: number,
  lon: number,
  coordinates: number[][][],
): boolean {
  const ring = coordinates[0];
  if (!Array.isArray(ring)) return false;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    if (
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function isPointInGeometry(
  lat: number,
  lon: number,
  rawGeometry: unknown,
): boolean {
  const geometry = parseJsonIfString(rawGeometry) as {
    type?: string;
    coordinates?: unknown;
    features?: unknown[];
    geometry?: unknown;
  } | null;

  if (!geometry || typeof geometry !== "object") return false;

  if (
    geometry.type === "FeatureCollection" && Array.isArray(geometry.features)
  ) {
    return geometry.features.some((feature) =>
      isPointInGeometry(lat, lon, feature)
    );
  }

  if (geometry.type === "Feature" && geometry.geometry) {
    return isPointInGeometry(lat, lon, geometry.geometry);
  }

  if (geometry.type === "Polygon") {
    return isPointInSinglePolygon(
      lat,
      lon,
      geometry.coordinates as number[][][],
    );
  }

  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return (geometry.coordinates as number[][][][]).some((polygon) =>
      isPointInSinglePolygon(lat, lon, polygon)
    );
  }

  return false;
}

/**
 * Filter providers by location and criteria.
 */
async function filterProviders(
  filter: ProviderFilter,
  origin?: string | null,
): Promise<Response> {
  try {
    // Validate required fields
    if (!filter.source_address || !filter.destination_address) {
      return errorResponse(
        "source_address and destination_address are required",
        400,
        origin,
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
          error: "Failed to geocode one or both addresses",
          details: {
            source: originGeo.success ? null : originGeo.message,
            destination: destGeo.success ? null : destGeo.message,
          },
        },
        502,
        origin,
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

    const { data: providers, error } = await supabase
      .from(TABLES.PROVIDERS)
      .select(PROVIDER_SELECT_FIELDS);

    if (error) {
      console.error("Error fetching providers for filter:", error);
      return errorResponse(`Database error: ${error.message}`, 500, origin);
    }

    const normalizedProviders = (providers || [])
      .filter((provider) =>
        isPubliclyAvailableProvider(provider as Record<string, unknown>) &&
        matchesProviderFilters(provider as ProviderRecord, filter) &&
        isPointInGeometry(
          originCoord.lat,
          originCoord.lon,
          (provider as ProviderRecord).service_zone,
        ) &&
        isPointInGeometry(
          destCoord.lat,
          destCoord.lon,
          (provider as ProviderRecord).service_zone,
        )
      )
      .map((provider) => ({
        ...normalizeProvider(provider as Record<string, unknown>),
        match_criteria: {
          algorithm:
            "Geocode origin and destination, apply explicit structured filters, then keep providers whose service zone contains both points.",
          passed: [
            {
              label: "Origin inside service area",
              detail: filter.source_address,
            },
            {
              label: "Destination inside service area",
              detail: filter.destination_address,
            },
            ...(filter.provider_type
              ? [{
                label: "Provider type matched",
                detail: filter.provider_type,
              }]
              : []),
            ...(filter.schedule_type
              ? [{
                label: "Schedule type matched",
                detail: filter.schedule_type,
              }]
              : []),
            ...(filter.eligibility_req_contains && !isFixedRouteType((provider as ProviderRecord).provider_type)
              ? [{
                label: "Eligibility text matched",
                detail: filter.eligibility_req_contains,
              }]
              : []),
          ],
          not_hard_filtered: isFixedRouteType((provider as ProviderRecord).provider_type) || filter.eligibility_req_contains
            ? []
            : ["eligibility"],
        },
      }));

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
      origin,
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

    console.log(
      `[Providers] ${method} ${pathname} - segments:`,
      segments,
      "id:",
      id,
    );

    // Route handling
    // GET /providers - List all providers
    if (method === "GET" && segments.length === 0 && !id) {
      return await listProviders(origin);
    }

    // POST /providers - Create or upsert provider
    if (method === "POST" && segments.length === 0 && !id) {
      const unauthorized = requireMigrationAdmin(req, origin);
      if (unauthorized) return unauthorized;
      try {
        const body = await req.json();
        return await createProvider(body as Record<string, unknown>, origin);
      } catch {
        return errorResponse("Invalid JSON body", 400, origin);
      }
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
        return errorResponse(
          "Query parameter 'address' is required",
          400,
          origin,
        );
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

    // PUT /providers/:id - Update known provider profile fields
    if (method === "PUT" && id && segments.length === 0) {
      const unauthorized = requireMigrationAdmin(req, origin);
      if (unauthorized) return unauthorized;
      try {
        const body = await req.json();
        return await updateProviderById(
          id,
          body as Record<string, unknown>,
          origin,
        );
      } catch {
        return errorResponse("Invalid JSON body", 400, origin);
      }
    }

    // Route not found
    return errorResponse(`Not found: ${method} ${pathname}`, 404, origin);
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse("Internal server error", 500, origin);
  }
});
