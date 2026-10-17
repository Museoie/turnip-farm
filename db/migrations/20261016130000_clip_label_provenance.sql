-- migrate:up

-- Provenance columns the training export reads (BACKEND_DESIGN.md §1.2.18,
-- §3). The contribution endpoints (#28) landed without them; the export
-- (#19) needs them, so they arrive here. Existing rows take the defaults:
-- labels read as 'typed', clips as heuristic/manual (NULL model version,
-- no suggested names, not a blind sample).

ALTER TABLE labels
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'typed'
    CHECK (origin IN ('typed', 'vocabulary', 'model'));

ALTER TABLE clips
  ADD COLUMN IF NOT EXISTS proposal_model_version TEXT,
  ADD COLUMN IF NOT EXISTS suggested_names TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS suggestions_withheld BOOLEAN NOT NULL DEFAULT FALSE;

-- §3: a clip that carries suggested names (or is a blind sample) must name
-- the model that proposed them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clips_suggestions_need_model'
  ) THEN
    ALTER TABLE clips ADD CONSTRAINT clips_suggestions_need_model CHECK (
      proposal_model_version IS NOT NULL OR
      (cardinality(suggested_names) = 0 AND NOT suggestions_withheld)
    );
  END IF;
END $$;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
-- A rollback only unrecords the version; `migrate` then re-applies it as a
-- no-op because every statement above is IF NOT EXISTS / guarded.
