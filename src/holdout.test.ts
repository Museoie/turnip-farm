// The curated-holdout flag and its maintainer CLI (BACKEND_DESIGN.md
// §1.2.28). DB tests run only when TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { setHoldout, sourceHoldoutCli } from "./holdout";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const SOURCE_ID = "a".repeat(64);
const OTHER_SOURCE = "b".repeat(64);
const PAST = "2026-10-01T00:00:00.000000Z";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function seedSource(tx: TransactionSQL, id: string) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, updated_at)
    VALUES (${id}, ${"f".repeat(64)}, 100, 10.0, ${`poses/${id}.tkp1.gz`}, ${PAST}::timestamptz)`;
}

async function stateOf(tx: TransactionSQL, id: string) {
  const [row] = await tx`SELECT holdout, updated_at > ${PAST}::timestamptz AS touched FROM sources WHERE id = ${id}`;
  return row as { holdout: boolean; touched: boolean };
}

describe("sources:holdout usage", () => {
  const noDatabase = new Proxy({} as SQL, {
    get() {
      throw new Error("the database was queried");
    },
  });
  for (const args of [[], ["--clear"], ["nope"], ["A".repeat(64)], [SOURCE_ID, OTHER_SOURCE], [SOURCE_ID, "--clear", "--clear"]]) {
    test(`usage error for ${JSON.stringify(args)}, before touching the database`, async () => {
      const c = capture();
      expect(await sourceHoldoutCli(args, noDatabase, c.io)).toBe(2);
      expect(c.err[0]).toStartWith("usage:");
    });
  }
});

describeDb("setHoldout", () => {
  test("defaults to false, sets and clears the flag, and moves updated_at only on a change", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedSource(tx, SOURCE_ID);
      await seedSource(tx, OTHER_SOURCE);
      expect(await stateOf(tx, SOURCE_ID)).toEqual({ holdout: false, touched: false });

      expect(await setHoldout(tx, SOURCE_ID, false)).toBe("unchanged");
      expect(await stateOf(tx, SOURCE_ID)).toEqual({ holdout: false, touched: false });

      expect(await setHoldout(tx, SOURCE_ID, true)).toBe("changed");
      expect(await stateOf(tx, SOURCE_ID)).toEqual({ holdout: true, touched: true });
      expect(await stateOf(tx, OTHER_SOURCE)).toEqual({ holdout: false, touched: false });
      expect(await setHoldout(tx, SOURCE_ID, true)).toBe("unchanged");

      expect(await setHoldout(tx, SOURCE_ID, false)).toBe("changed");
      expect((await stateOf(tx, SOURCE_ID)).holdout).toBe(false);
    }));

  test("unknown source", async () =>
    inRollback(sharedSql, async (tx) => {
      expect(await setHoldout(tx, SOURCE_ID, true)).toBe("unknown");
    }));
});

describeDb("sources:holdout CLI", () => {
  test("flags, reports already-flagged, clears with --clear before or after the id", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedSource(tx, SOURCE_ID);
      let c = capture();
      expect(await sourceHoldoutCli([SOURCE_ID], tx, c.io)).toBe(0);
      expect(c.out).toEqual([`Source ${SOURCE_ID} is now holdout.`]);
      expect((await stateOf(tx, SOURCE_ID)).holdout).toBe(true);

      c = capture();
      expect(await sourceHoldoutCli([SOURCE_ID], tx, c.io)).toBe(0);
      expect(c.out).toEqual([`Source ${SOURCE_ID} was already holdout.`]);

      c = capture();
      expect(await sourceHoldoutCli([SOURCE_ID, "--clear"], tx, c.io)).toBe(0);
      expect(c.out).toEqual([`Source ${SOURCE_ID} is now not holdout.`]);
      expect((await stateOf(tx, SOURCE_ID)).holdout).toBe(false);

      c = capture();
      expect(await sourceHoldoutCli(["--clear", SOURCE_ID], tx, c.io)).toBe(0);
      expect(c.out).toEqual([`Source ${SOURCE_ID} was already not holdout.`]);
    }));

  test("exit 1 for an unknown source", async () =>
    inRollback(sharedSql, async (tx) => {
      const c = capture();
      expect(await sourceHoldoutCli([SOURCE_ID], tx, c.io)).toBe(1);
      expect(c.err).toEqual([`No source ${SOURCE_ID}.`]);
    }));
});
