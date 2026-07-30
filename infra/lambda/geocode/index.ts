/**
 * Geocoding Lambda Function
 *
 * Address geocoding using Amazon Location Service Places.
 *
 * Routes:
 *   GET /geocode?address=... → { success, formatted_address, lat, lng, place_id }
 */

import { createHandler, jsonResponse, errorResponse } from '../_shared/adapter.js';
import { geocodePlace } from '../_shared/location.js';

async function geocodeAddress(address: string) {
  const place = await geocodePlace(address);
  if (!place) {
    return { success: false as const, error: `No results found for address: ${address}` };
  }
  return {
    success: true as const,
    formatted_address: place.address,
    lat: place.lat,
    lng: place.lng,
    place_id: place.placeId,
  };
}

export const handler = createHandler(async (req) => {
  if (req.method !== 'GET') {
    return errorResponse(`Method ${req.method} not allowed. Use GET.`, 405, req.origin);
  }

  const address = req.searchParams.get('address');
  if (!address || address.trim().length === 0) {
    return errorResponse('Missing required parameter: address', 400, req.origin);
  }
  if (address.trim().length < 3) {
    return errorResponse('Address must be at least 3 characters', 400, req.origin);
  }
  if (address.length > 500) {
    return errorResponse('Address exceeds maximum length of 500 characters', 400, req.origin);
  }

  const result = await geocodeAddress(address.trim());

  if (result.success) {
    return jsonResponse(result, 200, req.origin);
  } else {
    const status = result.error.includes('No results') ? 404 : 500;
    return jsonResponse(result, status, req.origin);
  }
});
