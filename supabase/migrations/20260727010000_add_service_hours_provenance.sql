-- Provenance for provider service hours.
--
-- service_hours decides whether a rider is told a trip is possible at a given time. Until now the
-- column was null for every provider, so the chat function's schedule filter passed everything
-- through unchecked. Populating it is only safe if each value can be traced back to the page it
-- came from and re-checked later, since published hours change.

ALTER TABLE optimat.providers
  ADD COLUMN IF NOT EXISTS service_hours_source TEXT,
  ADD COLUMN IF NOT EXISTS service_hours_quote TEXT,
  ADD COLUMN IF NOT EXISTS service_hours_confidence TEXT,
  ADD COLUMN IF NOT EXISTS service_hours_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS service_hours_notes TEXT;

COMMENT ON COLUMN optimat.providers.service_hours_source IS
  'URL of the page the service hours were read from. A row with service_hours set and no source should be treated as unverified.';
COMMENT ON COLUMN optimat.providers.service_hours_quote IS
  'Verbatim text from service_hours_source stating the hours, kept so a human can spot-check without re-researching.';
COMMENT ON COLUMN optimat.providers.service_hours_confidence IS
  'high = clearly stated on an official page, medium = inferred from a schedule table or PDF.';
COMMENT ON COLUMN optimat.providers.service_hours_verified_at IS
  'When the hours were last confirmed against the source. Published hours drift; re-verify periodically.';
COMMENT ON COLUMN optimat.providers.service_hours_notes IS
  'Holidays, advance-notice requirements, appointment-only caveats, and other dispatcher-relevant exceptions.';
