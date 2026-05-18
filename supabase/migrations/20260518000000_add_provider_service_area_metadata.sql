ALTER TABLE optimat.providers
  ADD COLUMN IF NOT EXISTS service_area_geojson JSONB,
  ADD COLUMN IF NOT EXISTS service_area_cities TEXT[],
  ADD COLUMN IF NOT EXISTS service_area_source TEXT,
  ADD COLUMN IF NOT EXISTS service_area_notes TEXT,
  ADD COLUMN IF NOT EXISTS provider_software TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

COMMENT ON COLUMN optimat.providers.service_area_geojson IS
  'Custom provider service-area GeoJSON imported from curated provider files or authoritative provider feeds.';

COMMENT ON COLUMN optimat.providers.service_area_cities IS
  'Normalized city names used to generate a provider service area when no custom GeoJSON is available.';

COMMENT ON COLUMN optimat.providers.service_area_source IS
  'How service_zone was derived: custom_geojson, city_list, existing_preserved, unresolved, or manual.';

COMMENT ON COLUMN optimat.providers.service_area_notes IS
  'Import notes for provider service-area provenance or unresolved city names.';

COMMENT ON COLUMN optimat.providers.provider_software IS
  'Provider scheduling/dispatch software noted in the provider validation workbook.';

CREATE INDEX IF NOT EXISTS idx_providers_service_area_cities
  ON optimat.providers USING GIN (service_area_cities);

CREATE INDEX IF NOT EXISTS idx_providers_provider_software
  ON optimat.providers (provider_software)
  WHERE provider_software IS NOT NULL;
