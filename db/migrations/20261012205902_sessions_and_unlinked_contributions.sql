-- migrate:up

-- BACKEND_DESIGN.md §3 as amended by turnip-farm#25: farm sessions (§7.1)
-- and contributions unlinked from accounts (§1.2.17). Every statement is
-- re-runnable (§2).

ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_refresh_token BYTEA;
-- AES-256-GCM ciphertext of Apple's refresh token, kept only to revoke it
-- on account deletion (§1.2.15).

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Lowercase hex SHA-256 of the session token; the token is never stored.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Ownership moves from the account to a per-source key (§1.2.13). Adding
-- a NOT NULL column and dropping user_id are safe only because no
-- deployed environment holds data yet: the one-time exception in §2.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_key_hash CHAR(64) NOT NULL
  CHECK (source_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE sources DROP COLUMN IF EXISTS user_id;

CREATE TABLE IF NOT EXISTS source_attribution (
  source_id     CHAR(64) PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The only link between a contribution and an account (§1.2.17).
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Refreshed by every contribution write; deleted 30 days after it.
);
CREATE INDEX IF NOT EXISTS source_attribution_user_id_idx ON source_attribution (user_id);
CREATE INDEX IF NOT EXISTS source_attribution_attributed_at_idx
  ON source_attribution (attributed_at);

ALTER TABLE data_quarantine DROP COLUMN IF EXISTS user_id;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
