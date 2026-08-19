-- Fixed-route transit is open to the public. One-Seat Regional Ride is coordinated by its
-- participating paratransit agencies and should not be offered as a separate provider option.

ALTER TABLE optimat.providers
  ADD COLUMN IF NOT EXISTS is_operating BOOLEAN DEFAULT TRUE;

UPDATE optimat.providers
SET is_operating = TRUE
WHERE is_operating IS NULL;

ALTER TABLE optimat.providers
  ALTER COLUMN is_operating SET DEFAULT TRUE,
  ALTER COLUMN is_operating SET NOT NULL;

UPDATE optimat.providers
SET eligibility_reqs = NULL,
    updated_at = now()
WHERE regexp_replace(lower(coalesce(provider_type, '')), '[^a-z0-9]', '', 'g') = 'fixedroute'
  AND eligibility_reqs IS NOT NULL;

UPDATE optimat.providers
SET is_operating = FALSE,
    fare = NULL,
    updated_at = now()
WHERE regexp_replace(lower(provider_name), '[^a-z0-9]', '', 'g') IN (
  'oneseatregionalride',
  'oneseatride'
);

COMMENT ON COLUMN optimat.providers.is_operating IS
  'False hides a retired provider from public directories, trip search, and the chat provider roster without deleting its record.';
