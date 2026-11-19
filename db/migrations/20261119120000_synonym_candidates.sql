-- migrate:up

-- BACKEND_DESIGN.md §3, §1.2.29: an app user's "these two names are the
-- same trick", kept as a suggestion for the vocabulary until the
-- maintainer merges it (labels:merge) or it expires. Every statement is
-- re-runnable (§2).

CREATE TABLE IF NOT EXISTS synonym_candidates (
  name         TEXT NOT NULL
               CHECK (name <> '' AND name = btrim(name) AND char_length(name) <= 64),
  same_as      TEXT NOT NULL
               CHECK (same_as <> '' AND same_as = btrim(same_as) AND char_length(same_as) <= 64),
  -- The name the account wants kept: `name` goes under `same_as`.
  account_hash CHAR(64) NOT NULL CHECK (account_hash ~ '^[0-9a-f]{64}$'),
  -- The same HMAC-SHA-256 of the account id as label_candidates (§1.2.25).
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
  -- The account's first submission of the pair; deleted 30 days after it.
);
CREATE UNIQUE INDEX IF NOT EXISTS synonym_candidates_pair_account_uniq
  ON synonym_candidates (lower(name), lower(same_as), account_hash);
CREATE INDEX IF NOT EXISTS synonym_candidates_account_hash_idx ON synonym_candidates (account_hash);
CREATE INDEX IF NOT EXISTS synonym_candidates_submitted_at_idx ON synonym_candidates (submitted_at);

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
