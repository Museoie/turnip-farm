-- migrate:up

-- BACKEND_DESIGN.md §3: when the ingest worker last stored the source's
-- canonical blob, set with sha256. NULL for a source not ingested yet, and
-- for sources ingested before this column existed: the farm kept no record
-- of that time.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
