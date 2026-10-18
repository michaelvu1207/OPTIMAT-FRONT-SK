BEGIN;
CREATE TABLE optimat.portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._@+-]{2,79}$'),
  display_name text NOT NULL,
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$'),
  role text NOT NULL CHECK (role IN ('super_admin', 'provider')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE optimat.portal_account_providers (
  account_id uuid REFERENCES optimat.portal_accounts(id) ON DELETE CASCADE,
  provider_id integer REFERENCES optimat.providers(provider_id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, provider_id)
);
CREATE TABLE optimat.portal_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES optimat.portal_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON optimat.portal_sessions(account_id);
CREATE TABLE optimat.portal_login_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  resets_at timestamptz NOT NULL
);
REVOKE ALL ON optimat.portal_accounts, optimat.portal_account_providers,
  optimat.portal_sessions, optimat.portal_login_limits FROM PUBLIC;
COMMIT;
