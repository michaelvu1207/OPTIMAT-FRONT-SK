-- LINK operational records. Raw records are never served by public APIs.
BEGIN;
CREATE TABLE IF NOT EXISTS optimat.operation_imports (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source = 'LINK'),
  filename text NOT NULL,
  file_sha256 text NOT NULL,
  parser_version text NOT NULL,
  provider_id integer NOT NULL REFERENCES optimat.providers(provider_id),
  row_count integer NOT NULL CHECK (row_count >= 0),
  date_from date NOT NULL,
  date_to date NOT NULL,
  active boolean NOT NULL DEFAULT false,
  quality_report jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_from <= date_to)
);
CREATE UNIQUE INDEX IF NOT EXISTS operation_imports_active_source
  ON optimat.operation_imports(source, provider_id) WHERE active;

CREATE TABLE IF NOT EXISTS optimat.operation_trips (
  import_id text NOT NULL REFERENCES optimat.operation_imports(id),
  source_row integer NOT NULL CHECK (source_row >= 2),
  service_date date NOT NULL,
  client_id text,
  passengers integer CHECK (passengers >= 0),
  status text,
  space_type text,
  origin_address text,
  origin_city text,
  origin_zip text,
  destination_address text,
  destination_city text,
  destination_zip text,
  destination_city_source text,
  pickup_arrive_time time,
  pickup_depart_time time,
  dropoff_arrive_time time,
  dropoff_depart_time time,
  scheduled_time time,
  odometer_distance numeric CHECK (odometer_distance >= 0),
  origin_lat double precision,
  origin_lng double precision,
  destination_lat double precision,
  destination_lng double precision,
  PRIMARY KEY (import_id, source_row),
  CHECK ((origin_lat IS NULL) = (origin_lng IS NULL)),
  CHECK ((destination_lat IS NULL) = (destination_lng IS NULL)),
  CHECK (origin_lat BETWEEN -90 AND 90 AND origin_lng BETWEEN -180 AND 180),
  CHECK (destination_lat BETWEEN -90 AND 90 AND destination_lng BETWEEN -180 AND 180)
);
CREATE INDEX IF NOT EXISTS operation_trips_date_status
  ON optimat.operation_trips(import_id, service_date, status);
COMMENT ON TABLE optimat.operation_trips IS
  'Private LINK source records. Coordinates are Census place reference points, not passenger locations. Times are local America/Los_Angeles wall times.';
COMMENT ON COLUMN optimat.operation_trips.destination_city_source IS
  'An unambiguous normalized pickup-address/ZIP match within the same source; otherwise unresolved.';
COMMENT ON COLUMN optimat.operation_trips.odometer_distance IS
  'Source OdometerDistance without an assumed unit. Not used to display miles until verified.';
REVOKE ALL ON optimat.operation_imports, optimat.operation_trips FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'optimat_app') THEN
    GRANT SELECT ON optimat.operation_imports, optimat.operation_trips TO optimat_app;
  END IF;
END $$;
COMMIT;
