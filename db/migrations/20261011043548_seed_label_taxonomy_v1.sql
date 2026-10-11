-- migrate:up

-- Taxonomy version 1, so the current version (max(taxonomy_version) over
-- label_taxonomy) is always defined (BACKEND_DESIGN.md §1.2.8). These are
-- the §3 example rows; curating the full tricking vocabulary is a separate
-- concern (master plan §9 Q1) and ships as a later taxonomy version.

INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES
  ('cork', 'cork', 1),
  ('corkscrew', 'cork', 1),
  ('gainer', 'gainer', 1),
  ('cartfull', 'cartfull', 1),
  ('hook', 'hook', 1),
  ('scoot', 'scoot', 1)
ON CONFLICT (raw, taxonomy_version) DO NOTHING;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
