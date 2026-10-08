const MAP_FIELDS = new Set(['service_zone', 'service_area_geojson', 'service_zone_geojson', 'raw_data']);
const GEO_TYPES = new Set(['FeatureCollection', 'Feature', 'GeometryCollection', 'Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point', 'MultiPoint']);
export const MAX_MODEL_REQUEST_BYTES = 160_000;
const MAX_TOOL_RESULT_BYTES = 60_000;

export class ModelContextLimitError extends Error {}

function cleanModelData(value: unknown): unknown {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try { return cleanModelData(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(cleanModelData).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.type === 'string' && GEO_TYPES.has(record.type)) return undefined;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !MAP_FIELDS.has(key))
    .map(([key, item]) => [key, cleanModelData(item)])
    .filter(([, item]) => item !== undefined));
}

/**
 * Geometry is used by server-side matching and the map, not model reasoning.
 * Strip it only from the serialized model payload so stored tool results,
 * attachments and turn state retain their original data. Apply this recursively
 * to cover candidates, eligibility results and provider-detail responses.
 */
export function serializeToolResultForModel(data: unknown): string {
  const serialized = JSON.stringify(cleanModelData(data)) ?? 'null';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_RESULT_BYTES) {
    // Never silently truncate eligibility clauses or omit individual candidates.
    throw new ModelContextLimitError('Provider details exceed the model context budget.');
  }
  return serialized;
}

export function assertModelRequestBudget(request: unknown): void {
  // Conservative byte ceiling includes tools, system prompt and every tool-loop message.
  // It deliberately leaves ample room below the model's 200k-token context window.
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_MODEL_REQUEST_BYTES) {
    throw new ModelContextLimitError('Conversation exceeds the model context budget.');
  }
}

export function boundConversationHistory<T extends { role: string; content: string }>(messages: T[], maxBytes = 24_000): T[] {
  const groups: T[][] = [];
  for (const message of messages) {
    if (message.role === 'user') groups.push([message]);
    else if (groups.length) groups[groups.length - 1].push(message);
  }
  const kept: T[][] = [];
  let bytes = 2;
  for (let i = groups.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(groups[i]), 'utf8');
    if (bytes + size > maxBytes) {
      if (!kept.length) throw new ModelContextLimitError('Latest message exceeds the conversation budget.');
      break;
    }
    kept.unshift(groups[i]);
    bytes += size;
  }
  return kept.flat();
}
