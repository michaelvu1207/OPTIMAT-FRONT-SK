const MAP_FIELDS = new Set(['service_zone', 'service_area_geojson', 'service_zone_geojson']);

/**
 * Geometry is used by server-side matching and the map, not model reasoning.
 * Strip it only from the serialized model payload so stored tool results,
 * attachments and turn state retain their original data. Apply this recursively
 * to cover candidates, eligibility results and provider-detail responses.
 */
export function serializeToolResultForModel(data: unknown): string {
  return JSON.stringify(data, (key, value) => MAP_FIELDS.has(key) ? undefined : value) ?? 'null';
}
