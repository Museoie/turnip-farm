// Checks a migrated database against BACKEND_DESIGN.md §3. Runs only when
// TEST_DATABASE_URL names one — never DATABASE_URL, which Bun loads from a
// developer's .env. Every test runs in a transaction that is rolled back, so
// the database is left as it was found.

import { type SavepointSQL, SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set in CI; the schema tests would silently skip");
}

const SOURCE_ID = "a".repeat(64);
const DIGEST = "b".repeat(64);

class Rollback extends Error {}

describe.skipIf(!url)("schema (BACKEND_DESIGN.md §3)", () => {
  const sql = new SQL(url ?? "");
  afterAll(() => sql.close());

  async function inRollback(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await fn(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }

  // Runs one statement under a savepoint and returns the name of the
  // constraint it violated (undefined if it succeeded), leaving the
  // enclosing transaction usable.
  async function violation(
    tx: TransactionSQL,
    statement: (sp: SavepointSQL) => Promise<unknown>,
  ): Promise<string | undefined> {
    try {
      await tx.savepoint(statement);
      return undefined;
    } catch (err) {
      if (err instanceof SQL.PostgresError && err.constraint) return err.constraint;
      throw err;
    }
  }

  // A user owning one source with one clip; returns the clip ID.
  async function insertClip(tx: TransactionSQL): Promise<string> {
    await tx`INSERT INTO users (id) VALUES ('user-1')`;
    await tx`
      INSERT INTO sources (id, user_id, frame_count, sample_rate, r2_key)
      VALUES (${SOURCE_ID}, 'user-1', 600, 30, ${`poses/${SOURCE_ID}.tkp1.gz`})`;
    const [clip] = await tx`
      INSERT INTO clips (source_id, start_frame, end_frame)
      VALUES (${SOURCE_ID}, 120, 175)
      RETURNING id`;
    return clip.id;
  }

  test("has exactly the §3 tables", async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      "clips",
      "data_quarantine",
      "label_taxonomy",
      "labels",
      "models",
      "reports",
      "schema_migrations", // dbmate's applied-version ledger
      "sources",
      "users",
    ]);
  });

  test("has exactly the §3 indexes, including those behind PK and UNIQUE constraints", async () => {
    const rows = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename, indexname`;
    expect(rows.map((r: { indexdef: string }) => r.indexdef)).toEqual([
      "CREATE UNIQUE INDEX clips_pkey ON public.clips USING btree (id)",
      "CREATE INDEX clips_source_id_idx ON public.clips USING btree (source_id)",
      "CREATE INDEX data_quarantine_open_idx ON public.data_quarantine USING btree (quarantined_at) WHERE (resolved_at IS NULL)",
      "CREATE UNIQUE INDEX data_quarantine_open_uniq ON public.data_quarantine USING btree (source_id) WHERE (resolved_at IS NULL)",
      "CREATE UNIQUE INDEX data_quarantine_pkey ON public.data_quarantine USING btree (id)",
      "CREATE INDEX label_taxonomy_lookup_idx ON public.label_taxonomy USING btree (raw, taxonomy_version DESC)",
      "CREATE UNIQUE INDEX label_taxonomy_pkey ON public.label_taxonomy USING btree (id)",
      "CREATE UNIQUE INDEX label_taxonomy_raw_version_uniq ON public.label_taxonomy USING btree (raw, taxonomy_version)",
      "CREATE UNIQUE INDEX labels_clip_trick_uniq ON public.labels USING btree (clip_id, lower(trick_name))",
      "CREATE UNIQUE INDEX labels_pkey ON public.labels USING btree (id)",
      "CREATE UNIQUE INDEX models_pkey ON public.models USING btree (id)",
      "CREATE UNIQUE INDEX models_version_key ON public.models USING btree (version)",
      "CREATE UNIQUE INDEX reports_pkey ON public.reports USING btree (id)",
      "CREATE INDEX reports_status_idx ON public.reports USING btree (status, created_at) WHERE (status = 'open'::text)",
      "CREATE UNIQUE INDEX sources_pkey ON public.sources USING btree (id)",
      "CREATE INDEX sources_user_id_idx ON public.sources USING btree (user_id)",
      "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
    ]);
  });

  test("seeds taxonomy version 1, so the current version is always defined (§1.2.8)", async () => {
    const [{ current }] = await sql`SELECT max(taxonomy_version) AS current FROM label_taxonomy`;
    expect(current).toBe(1);
    const [{ canonical }] = await sql`
      SELECT canonical FROM label_taxonomy WHERE raw = 'corkscrew' AND taxonomy_version = 1`;
    expect(canonical).toBe("cork");
  });

  test("sources: hex IDs and digests, NULL digest until ingest", async () => {
    await inRollback(async (tx) => {
      await insertClip(tx);
      const insert = (id: string, sha256: string | null) => (sp: SavepointSQL) =>
        sp`INSERT INTO sources (id, user_id, frame_count, sample_rate, r2_key, sha256)
           VALUES (${id}, 'user-1', 600, 10, 'k', ${sha256})`;
      expect(await violation(tx, insert("A".repeat(64), null))).toBe("sources_id_hex");
      expect(await violation(tx, insert("c".repeat(63), null))).toBe("sources_id_hex");
      expect(await violation(tx, insert("c".repeat(64), "B".repeat(64)))).toBe("sources_sha_hex");
      expect(await violation(tx, insert("c".repeat(64), DIGEST))).toBeUndefined();

      const [source] = await tx`SELECT sha256, keypoint_format FROM sources WHERE id = ${SOURCE_ID}`;
      expect(source).toEqual({ sha256: null, keypoint_format: "tkp1" });
    });
  });

  test("clips: windows are non-empty and start at frame 0 or later", async () => {
    await inRollback(async (tx) => {
      await insertClip(tx);
      const insert = (start: number, end: number) => (sp: SavepointSQL) =>
        sp`INSERT INTO clips (source_id, start_frame, end_frame) VALUES (${SOURCE_ID}, ${start}, ${end})`;
      expect(await violation(tx, insert(10, 10))).toBe("clips_check");
      expect(await violation(tx, insert(-1, 10))).toBe("clips_start_frame_check");
      expect(await violation(tx, insert(0, 1))).toBeUndefined();
    });
  });

  test("labels: one row per case-insensitive trick name per clip, stored trimmed (§1.2.12)", async () => {
    await inRollback(async (tx) => {
      const clipId = await insertClip(tx);
      const insert = (name: string) => (sp: SavepointSQL) =>
        sp`INSERT INTO labels (clip_id, trick_name, taxonomy_version) VALUES (${clipId}, ${name}, 1)`;
      expect(await violation(tx, insert("Cork"))).toBeUndefined();
      expect(await violation(tx, insert("cork"))).toBe("labels_clip_trick_uniq");
      expect(await violation(tx, insert(" hook"))).toBe("labels_trick_name_check");
      expect(await violation(tx, insert(""))).toBe("labels_trick_name_check");
      expect(await violation(tx, insert("hook"))).toBeUndefined();

      const rows = await tx`SELECT trick_name FROM labels WHERE clip_id = ${clipId} ORDER BY trick_name`;
      expect(rows.map((r: { trick_name: string }) => r.trick_name)).toEqual(["Cork", "hook"]);
    });
  });

  test("models: versions are unique and the artifact digest is hex", async () => {
    await inRollback(async (tx) => {
      const insert = (version: string, sha256: string, modelType = "trick-detection") =>
        (sp: SavepointSQL) =>
          sp`INSERT INTO models (version, model_type, taxonomy_version, r2_key, sha256)
             VALUES (${version}, ${modelType}, 1, 'models/m.zip', ${sha256})`;
      expect(await violation(tx, insert("trick-v1.0", DIGEST))).toBeUndefined();
      expect(await violation(tx, insert("trick-v1.0", DIGEST))).toBe("models_version_key");
      expect(await violation(tx, insert("trick-v1.1", "z".repeat(64)))).toBe("models_sha256_check");
      expect(await violation(tx, insert("trick-v1.1", DIGEST, "pose"))).toBe("models_model_type_check");

      const [model] = await tx`SELECT val_metrics, promoted_at FROM models WHERE version = 'trick-v1.0'`;
      expect(model).toEqual({ val_metrics: {}, promoted_at: null });
    });
  });

  test("data_quarantine: one open quarantine per source; resolution set with resolved_at (§1.2.4)", async () => {
    await inRollback(async (tx) => {
      await insertClip(tx);
      const quarantine = (sp: SavepointSQL) =>
        sp`INSERT INTO data_quarantine (source_id, user_id, reason) VALUES (${SOURCE_ID}, 'user-1', 'regression')`;
      expect(await violation(tx, quarantine)).toBeUndefined();
      expect(await violation(tx, quarantine)).toBe("data_quarantine_open_uniq");

      const resolve = (resolvedAt: Date | null, resolution: string | null) => (sp: SavepointSQL) =>
        sp`UPDATE data_quarantine SET resolved_at = ${resolvedAt}, resolution = ${resolution}
           WHERE source_id = ${SOURCE_ID}`;
      expect(await violation(tx, resolve(null, "released"))).toBe("quarantine_resolution_consistent");
      expect(await violation(tx, resolve(new Date(), null))).toBe("quarantine_resolution_consistent");
      expect(await violation(tx, resolve(new Date(), "ignored"))).toBe("data_quarantine_resolution_check");
      expect(await violation(tx, resolve(new Date(), "released"))).toBeUndefined();

      // Once resolved, the source can be quarantined again.
      expect(await violation(tx, quarantine)).toBeUndefined();
    });
  });

  test("reports: target types are constrained and new reports are open", async () => {
    await inRollback(async (tx) => {
      await tx`INSERT INTO users (id) VALUES ('user-1')`;
      const insert = (targetType: string) => (sp: SavepointSQL) =>
        sp`INSERT INTO reports (reporter_user_id, target_type, target_id, reason)
           VALUES ('user-1', ${targetType}, 'x', 'wrong trick name')`;
      expect(await violation(tx, insert("video"))).toBe("reports_target_type_check");
      expect(await violation(tx, insert("clip"))).toBeUndefined();

      const [report] = await tx`SELECT status FROM reports WHERE reporter_user_id = 'user-1'`;
      expect(report.status).toBe("open");
    });
  });

  test("deleting a user cascades to sources, clips, labels, and quarantine rows", async () => {
    await inRollback(async (tx) => {
      const clipId = await insertClip(tx);
      await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version) VALUES (${clipId}, 'cork', 1)`;
      await tx`INSERT INTO data_quarantine (source_id, user_id, reason) VALUES (${SOURCE_ID}, 'user-1', 'regression')`;

      await tx`DELETE FROM users WHERE id = 'user-1'`;

      const [counts] = await tx`
        SELECT (SELECT count(*) FROM sources WHERE id = ${SOURCE_ID})::int                AS sources,
               (SELECT count(*) FROM clips WHERE id = ${clipId})::int                     AS clips,
               (SELECT count(*) FROM labels WHERE clip_id = ${clipId})::int               AS labels,
               (SELECT count(*) FROM data_quarantine WHERE source_id = ${SOURCE_ID})::int AS quarantine`;
      expect(counts).toEqual({ sources: 0, clips: 0, labels: 0, quarantine: 0 });
    });
  });
});
