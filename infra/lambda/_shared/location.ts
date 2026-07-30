import { GeoPlacesClient, SearchTextCommand } from '@aws-sdk/client-geo-places';
import { GeoRoutesClient, CalculateRoutesCommand } from '@aws-sdk/client-geo-routes';

// Amazon Location Places/Routes is not offered in us-west-1. Use the nearest
// supported region while keeping the application and rider data in us-west-1.
const region = process.env.AWS_LOCATION_REGION || 'us-west-2';
const places = new GeoPlacesClient({ region });
const routes = new GeoRoutesClient({ region });

export type AwsPlace = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId: string;
};

export async function searchPlaces(query: string, maxResults = 5): Promise<AwsPlace[]> {
  const response = await places.send(new SearchTextCommand({
    QueryText: query,
    MaxResults: maxResults,
    BiasPosition: [-122.07, 37.91],
    Filter: { IncludeCountries: ['USA'] },
    IntendedUse: 'SingleUse',
    Language: 'en',
  }));
  return (response.ResultItems || [])
    .filter((item) => Array.isArray(item.Position) && item.Position.length >= 2)
    .map((item) => ({
      name: item.Title || query,
      address: item.Title || query,
      lng: Number(item.Position![0]),
      lat: Number(item.Position![1]),
      placeId: item.PlaceId || '',
    }));
}

export async function geocodePlace(query: string): Promise<AwsPlace | null> {
  return (await searchPlaces(query, 1))[0] || null;
}

export async function calculateRoute(
  originAddress: string,
  destinationAddress: string,
  mode: 'driving' | 'transit',
) {
  const [origin, destination] = await Promise.all([
    geocodePlace(originAddress),
    geocodePlace(destinationAddress),
  ]);
  if (!origin || !destination) return null;

  const response = await routes.send(new CalculateRoutesCommand({
    Origin: [origin.lng, origin.lat],
    Destination: [destination.lng, destination.lat],
    TravelMode: mode === 'transit' ? 'Transit' : 'Car',
    LegGeometryFormat: 'FlexiblePolyline',
    LegAdditionalFeatures: ['Summary'],
    Languages: ['en-US'],
  }));
  const route = response.Routes?.[0];
  if (!route) return null;
  const distance = route.Summary?.Distance ?? null;
  const duration = route.Summary?.Duration ?? null;
  return {
    summary: route.MajorRoadLabels?.map((label) => label.RoadName?.Value || label.RouteNumber?.Value).filter(Boolean).join(', ') || null,
    distance_text: distance === null ? null : `${(distance / 1609.344).toFixed(1)} mi`,
    distance_meters: distance,
    duration_text: duration === null ? null : `${Math.round(duration / 60)} mins`,
    duration_seconds: duration,
    polyline: route.Legs?.map((leg) => leg.Geometry?.Polyline).filter(Boolean).join('') || null,
    legs: route.Legs || [],
    warnings: (response.Notices || []).map((notice) => notice.Code || 'route_notice'),
    origin,
    destination,
  };
}
