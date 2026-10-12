// Helpers for tests that need a migrated database. Those tests run only when
// TEST_DATABASE_URL names one — never DATABASE_URL, which Bun loads from a
// developer's .env — and every test runs in a transaction that is rolled
// back, so the database is left as it was found.

import type { SQL, TransactionSQL } from "bun";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set in CI; the database tests would silently skip");
}

class Rollback extends Error {}

export async function inRollback(sql: SQL, fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}
