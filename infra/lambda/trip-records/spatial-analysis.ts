// Return only coarse cells that pass the thresholds after all filters.
// Address hashes stay private. This is aggregation, not a formal anonymity guarantee.
export const SPATIAL_CTES = `spatial_events AS MATERIALIZED (
  SELECT s.* FROM filtered f JOIN optimat.operation_spatial_cells s
    ON s.import_id=f.import_id AND s.source_row=f.source_row
  WHERE (s.kind='origins' AND $7 IN ('combined','origins') AND f.origin_in_window)
     OR (s.kind='destinations' AND $7 IN ('combined','destinations') AND f.destination_in_window)
), spatial_counts AS (
  SELECT cell_x,cell_y,count(*)::integer AS events
  FROM spatial_events GROUP BY cell_x,cell_y
  HAVING count(*) >= 20 AND count(DISTINCT location_key) >= 5
), spatial_public AS (
  SELECT (cell_y+0.5)*1000/6371000*180/pi() AS lat,
    (cell_x+0.5)*1000/(6371000*cos(38*pi()/180))*180/pi() AS lng,
    (floor(events/10.0)*10)::integer AS count
  FROM spatial_counts
)`;

export const SPATIAL_PAYLOAD = `jsonb_build_object(
  'cell_size_m',1000,'minimum_events',20,'minimum_locations',5,
  'geocoded_events',(SELECT count(*) FROM spatial_events),
  'displayed_events',(SELECT coalesce(sum(count),0) FROM spatial_public),
  'total_events',(SELECT count(*) FROM events),
  'cells',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY lat,lng),'[]') FROM spatial_public s)
)`;
