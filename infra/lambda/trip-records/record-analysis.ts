// These summaries use individual source records, not inferred round trips.
// The caller's filtered CTE applies the same provider/date/status/hour selection.
export const RECORD_ANALYSIS_CTES = `record_samples AS MATERIALIZED (
  SELECT *, extract(epoch FROM pickup_depart_time)/3600.0 AS departure_hour,
    CASE WHEN pickup_depart_time IS NOT NULL AND dropoff_arrive_time >= pickup_depart_time
      THEN extract(epoch FROM (dropoff_arrive_time-pickup_depart_time))/60.0 END AS travel_minutes
  FROM filtered
), record_daily_counts AS (
  SELECT to_char(service_date,'YYYY-MM-DD') AS label, count(*)::integer AS count
  FROM filtered GROUP BY service_date
), record_daily AS (
  SELECT to_char(day,'YYYY-MM-DD') AS label,coalesce(c.count,0)::integer AS count
  FROM generate_series((SELECT min(service_date) FROM filtered)::timestamp,
    (SELECT max(service_date) FROM filtered)::timestamp,interval '1 day') day
  LEFT JOIN record_daily_counts c ON c.label=to_char(day,'YYYY-MM-DD')
), record_statuses AS (
  SELECT coalesce(status,'Unknown') AS label,count(*)::integer AS count FROM filtered GROUP BY status
), record_cities AS (
  SELECT coalesce(city,'Unknown') AS label,kind,count(*)::integer AS count FROM events GROUP BY city,kind
)`;

export const RECORD_ANALYSIS_PAYLOAD = `jsonb_build_object(
  'records',(SELECT count(*) FROM filtered),
  'daily',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY label),'[]') FROM record_daily d),
  'statuses',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY count DESC,label),'[]') FROM record_statuses s),
  'cities',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY count DESC,label),'[]') FROM record_cities c),
  'departure',jsonb_build_object('id','record_departure',
    'n',(SELECT count(departure_hour) FROM record_samples),
    'mean',(SELECT avg(departure_hour) FROM record_samples),
    'min',(SELECT min(departure_hour) FROM record_samples),
    'max',(SELECT max(departure_hour) FROM record_samples),
    'bins',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY start),'[]') FROM (
      SELECT floor(departure_hour)::integer AS start,count(*)::integer AS count
      FROM record_samples WHERE departure_hour IS NOT NULL GROUP BY 1) b)),
  'travel',jsonb_build_object('id','record_travel',
    'n',(SELECT count(travel_minutes) FROM record_samples),
    'mean',(SELECT avg(travel_minutes) FROM record_samples),
    'min',(SELECT min(travel_minutes) FROM record_samples),
    'max',(SELECT max(travel_minutes) FROM record_samples),
    'bins',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY start),'[]') FROM (
      SELECT (floor(travel_minutes/10)*10)::integer AS start,count(*)::integer AS count
      FROM record_samples WHERE travel_minutes IS NOT NULL GROUP BY 1) b))
)`;
