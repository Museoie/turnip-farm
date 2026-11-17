-- migrate:up

-- BACKEND_DESIGN.md §3, §7.1 "Admin": the maintainer's sessions on the
-- /admin page, after a sign-in through the auth service. Separate from
-- `sessions`, which belong to app accounts: an admin is not a farm user,
-- and nothing here refers to users or sources.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  auth_sub      TEXT NOT NULL,
  auth_sid      TEXT NOT NULL,
  username      TEXT NOT NULL,
  role          TEXT NOT NULL,
  refresh_token TEXT,
  recheck_at    TIMESTAMPTZ NOT NULL,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_auth_sid_idx ON admin_sessions (auth_sid);
CREATE INDEX IF NOT EXISTS admin_sessions_auth_sub_idx ON admin_sessions (auth_sub);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions (expires_at);

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
