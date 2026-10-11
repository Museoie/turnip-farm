-- migrate:up

-- The v2 schema of BACKEND_DESIGN.md §3. Every statement is guarded with
-- IF NOT EXISTS so the migration is re-runnable (§2).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  -- Sign in with Apple `sub` claim: per-app opaque pseudonymous subject.
  -- No name, email, or other Apple profile data is stored.
  reputation  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  is_blocked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id              CHAR(64) PRIMARY KEY,
  -- Deterministic video_id (master plan §1): SHA-256 hex of
  -- "turnip:phasset:" + PHAsset.localIdentifier (Photos videos) or of the
  -- file bytes (imports). The farm never mints source identities.
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frame_count     INTEGER NOT NULL CHECK (frame_count > 0),
  -- Canonical 10 Hz frame count of the stored pose sequence; clip windows
  -- are validated against it (POSE_FORMAT.md §6).
  sample_rate     REAL NOT NULL,
  -- As-sent analysis rate, provenance only. Stored pose data is canonical
  -- 10 Hz.
  keypoint_format TEXT NOT NULL DEFAULT 'tkp1',
  r2_key          TEXT NOT NULL,
  -- Deterministic: poses/<id>.tkp1.gz. Holds the canonical 10 Hz blob;
  -- the as-sent upload lands on a staging key and is promoted at ingest
  -- (§1.2.10). Re-contribution overwrites.
  sha256          CHAR(64),
  -- SHA-256 of the canonical .tkp1.gz blob bytes as stored. Computed by
  -- the farm at ingest; never client-supplied; NULL until the canonical
  -- blob is stored.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sources_id_hex  CHECK (id     ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sources_sha_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS sources_user_id_idx ON sources (user_id);

CREATE TABLE IF NOT EXISTS clips (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-minted once per clip; recovered from the server after
  -- reinstall (master plan §5.1), never re-derived, never minted here.
  source_id     CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  start_frame   INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame     INTEGER NOT NULL CHECK (end_frame > start_frame),
  -- Frame indices into the source's canonical 10 Hz pose sequence.
  -- end_frame <= sources.frame_count is enforced at the API layer.
  auto_detected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_source_id_idx ON clips (source_id);

CREATE TABLE IF NOT EXISTS labels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id          UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  trick_name       TEXT NOT NULL
                   CHECK (trick_name <> '' AND trick_name = btrim(trick_name)),
  -- Free text, stored trimmed and verbatim (casing preserved).
  -- Canonicalization happens at training-curation time via label_taxonomy.
  taxonomy_version INTEGER NOT NULL,
  -- Vocabulary version in effect when THIS name was confirmed.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Rejects case-insensitive duplicates; it does not collapse them, so the
-- API dedupes before insert (§5).
CREATE UNIQUE INDEX IF NOT EXISTS labels_clip_trick_uniq
  ON labels (clip_id, lower(trick_name));

CREATE TABLE IF NOT EXISTS label_taxonomy (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw              TEXT NOT NULL,
  canonical        TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  -- Monotonic int, bumped when canonical names are added or changed.
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT label_taxonomy_raw_version_uniq UNIQUE (raw, taxonomy_version)
);
CREATE INDEX IF NOT EXISTS label_taxonomy_lookup_idx
  ON label_taxonomy (raw, taxonomy_version DESC);

CREATE TABLE IF NOT EXISTS models (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version          TEXT NOT NULL UNIQUE,
  -- e.g. trick-v1.2. Immutable: a version is never re-published.
  model_type       TEXT NOT NULL DEFAULT 'trick-detection'
                   CHECK (model_type = 'trick-detection'),
  taxonomy_version INTEGER NOT NULL,
  -- Vocabulary version the model trained on.
  r2_key           TEXT NOT NULL,
  sha256           CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Digest of the model artifact bytes; shipped in the manifest so the
  -- client can verify the download.
  byte_size        BIGINT,
  -- Artifact size in bytes, for the client's download progress UI and
  -- pre-flight storage check.
  min_client_version TEXT,
  -- Minimum client build that may install this model (OTA skip gate).
  input_desc       JSONB,
  -- Model input descriptor (feature layout) so the client can construct
  -- the input.
  output_desc      JSONB,
  -- Model output descriptor (segment + trick-name schema).
  holdout_report_r2_key TEXT,
  -- R2 key of the holdout evaluation report for this version.
  training_run_id  TEXT,
  -- Training-pipeline run that produced this version (provenance).
  val_metrics      JSONB NOT NULL DEFAULT '{}',
  promoted_at      TIMESTAMPTZ,
  -- NULL = trained but not champion. The current model is the row with the
  -- greatest non-null promoted_at.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_quarantine (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who uploaded the bad data (master plan §6 attribution).
  reason         TEXT NOT NULL,
  metrics        JSONB,
  -- Snapshot of the regression metrics that triggered the quarantine.
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT CHECK (resolution IN ('released', 'purged')),
  CONSTRAINT quarantine_resolution_consistent CHECK (
    (resolved_at IS NULL  AND resolution IS NULL) OR
    (resolved_at IS NOT NULL AND resolution IS NOT NULL)
  )
);
-- One open quarantine per source (§1.2.4).
CREATE UNIQUE INDEX IF NOT EXISTS data_quarantine_open_uniq
  ON data_quarantine (source_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS data_quarantine_open_idx
  ON data_quarantine (quarantined_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type      TEXT NOT NULL CHECK (target_type IN ('source', 'clip', 'label')),
  target_id        TEXT NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at)
  WHERE status = 'open';

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
-- A rollback only unrecords the version; `migrate` then re-applies it as a
-- no-op because every statement above is IF NOT EXISTS.
