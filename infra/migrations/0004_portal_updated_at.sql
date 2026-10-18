-- Safe to run after creating the portal tables, including after importing accounts.
-- Existing rows receive the migration execution time; historical update times are unknown.
BEGIN;

ALTER TABLE optimat.portal_accounts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE optimat.portal_account_providers
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE optimat.portal_sessions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE optimat.portal_login_limits
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION optimat.set_portal_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION optimat.set_portal_updated_at() IS
  'Sets updated_at to the current wall-clock timestamp on every row update, including updates that leave other values unchanged.';

CREATE OR REPLACE TRIGGER portal_accounts_set_updated_at
BEFORE UPDATE ON optimat.portal_accounts
FOR EACH ROW EXECUTE FUNCTION optimat.set_portal_updated_at();

CREATE OR REPLACE TRIGGER portal_account_providers_set_updated_at
BEFORE UPDATE ON optimat.portal_account_providers
FOR EACH ROW EXECUTE FUNCTION optimat.set_portal_updated_at();

CREATE OR REPLACE TRIGGER portal_sessions_set_updated_at
BEFORE UPDATE ON optimat.portal_sessions
FOR EACH ROW EXECUTE FUNCTION optimat.set_portal_updated_at();

CREATE OR REPLACE TRIGGER portal_login_limits_set_updated_at
BEFORE UPDATE ON optimat.portal_login_limits
FOR EACH ROW EXECUTE FUNCTION optimat.set_portal_updated_at();

COMMENT ON COLUMN optimat.portal_accounts.updated_at IS
  'Timestamp initialized on insert and automatically refreshed on every row update by a database trigger.';
COMMENT ON COLUMN optimat.portal_account_providers.updated_at IS
  'Timestamp initialized on insert and automatically refreshed on every row update by a database trigger.';
COMMENT ON COLUMN optimat.portal_sessions.updated_at IS
  'Timestamp initialized on insert and automatically refreshed on every row update by a database trigger. This does not extend session expiry.';
COMMENT ON COLUMN optimat.portal_login_limits.updated_at IS
  'Timestamp initialized on insert and automatically refreshed on every row update by a database trigger. This does not reset the rate-limit window.';

COMMIT;
