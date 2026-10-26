import { errorResponse, jsonResponse, type ParsedRequest } from '../_shared/adapter.js';
import { getAccount } from '../_shared/portal-auth.js';
import { queryRows } from '../_shared/db.js';

function dateParam(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use YYYY-MM-DD dates.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Invalid date.');
  return value;
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error('Invalid numeric filter.');
  }
  return Number(value);
}

export function parseFilters(params: URLSearchParams) {
  const from = dateParam(params.get('date_from'));
  const to = dateParam(params.get('date_to'));
  if (from && to && from > to) throw new Error('Start date must not follow end date.');
  const mode = params.get('mode') || 'combined';
  if (!['combined', 'origins', 'destinations'].includes(mode)) throw new Error('Invalid map mode.');
  const hourFrom = integer(params.get('hour_from'), 0, 0, 23);
  const hourTo = integer(params.get('hour_to'), 24, 1, 24);
  if (hourFrom >= hourTo) throw new Error('End hour must follow start hour. Split overnight windows into two requests.');
  const status = params.get('status') || null;
  if (status && !/^[A-Z0-9_-]{1,20}$/.test(status)) throw new Error('Invalid status code.');
  return { from, to, mode, hourFrom, hourTo, status,
    providerId: params.get('provider_id') ? integer(params.get('provider_id'), 0, 1, 2147483647) : null,
    offset: integer(params.get('offset'), 0, 0, 10000000), limit: integer(params.get('limit'), 50, 1, 100) };
}

// One SQL statement provides a consistent snapshot across all dashboard panels.
export const OPERATIONS_SQL = `WITH allowed AS MATERIALIZED (
  SELECT i.*, p.provider_name FROM optimat.operation_imports i
  JOIN optimat.providers p ON p.provider_id=i.provider_id
  WHERE i.active AND ($1::boolean OR EXISTS (
    SELECT 1 FROM optimat.portal_account_providers ap WHERE ap.account_id=$2::uuid AND ap.provider_id=i.provider_id
  )) AND ($3::integer IS NULL OR i.provider_id=$3)
), base AS MATERIALIZED (
  SELECT t.*, a.provider_id, a.provider_name,
    (($6=0 AND $7=24) OR (extract(hour FROM t.pickup_depart_time)>=$6 AND extract(hour FROM t.pickup_depart_time)<$7)) IS TRUE AS origin_in_window,
    (($6=0 AND $7=24) OR (extract(hour FROM t.dropoff_arrive_time)>=$6 AND extract(hour FROM t.dropoff_arrive_time)<$7)) IS TRUE AS destination_in_window
  FROM optimat.operation_trips t JOIN allowed a ON a.id=t.import_id
  WHERE ($4::date IS NULL OR t.service_date >= $4::date) AND ($5::date IS NULL OR t.service_date <= $5::date)
    AND ($8::text IS NULL OR t.status=$8)
), filtered AS MATERIALIZED (
  SELECT * FROM base WHERE ($9 IN ('combined','origins') AND origin_in_window)
    OR ($9 IN ('combined','destinations') AND destination_in_window)
), events AS MATERIALIZED (
  SELECT origin_city AS city, origin_lat AS lat, origin_lng AS lng, pickup_depart_time AS event_time, 'origins' AS kind
    FROM filtered WHERE $9 IN ('combined','origins') AND origin_in_window
  UNION ALL
  SELECT destination_city, destination_lat, destination_lng, dropoff_arrive_time, 'destinations'
    FROM filtered WHERE $9 IN ('combined','destinations') AND destination_in_window
), points AS (
  SELECT city, lat, lng, count(*)::integer AS count FROM events
  WHERE lat IS NOT NULL AND lng IS NOT NULL GROUP BY city,lat,lng
), hours AS (
  SELECT extract(hour FROM event_time)::integer AS hour, count(*)::integer AS count
  FROM events WHERE event_time IS NOT NULL GROUP BY 1
), page AS (
  SELECT import_id || ':' || source_row AS id, source_row, to_char(service_date,'YYYY-MM-DD') AS date,
    provider_id, provider_name, origin_city, destination_city, origin_zip, destination_zip,
    to_char(pickup_depart_time,'HH24:MI:SS') AS pickup_time,
    to_char(dropoff_arrive_time,'HH24:MI:SS') AS dropoff_time, status, space_type,
    origin_lat IS NOT NULL AS origin_mapped, destination_lat IS NOT NULL AS destination_mapped
  FROM filtered ORDER BY service_date, pickup_depart_time NULLS LAST, import_id, source_row LIMIT $10 OFFSET $11
)
SELECT jsonb_build_object(
  'imports', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'provider_id',provider_id,'provider_name',provider_name,
    'filename',filename,'date_from',to_char(date_from,'YYYY-MM-DD'),'date_to',to_char(date_to,'YYYY-MM-DD'),
    'row_count',row_count,'imported_at',imported_at) ORDER BY provider_id),'[]'::jsonb) FROM allowed),
  'statuses', (SELECT coalesce(jsonb_agg(status ORDER BY status),'[]'::jsonb) FROM (
    SELECT DISTINCT t.status FROM optimat.operation_trips t JOIN allowed a ON a.id=t.import_id WHERE t.status IS NOT NULL
  ) codes),
  'summary', (SELECT jsonb_build_object('records',count(*),'riders',count(DISTINCT (provider_id,client_id)) FILTER (WHERE client_id IS NOT NULL),
    'providers',count(DISTINCT provider_id),'date_from',to_char(min(service_date),'YYYY-MM-DD'),
    'date_to',to_char(max(service_date),'YYYY-MM-DD')) FROM filtered),
  'event_summary', (SELECT jsonb_build_object('total',count(*),'mapped',count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL),
    'unmapped',count(*) FILTER (WHERE lat IS NULL OR lng IS NULL),'missing_time',count(*) FILTER (WHERE event_time IS NULL)) FROM events),
  'heat_points',(SELECT coalesce(jsonb_agg(to_jsonb(points) ORDER BY count DESC,city),'[]'::jsonb) FROM points),
  'hourly',(SELECT coalesce(jsonb_agg(to_jsonb(hours) ORDER BY hour),'[]'::jsonb) FROM hours),
  'trips',(SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY date,pickup_time NULLS LAST,id),'[]'::jsonb) FROM page)
) AS payload`;

export async function operationsDashboard(req: ParsedRequest) {
  if (req.method !== 'GET') return errorResponse('Method not allowed.', 405, req.origin);
  const account = await getAccount(req);
  if (!account) return errorResponse('Sign in to view operational data.', 401, req.origin);
  let filters: ReturnType<typeof parseFilters>;
  try { filters = parseFilters(req.searchParams); }
  catch (error) { return errorResponse((error as Error).message, 400, req.origin); }
  try {
    const rows = await queryRows<{ payload: Record<string, unknown> }>(OPERATIONS_SQL, [
      account.role === 'super_admin', account.id, filters.providerId, filters.from, filters.to,
      filters.hourFrom, filters.hourTo, filters.status, filters.mode, filters.limit, filters.offset,
    ]);
    const response = jsonResponse({ ...rows[0]?.payload, filters, precision: 'city_reference_point', timezone: 'America/Los_Angeles' }, 200, req.origin);
    if (typeof response === 'object') response.headers = { ...response.headers, 'Cache-Control': 'private, no-store' };
    return response;
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error('Operations query failed', { code });
    return errorResponse(code === '42P01' ? 'Operational data is not installed. Apply migration 0005 and import the LINK workbook.' : 'Operational data could not be loaded.', 503, req.origin);
  }
}
