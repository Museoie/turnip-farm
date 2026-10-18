-- migrate:up

-- BACKEND_DESIGN.md §3: the models table carries name_metrics for the
-- per-canonical-name impact metrics shipped in the manifest as the app's
-- impact feedback (master plan §6). Additive only: existing rows read as
-- '{}' via the default (§2); the model registry endpoints will write and
-- serve it once they land.

ALTER TABLE models ADD COLUMN IF NOT EXISTS name_metrics JSONB NOT NULL DEFAULT '{}';
-- Per canonical name: holdout precision and recall plus holdout_count and
-- train_count (example counts), e.g. {"gainer": {"precision": 0.9,
-- "recall": 0.84, "holdout_count": 31, "train_count": 412}}. Shipped in
-- the manifest as the app's impact feedback (master plan §6).

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
