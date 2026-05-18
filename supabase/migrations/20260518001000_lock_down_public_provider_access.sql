DROP POLICY IF EXISTS "Providers are editable by authenticated users" ON optimat.providers;
DROP POLICY IF EXISTS "Providers are viewable by everyone" ON optimat.providers;

REVOKE ALL ON TABLE optimat.providers FROM anon;
REVOKE ALL ON TABLE optimat.providers FROM authenticated;

GRANT ALL ON TABLE optimat.providers TO service_role;

REVOKE EXECUTE ON FUNCTION optimat.search_providers(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION optimat.search_providers(text, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION optimat.filter_providers_with_coords(numeric, numeric, numeric, numeric, text, text, text, text, text, text, text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION optimat.filter_providers_with_coords(numeric, numeric, numeric, numeric, text, text, text, text, text, text, text, text, boolean, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION optimat.filter_providers_by_location(double precision, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION optimat.filter_providers_by_location(double precision, double precision, double precision, double precision) TO service_role;

REVOKE EXECUTE ON FUNCTION optimat.filter_providers_by_location(text, text, text, text, text, text, text, text, text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION optimat.filter_providers_by_location(text, text, text, text, text, text, text, text, text, text, boolean, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION optimat.get_provider_geojson(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION optimat.get_provider_geojson(integer) TO service_role;

REVOKE EXECUTE ON FUNCTION optimat.get_providers_geojson() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION optimat.get_providers_geojson() TO service_role;
