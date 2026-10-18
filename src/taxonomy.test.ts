// Public vocabulary (BACKEND_DESIGN.md §7.3; issue #32).
// buildVocabulary is pure; the handler is tested with a stub sql, plus a
// DB-backed round trip (rolled back per db/testing.ts) that runs only when
// TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import {
  buildVocabulary,
  handleGetTaxonomyCurrent,
  type TaxonomyDeps,
} from "./taxonomy";

// The version-1 seed rows (db/migrations/20261011043548_seed_label_taxonomy_v1.sql).
const V1 = [
  { raw: "cork", canonical: "cork", taxonomy_version: 1 },
  { raw: "corkscrew", canonical: "cork", taxonomy_version: 1 },
  { raw: "gainer", canonical: "gainer", taxonomy_version: 1 },
  { raw: "cartfull", canonical: "cartfull", taxonomy_version: 1 },
  { raw: "hook", canonical: "hook", taxonomy_version: 1 },
  { raw: "scoot", canonical: "scoot", taxonomy_version: 1 },
];

describe("buildVocabulary", () => {
  test("groups raws by canonical; entries and aliases sort ascending", () => {
    expect(buildVocabulary(V1)).toEqual([
      { canonical: "cartfull", aliases: ["cartfull"] },
      { canonical: "cork", aliases: ["cork", "corkscrew"] },
      { canonical: "gainer", aliases: ["gainer"] },
      { canonical: "hook", aliases: ["hook"] },
      { canonical: "scoot", aliases: ["scoot"] },
    ]);
  });

  test("a renamed canonical lists its old name as an alias, not as an entry", () => {
    // §3's rename: cartfull -> "cart full" at version 5. The handler's
    // query resolves each raw through its greatest-version mapping first;
    // assembly then groups by canonical.
    const resolved = [
      { raw: "cartfull", canonical: "cart full", taxonomy_version: 5 },
      { raw: "cart full", canonical: "cart full", taxonomy_version: 5 },
    ];
    const vocab = buildVocabulary(resolved);
    expect(vocab).toEqual([{ canonical: "cart full", aliases: ["cart full", "cartfull"] }]);
  });
});

describe("handleGetTaxonomyCurrent", () => {
  const stubSql = (rows: unknown[]) => (async () => rows) as unknown as SQL;
  const get = (headers: Record<string, string> = {}) =>
    new Request("http://farm.test/api/taxonomy/current", { method: "GET", headers });
  const bodyJson = async (res: Response): Promise<any> => res.json();

  test("200 with the current version, the vocabulary, ETag and Cache-Control", async () => {
    const res = await handleGetTaxonomyCurrent(get(), { sql: stubSql(V1) });
    expect(res.status).toBe(200);
    const body = await bodyJson(res);
    expect(body.taxonomy_version).toBe(1);
    expect(body.vocabulary).toContainEqual({ canonical: "cork", aliases: ["cork", "corkscrew"] });
    expect(body.vocabulary).toHaveLength(5);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
  });

  test("version is the max taxonomy_version over the resolved mappings", async () => {
    const res = await handleGetTaxonomyCurrent(get(), {
      sql: stubSql([
        { raw: "cork", canonical: "cork", taxonomy_version: 1 },
        { raw: "cork", canonical: "corked", taxonomy_version: 2 },
      ]),
    });
    const body = await bodyJson(res);
    expect(body.taxonomy_version).toBe(2);
    expect(res.headers.get("ETag")).toBe('"2"');
  });

  test("public: a session-bearing request is served, not tied to an account", async () => {
    const res = await handleGetTaxonomyCurrent(get({ authorization: "Bearer <redacted>" }), {
      sql: stubSql(V1),
    });
    expect(res.status).toBe(200);
  });
});

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : undefined;
afterAll(async () => {
  await sharedSql?.end();
});

describeDb("GET /api/taxonomy/current (database)", () => {
  const deps = (tx: TransactionSQL): TaxonomyDeps => ({ sql: tx as unknown as SQL });
  const bodyJson = async (res: Response): Promise<any> => res.json();
  const get = () => new Request("http://farm.test/api/taxonomy/current", { method: "GET" });

  test("seed v1 vocabulary: cork lists corkscrew as an alias", async () => {
    await inRollback(sharedSql!, async (tx) => {
      const res = await handleGetTaxonomyCurrent(get(), deps(tx));
      expect(res.status).toBe(200);
      const body = await bodyJson(res);
      expect(body.taxonomy_version).toBe(1);
      expect(body.vocabulary).toContainEqual({
        canonical: "cork",
        aliases: ["cork", "corkscrew"],
      });
    });
  });

  test("rename resolves forward through the greatest-version mapping", async () => {
    await inRollback(sharedSql!, async (tx) => {
      // §3's rename shape: cartfull -> "cart full" at version 5.
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES
        ('cartfull', 'cart full', 5), ('cart full', 'cart full', 5)`;
      const res = await handleGetTaxonomyCurrent(get(), deps(tx));
      const body = await bodyJson(res);
      expect(body.taxonomy_version).toBe(5);
      expect(body.vocabulary).toContainEqual({
        canonical: "cart full",
        aliases: ["cart full", "cartfull"],
      });
      expect(body.vocabulary.find((e: { canonical: string }) => e.canonical === "cartfull")).toBeUndefined();
    });
  });
});
