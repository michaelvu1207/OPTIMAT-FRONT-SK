// The caller supplies pair_source before status/hour filtering. Never form a
// round trip by removing other legs from a multi-trip client day.
export const PAIRED_CTES = `pair_groups AS MATERIALIZED (
  SELECT import_id, client_id, service_date, count(*)::integer AS records,
    array_agg(source_row ORDER BY pickup_depart_time NULLS LAST, source_row) AS rows
  FROM pair_source GROUP BY import_id, client_id, service_date
), pair_candidates AS MATERIALIZED (
  SELECT o.*, r.status AS return_status,
    r.pickup_depart_time AS return_departure, r.dropoff_arrive_time AS return_arrival,
    r.origin_city AS return_origin_city, r.origin_lat AS return_origin_lat, r.origin_lng AS return_origin_lng,
    r.destination_city AS return_destination_city, r.destination_lat AS return_destination_lat, r.destination_lng AS return_destination_lng,
    CASE
      WHEN o.pickup_depart_time IS NULL OR o.dropoff_arrive_time IS NULL
        OR r.pickup_depart_time IS NULL OR r.dropoff_arrive_time IS NULL THEN 'missing_time'
      WHEN NOT (o.pickup_depart_time <= o.dropoff_arrive_time AND o.dropoff_arrive_time <= r.pickup_depart_time
        AND r.pickup_depart_time <= r.dropoff_arrive_time) THEN 'invalid_sequence'
      WHEN o.origin_key IS NULL OR r.destination_key IS NULL OR o.origin_key <> r.destination_key THEN 'unmatched_home'
      ELSE 'valid' END AS quality,
    (o.destination_key IS NOT NULL AND o.destination_key = r.origin_key) IS TRUE AS same_activity
  FROM pair_groups g
  JOIN pair_source o ON o.import_id=g.import_id AND o.source_row=g.rows[1]
  JOIN pair_source r ON r.import_id=g.import_id AND r.source_row=g.rows[2]
  WHERE g.records=2 AND g.client_id IS NOT NULL
), selected_pairs AS MATERIALIZED (
  SELECT * FROM pair_candidates WHERE quality='valid'
    AND ($6::text IS NULL OR (status=$6 AND return_status=$6))
    AND (($4=0 AND $5=24)
      OR (extract(hour FROM pickup_depart_time)>=$4 AND extract(hour FROM pickup_depart_time)<$5)
      OR (extract(hour FROM return_departure)>=$4 AND extract(hour FROM return_departure)<$5))
), pair_values AS (
  SELECT metric.* FROM selected_pairs p CROSS JOIN LATERAL (VALUES
    ('outbound_time', extract(epoch FROM p.pickup_depart_time)/3600, 1),
    ('return_time', extract(epoch FROM p.return_departure)/3600, 1),
    ('outbound_travel', extract(epoch FROM (p.dropoff_arrive_time-p.pickup_depart_time))/60, 10),
    ('return_travel', extract(epoch FROM (p.return_arrival-p.return_departure))/60, 10),
    ('activity_duration', extract(epoch FROM (p.return_departure-p.dropoff_arrive_time))/3600, 1)
  ) AS metric(id,value,width)
), pair_bins AS (
  SELECT id, floor(value/width)*width AS start, count(*)::integer AS count
  FROM pair_values GROUP BY id, floor(value/width)*width
), pair_charts AS (
  SELECT id, count(*)::integer AS n, avg(value) AS mean, min(value) AS min, max(value) AS max,
    (SELECT jsonb_agg(jsonb_build_object('start',start,'count',count) ORDER BY start) FROM pair_bins b WHERE b.id=v.id) AS bins
  FROM pair_values v GROUP BY id
), paired_events AS MATERIALIZED (
  SELECT origin_city AS city, origin_lat AS lat, origin_lng AS lng, 'home' AS kind FROM selected_pairs
  UNION ALL SELECT return_destination_city, return_destination_lat, return_destination_lng, 'home' FROM selected_pairs
  UNION ALL SELECT destination_city, destination_lat, destination_lng, 'activity' FROM selected_pairs
  UNION ALL SELECT return_origin_city, return_origin_lat, return_origin_lng, 'activity' FROM selected_pairs
), paired_points AS (
  SELECT city,lat,lng,count(*)::integer AS count,
    count(*) FILTER (WHERE kind='home')::integer AS home_count,
    count(*) FILTER (WHERE kind='activity')::integer AS activity_count
  FROM paired_events WHERE lat IS NOT NULL AND lng IS NOT NULL GROUP BY city,lat,lng
)`;

// Match only nonempty normalized address + ZIP keys; no fuzzy address inference.
export const PAIR_SOURCE_COLUMNS = `t.*,
  CASE WHEN nullif(trim(t.origin_address),'') IS NOT NULL AND nullif(trim(t.origin_zip),'') IS NOT NULL
    THEN upper(regexp_replace(trim(t.origin_address), '[[:space:]]+', ' ', 'g')) || '|' || trim(t.origin_zip) END AS origin_key,
  CASE WHEN nullif(trim(t.destination_address),'') IS NOT NULL AND nullif(trim(t.destination_zip),'') IS NOT NULL
    THEN upper(regexp_replace(trim(t.destination_address), '[[:space:]]+', ' ', 'g')) || '|' || trim(t.destination_zip) END AS destination_key`;

export const PAIRED_PAYLOAD = `jsonb_build_object(
  'quality', jsonb_build_object(
    'source_records',(SELECT count(*) FROM pair_source),
    'single_trip_days',(SELECT count(*) FROM pair_groups WHERE records=1 AND client_id IS NOT NULL),
    'multi_trip_days',(SELECT count(*) FROM pair_groups WHERE records>2 AND client_id IS NOT NULL),
    'missing_client_records',(SELECT coalesce(sum(records),0) FROM pair_groups WHERE client_id IS NULL),
    'missing_time_pairs',(SELECT count(*) FROM pair_candidates WHERE quality='missing_time'),
    'invalid_sequence_pairs',(SELECT count(*) FROM pair_candidates WHERE quality='invalid_sequence'),
    'unmatched_home_pairs',(SELECT count(*) FROM pair_candidates WHERE quality='unmatched_home'),
    'valid_pairs',(SELECT count(*) FROM pair_candidates WHERE quality='valid'),
    'excluded_records',(SELECT count(*) FROM pair_source)-2*(SELECT count(*) FROM pair_candidates WHERE quality='valid')
  ),
  'selected_pairs',(SELECT count(*) FROM selected_pairs),
  'changed_activity_pairs',(SELECT count(*) FROM selected_pairs WHERE NOT same_activity),
  'charts',(SELECT coalesce(jsonb_agg(to_jsonb(pair_charts) ORDER BY id),'[]'::jsonb) FROM pair_charts),
  'points',(SELECT coalesce(jsonb_agg(to_jsonb(paired_points) ORDER BY count DESC,city),'[]'::jsonb) FROM paired_points),
  'events',(SELECT jsonb_build_object('total',count(*),'mapped',count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL),
    'unmapped',count(*) FILTER (WHERE lat IS NULL OR lng IS NULL)) FROM paired_events)
)`;
