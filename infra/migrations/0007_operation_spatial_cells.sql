-- Private one-kilometre cells derived from reviewed address geocoding.
-- No precise coordinates or original addresses belong in this table.
CREATE TABLE IF NOT EXISTS optimat.operation_spatial_cells (
  import_id text NOT NULL,
  source_row integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('origins','destinations')),
  cell_x integer NOT NULL,
  cell_y integer NOT NULL,
  location_key text NOT NULL,
  precision text NOT NULL CHECK (precision IN ('census_street_interpolation','census_address_range')),
  PRIMARY KEY (import_id,source_row,kind),
  FOREIGN KEY (import_id,source_row) REFERENCES optimat.operation_trips(import_id,source_row) ON DELETE CASCADE
);
REVOKE ALL ON optimat.operation_spatial_cells FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'optimat_app') THEN
    GRANT SELECT ON optimat.operation_spatial_cells TO optimat_app;
  END IF;
END $$;
