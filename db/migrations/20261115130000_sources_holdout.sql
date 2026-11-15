-- migrate:up

-- BACKEND_DESIGN.md §1.2.28: the maintainer's curated holdout is a flag on
-- the source, set and cleared with `bun run sources:holdout`. The export
-- carries it on every row, and trick_contributors skips flagged sources.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS holdout BOOLEAN NOT NULL DEFAULT false;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
