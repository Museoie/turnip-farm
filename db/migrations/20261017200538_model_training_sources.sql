-- migrate:up

-- BACKEND_DESIGN.md §3 as amended by turnip-farm#33: training membership is
-- source-level (§1.2.20), so an owner can read which promoted models a
-- source trained via GET /api/sources/:id → trained_in (§7.3). Every
-- statement is re-runnable (§2).

CREATE TABLE IF NOT EXISTS model_training_sources (
  model_version TEXT NOT NULL REFERENCES models(version),
  source_id     CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- The sources a promoted model trained on (§1.2.20). No account column:
  -- ids of sources deleted between training and publish are simply absent
  -- via the cascade.
  PRIMARY KEY (source_id, model_version)
);

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
