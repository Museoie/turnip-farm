-- migrate:up

-- BACKEND_DESIGN.md §1.2.24: training segments are removed and the export
-- serves whole recordings again. Delete every segment row; its labels and
-- its source link cascade. The blobs under segments/ are deleted by
-- `bun run segments:purge-blobs` (DEPLOYMENT.md). The emptied tables and
-- the sources.segments_* columns stay, unread, because migrations are
-- additive (§2). Clearing segments_dirty_at first leaves the old build's
-- segmenter, still running until the restart, nothing to cut, and makes
-- one it already claimed lose its compare-and-set. updated_at is not
-- touched, so the export cursor doesn't move. Re-running changes nothing.
UPDATE sources SET segments_dirty_at = NULL WHERE segments_dirty_at IS NOT NULL;
DELETE FROM training_segments;

-- migrate:down

-- Intentionally empty: migrations are additive only (BACKEND_DESIGN.md §2).
