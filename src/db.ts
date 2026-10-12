import type { SQL, TransactionSQL } from "bun";

// Runs fn atomically: in a new transaction, or in a savepoint when sql is
// already a transaction (Bun can't nest BEGIN). Tests rely on the latter:
// they run handlers inside a transaction that is rolled back.
export function transaction<T>(sql: SQL, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const outer = sql as Partial<TransactionSQL>;
  return typeof outer.savepoint === "function" ? outer.savepoint(fn) : sql.begin(fn);
}
