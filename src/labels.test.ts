// Vocabulary-only labels and label candidates, DB-backed (BACKEND_DESIGN.md
// §1.2.25, §7.3). Runs inside a rolled-back transaction per db/testing.ts;
// only runs when TEST_DATABASE_URL names a database.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { deleteAccountData } from "./auth/account";
import { testCandidateKey } from "./auth/testing";
import { sha256Hex } from "./auth/tokens";
import { handlePostClipLabels, handlePostClips } from "./contrib/clips";
import { purgeExpiredAttribution } from "./contrib/purge";
import {
  LABEL_CANDIDATE_TTL_DAYS,
  candidateAccountHash,
  deriveCandidateKey,
  handlePostLabelCandidates,
  handlePostLabelSynonyms,
  labelCandidatesCli,
  labelSynonymsCli,
  mergeLabelsCli,
  normalizeName,
  promoteLabelCli,
} from "./labels";
import { handleGetTaxonomyCurrent } from "./taxonomy";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const VIDEO_ID = "a".repeat(64);
const SOURCE_KEY = "xxx".repeat(14) + "x"; // 43-char fixture, not a secret
const CLIP_ID = "123e4567-e89b-42d3-a456-426614174000";
const BLOB = new TextEncoder().encode("canonical-bytes");

const r2: R2Client = {
  presignPut: () => {
    throw new Error("not used");
  },
  presignGet: () => {
    throw new Error("not used");
  },
  getStream: async () => new Blob([BLOB]).stream(),
  deleteObject: async () => {},
};

function deps(tx: SQL) {
  return {
    sql: tx,
    r2,
    candidateKey: testCandidateKey,
    currentDisclosureVersion: 3,
    limits: { user: new TokenBucket(1000, 60), ip: new TokenBucket(1000, 60), publicIp: new TokenBucket(1000, 60), adminIp: new TokenBucket(1000, 60) },
  };
}

async function seedUser(tx: TransactionSQL, userId: string): Promise<string> {
  await tx`INSERT INTO users (id) VALUES (${userId})`;
  await tx`INSERT INTO consents (user_id, disclosure_version) VALUES (${userId}, 3)`;
  const token = `session-for-${userId}`; // fixture, not a credential
  await tx`INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${sha256Hex(token)}, now() + interval '1 hour')`;
  return token;
}

async function seedSource(tx: TransactionSQL) {
  await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, sha256)
    VALUES (${VIDEO_ID}, ${sha256Hex(SOURCE_KEY)}, 600, 10, ${`poses/${VIDEO_ID}.tkp1.gz`},
            ${new Bun.CryptoHasher("sha256").update(BLOB).digest("hex")})`;
}

const post = (path: string, body: unknown, token: string) =>
  new Request(`http://farm.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const clipsBody = (names: string[]) => ({
  clips: [
    {
      clip_id: CLIP_ID,
      source_id: VIDEO_ID,
      source_key: SOURCE_KEY,
      start_frame: 10,
      end_frame: 30,
      auto_detected: false,
      labels: names.map((name) => ({ name, origin: "typed" })),
    },
  ],
});

async function errorOf(res: Response) {
  const body = (await res.json()) as { error: { code: string; details: unknown } };
  return { status: res.status, code: body.error.code, details: body.error.details };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describeDb("vocabulary-only labels", () => {
  test("POST /api/clips: 422 UNKNOWN_LABEL for a name outside label_taxonomy, nothing written", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await seedSource(tx);
      const res = await handlePostClips(post("/api/clips", clipsBody(["cork", "double leg", "Gainer"]), token), deps(tx));
      expect(await errorOf(res)).toEqual({
        status: 422,
        code: "UNKNOWN_LABEL",
        details: { index: 0, field: "labels", names: ["double leg"] },
      });
      expect(await tx`SELECT 1 FROM clips`).toHaveLength(0);
      expect(await tx`SELECT 1 FROM labels`).toHaveLength(0);

      // Vocabulary names in any case are accepted, at any taxonomy version.
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('btwist', 'btwist', 2)`;
      const ok = await handlePostClips(post("/api/clips", clipsBody(["CORK", "corkscrew", "BTwist"]), token), deps(tx));
      expect(ok.status).toBe(200);
      const stored = await tx`SELECT lower(trick_name) AS n FROM labels ORDER BY 1`;
      expect(stored.map((r: { n: string }) => r.n)).toEqual(["btwist", "cork", "corkscrew"]);
    }));

  test("POST /api/clips/:id/labels: 422 UNKNOWN_LABEL, the clip's labels untouched", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await seedSource(tx);
      expect((await handlePostClips(post("/api/clips", clipsBody(["cork"]), token), deps(tx))).status).toBe(200);
      const res = await handlePostClipLabels(
        post(`/api/clips/${CLIP_ID}/labels`, { source_key: SOURCE_KEY, labels: [{ name: "Raiz", origin: "typed" }] }, token),
        deps(tx),
        CLIP_ID,
      );
      expect(await errorOf(res)).toEqual({
        status: 422,
        code: "UNKNOWN_LABEL",
        details: { field: "labels", names: ["Raiz"] },
      });
      expect((await tx`SELECT trick_name FROM labels`).map((r: { trick_name: string }) => r.trick_name)).toEqual(["cork"]);
    }));
});

describeDb("known names: normalized raw or canonical, at any version", () => {
  test("a canonical with no raw row, a double-spaced name and mixed case are all known", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await seedSource(tx);
      // As `labels:promote raiz "raiz flip"` leaves it: "raiz flip" is only a canonical.
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      const ok = await handlePostClips(post("/api/clips", clipsBody(["Raiz  Flip", " gAiNeR "]), token), deps(tx));
      expect(ok.status).toBe(200);
      // The stored name keeps the user's spelling, trimmed.
      const stored = await tx`SELECT trick_name FROM labels ORDER BY trick_name`;
      expect(stored.map((r: { trick_name: string }) => r.trick_name)).toEqual(["Raiz  Flip", "gAiNeR"]);

      const relabel = await handlePostClipLabels(
        post(
          `/api/clips/${CLIP_ID}/labels`,
          { source_key: SOURCE_KEY, labels: [{ name: "RAIZ FLIP", origin: "vocabulary" }, { name: "cork   screw", origin: "typed" }] },
          token,
        ),
        deps(tx),
        CLIP_ID,
      );
      // "cork   screw" is not "corkscrew": spaces collapse, they don't vanish.
      expect(await errorOf(relabel)).toEqual({
        status: 422,
        code: "UNKNOWN_LABEL",
        details: { field: "labels", names: ["cork   screw"] },
      });
      const fine = await handlePostClipLabels(
        post(`/api/clips/${CLIP_ID}/labels`, { source_key: SOURCE_KEY, labels: [{ name: "raiz\tFLIP", origin: "vocabulary" }] }, token),
        deps(tx),
        CLIP_ID,
      );
      expect(fine.status).toBe(200);
    }));

  test("whitespace is ASCII only: a no-break space is part of the name, so it is unknown", async () =>
    inRollback(sharedSql, async (tx) => {
      expect(normalizeName(" Raiz\t\v\f\r\n Flip ")).toBe("raiz flip");
      expect(normalizeName("raiz\u00a0flip")).toBe("raiz\u00a0flip");
      expect(normalizeName("\u00a0cork\u2003")).toBe("\u00a0cork\u2003");

      const token = await seedUser(tx, "u1");
      await seedSource(tx);
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      for (const name of ["Raiz\u00a0Flip", "cork\u00a0", "\u2003cork"]) {
        const res = await handlePostClips(post("/api/clips", clipsBody([name]), token), deps(tx));
        expect(await errorOf(res)).toEqual({
          status: 422,
          code: "UNKNOWN_LABEL",
          details: { index: 0, field: "labels", names: [name] },
        });
      }
      const ascii = await handlePostClips(post("/api/clips", clipsBody(["Raiz\u000b\fFlip"]), token), deps(tx));
      expect(ascii.status).toBe(200);
    }));

  test("candidates skip known names by the same rule, and collapse whitespace when stored", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      const res = await handlePostLabelCandidates(
        post("/api/labels/candidates", { names: ["Raiz  Flip", "CORK", "Butterfly   Twist", "butterfly twist"] }, token),
        deps(tx),
      );
      expect(res.status).toBe(202);
      const rows = await tx`SELECT name FROM label_candidates`;
      expect(rows.map((r: { name: string }) => r.name)).toEqual(["Butterfly Twist"]);
    }));

  test("labels:promote refuses a name that is already a canonical", async () =>
    inRollback(sharedSql, async (tx) => {
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      expect(await promoteLabelCli(["Raiz  Flip"], tx, capture().io)).toBe(1);
      expect(await promoteLabelCli(["Back   Flip", "Back  Flip"], tx, capture().io)).toBe(0);
      const [row] = await tx`SELECT raw, canonical FROM label_taxonomy WHERE raw LIKE 'back%'`;
      expect(row).toEqual({ raw: "back flip", canonical: "back flip" });
    }));
});

describeDb("POST /api/labels/candidates", () => {
  test("202 stores new names under an HMAC of the account, once per account and name", async () =>
    inRollback(sharedSql, async (tx) => {
      const t1 = await seedUser(tx, "u1");
      const t2 = await seedUser(tx, "u2");
      const d = deps(tx);
      const r1 = await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["Raiz", " raiz ", "cork"] }, t1), d);
      expect(r1.status).toBe(202);
      expect(await r1.text()).toBe("");
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["RAIZ", "butterfly kick"] }, t1), d);
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz"] }, t2), d);

      const rows = await tx`SELECT name, account_hash FROM label_candidates ORDER BY lower(name), account_hash`;
      const h1 = await candidateAccountHash(testCandidateKey, "u1");
      const h2 = await candidateAccountHash(testCandidateKey, "u2");
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(h1).not.toBe(h2);
      // "cork" is already in the vocabulary; Raiz counts once for u1.
      expect(rows.map((r: { name: string; account_hash: string }) => [r.name, r.account_hash])).toEqual(
        [
          ["butterfly kick", h1],
          ["Raiz", h1],
          ["raiz", h2],
        ].sort((a, b) => (a[0]!.toLowerCase() + a[1]! < b[0]!.toLowerCase() + b[1]! ? -1 : 1)),
      );
      expect(JSON.stringify(rows)).not.toContain("u1");
    }));

  test("422 VALIDATION_ERROR on a bad body; 401 without a session", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      for (const body of [
        {},
        { names: [] },
        { names: "raiz" },
        { names: Array.from({ length: 21 }, (_, i) => `n${i}`) },
        { names: [" "] },
        { names: [7] },
        { names: ["x".repeat(65)] },
      ]) {
        const res = await handlePostLabelCandidates(post("/api/labels/candidates", body, token), deps(tx));
        expect((await errorOf(res)).code).toBe("VALIDATION_ERROR");
      }
      expect(await tx`SELECT 1 FROM label_candidates`).toHaveLength(0);
      const anon = await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz"] }, "nope"), deps(tx));
      expect(anon.status).toBe(401);
    }));

  test("candidates expire after the TTL, and go with their account", async () =>
    inRollback(sharedSql, async (tx) => {
      expect(LABEL_CANDIDATE_TTL_DAYS).toBe(30);
      const t1 = await seedUser(tx, "u1");
      const t2 = await seedUser(tx, "u2");
      const d = deps(tx);
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz", "aerial"] }, t1), d);
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["raiz"] }, t2), d);
      await tx`UPDATE label_candidates SET submitted_at = now() - interval '31 days' WHERE name = 'aerial'`;
      await tx`UPDATE label_candidates SET submitted_at = now() - interval '29 days' WHERE name = 'raiz'`;
      await purgeExpiredAttribution(tx);
      expect(await tx`SELECT name FROM label_candidates`).toHaveLength(2);

      await deleteAccountData({ sql: tx, r2, candidateKey: testCandidateKey }, "u1");
      const left = await tx`SELECT account_hash FROM label_candidates`;
      expect(left.map((r: { account_hash: string }) => r.account_hash)).toEqual([
        await candidateAccountHash(testCandidateKey, "u2"),
      ]);
    }));

  test("the HMAC key is derived per secret", async () => {
    const other = await deriveCandidateKey(new Uint8Array(32).fill(1));
    expect(await candidateAccountHash(other, "u1")).not.toBe(await candidateAccountHash(testCandidateKey, "u1"));
  });
});

describeDb("candidate maintainer scripts", () => {
  test("labels:candidates lists names by distinct accounts; labels:promote adds one at a new version", async () =>
    inRollback(sharedSql, async (tx) => {
      const tokens = [await seedUser(tx, "u1"), await seedUser(tx, "u2")];
      for (const t of tokens) {
        await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["Raiz"] }, t), deps(tx));
      }
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["aerial"] }, tokens[0]!), deps(tx));

      const list = capture();
      expect(await labelCandidatesCli([], tx, list.io)).toBe(0);
      expect(list.out).toEqual(["    2  Raiz", "    1  aerial"]);
      const min = capture();
      expect(await labelCandidatesCli(["--min", "2"], tx, min.io)).toBe(0);
      expect(min.out).toEqual(["    2  Raiz"]);
      expect(await labelCandidatesCli(["--bogus"], tx, capture().io)).toBe(2);

      const [{ before }] = await tx`SELECT max(taxonomy_version) AS before FROM label_taxonomy`;
      const promoted = capture();
      expect(await promoteLabelCli(["Raiz"], tx, promoted.io)).toBe(0);
      const [row] = await tx`SELECT canonical, taxonomy_version FROM label_taxonomy WHERE raw = 'raiz'`;
      expect(row).toEqual({ canonical: "raiz", taxonomy_version: before + 1 });
      expect(await tx`SELECT 1 FROM label_candidates WHERE lower(name) = 'raiz'`).toHaveLength(0);
      expect(promoted.out).toEqual([`Promoted "raiz" → "raiz" at taxonomy version ${before + 1}; 2 candidate rows dropped.`]);

      // An alias for an existing canonical, and a refusal for a known name.
      expect(await promoteLabelCli(["Aerial", "aerial cartwheel"], tx, capture().io)).toBe(0);
      const [alias] = await tx`SELECT canonical, taxonomy_version FROM label_taxonomy WHERE raw = 'aerial'`;
      expect(alias).toEqual({ canonical: "aerial cartwheel", taxonomy_version: before + 2 });
      expect(await promoteLabelCli(["cork"], tx, capture().io)).toBe(1);
      expect(await promoteLabelCli([], tx, capture().io)).toBe(2);

      // The promoted name is now accepted on clips.
      await seedSource(tx);
      expect((await handlePostClips(post("/api/clips", clipsBody(["raiz"]), tokens[0]!), deps(tx))).status).toBe(200);
    }));
});

const synonymsBody = (...pairs: [string, string][]) => ({
  synonyms: pairs.map(([name, same_as]) => ({ name, same_as })),
});

async function vocabularyOf(tx: SQL) {
  const res = await handleGetTaxonomyCurrent(new Request("http://farm.test/api/taxonomy/current"), { sql: tx });
  return (await res.json()) as { taxonomy_version: number; vocabulary: { canonical: string; aliases: string[] }[] };
}

describeDb("POST /api/labels/synonyms", () => {
  test("202 stores each pair under an HMAC of the account, once per account and pair", async () =>
    inRollback(sharedSql, async (tx) => {
      const t1 = await seedUser(tx, "u1");
      const t2 = await seedUser(tx, "u2");
      const d = deps(tx);
      const r1 = await handlePostLabelSynonyms(
        post("/api/labels/synonyms", synonymsBody(["Cartwheel  Full Twist", "cartfull"], ["corkscrew", "CORK"]), t1),
        d,
      );
      expect(r1.status).toBe(202);
      expect(await r1.text()).toBe("");
      await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["cartwheel full twist", "Cartfull"]), t1), d);
      await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["cartwheel full twist", "cartfull"]), t2), d);
      // The other direction is a different pair: which name to keep is part of it.
      await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["cartfull", "cartwheel full twist"]), t2), d);

      const rows = await tx`
        SELECT name, same_as, account_hash FROM synonym_candidates ORDER BY lower(name), account_hash`;
      const h1 = await candidateAccountHash(testCandidateKey, "u1");
      const h2 = await candidateAccountHash(testCandidateKey, "u2");
      // corkscrew and cork are already one trick; whitespace is collapsed as stored.
      expect(rows.map((r: { name: string; same_as: string; account_hash: string }) => [r.name, r.same_as, r.account_hash])).toEqual(
        [
          ["cartfull", "cartwheel full twist", h2],
          ["Cartwheel Full Twist", "cartfull", h1],
          ["cartwheel full twist", "cartfull", h2],
        ].sort((a, b) => (a[0]!.toLowerCase() + a[2]! < b[0]!.toLowerCase() + b[2]! ? -1 : 1)),
      );
      expect(JSON.stringify(rows)).not.toContain("u1");
    }));

  test("skips a pair whose names resolve to one trick, through a canonical with no raw row", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      const res = await handlePostLabelSynonyms(
        post("/api/labels/synonyms", synonymsBody(["RAIZ", "raiz  flip"], ["raiz", "butterfly twist"]), token),
        deps(tx),
      );
      expect(res.status).toBe(202);
      const rows = await tx`SELECT name, same_as FROM synonym_candidates`;
      expect(rows.map((r: { name: string; same_as: string }) => [r.name, r.same_as])).toEqual([["raiz", "butterfly twist"]]);
    }));

  test("resolves names as the export does: a canonical only an older version names, and odd spellings", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      // "raiz flip" is a canonical only at version 2; "raiz" maps to itself from version 3.
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version)
        VALUES ('raiz', 'raiz flip', 2), ('raiz', 'raiz', 3), ('Butterfly  Twist', 'btwist', 2), ('btwist', 'btwist', 2)`;
      const res = await handlePostLabelSynonyms(
        post("/api/labels/synonyms", synonymsBody(["butterfly twist", "BTwist"], ["raiz flip", "raiz"]), token),
        deps(tx),
      );
      expect(res.status).toBe(202);
      // butterfly twist and btwist are one trick through a raw spelled with odd spacing; raiz flip
      // still resolves to itself, as the export's canonical fallback has it, so it is not raiz.
      const rows = await tx`SELECT name, same_as FROM synonym_candidates`;
      expect(rows.map((r: { name: string; same_as: string }) => [r.name, r.same_as])).toEqual([["raiz flip", "raiz"]]);

      // A merge into it finds it as a trick, rather than adding it as a new canonical.
      const at = async (version: number) =>
        (await tx`SELECT raw, canonical FROM label_taxonomy WHERE taxonomy_version = ${version} ORDER BY raw`).map(
          (r: { raw: string; canonical: string }) => [r.raw, r.canonical],
        );
      expect(await mergeLabelsCli(["gainer", "raiz flip"], tx, capture().io)).toBe(0);
      expect(await at(4)).toEqual([["gainer", "raiz flip"]]);
      // Merging it on moves it, and every name now under it, forward.
      expect(await mergeLabelsCli(["raiz flip", "raiz"], tx, capture().io)).toBe(0);
      expect(await at(5)).toEqual([
        ["gainer", "raiz"],
        ["raiz flip", "raiz"],
      ]);
      expect(await mergeLabelsCli(["RAIZ FLIP", "raiz"], tx, capture().io)).toBe(1);
    }));

  test("422 VALIDATION_ERROR on a bad body; 401 without a session", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      const cases: [unknown, number | undefined][] = [
        [{}, undefined],
        [{ synonyms: [] }, undefined],
        [{ synonyms: { name: "a", same_as: "b" } }, undefined],
        [{ synonyms: Array.from({ length: 21 }, (_, i) => ({ name: `n${i}`, same_as: "cork" })) }, undefined],
        [{ synonyms: ["cork"] }, 0],
        [{ synonyms: [["cork", "gainer"]] }, 0],
        [{ synonyms: [{ name: "cork" }] }, 0],
        [{ synonyms: [{ name: " ", same_as: "cork" }] }, 0],
        [{ synonyms: [{ name: "cork", same_as: 7 }] }, 0],
        [{ synonyms: [{ name: "x".repeat(65), same_as: "cork" }] }, 0],
        [synonymsBody(["raiz", "gainer"], ["Back  Flip", "back flip"]), 1],
      ];
      for (const [body, index] of cases) {
        const res = await handlePostLabelSynonyms(post("/api/labels/synonyms", body, token), deps(tx));
        expect(await errorOf(res)).toEqual({
          status: 422,
          code: "VALIDATION_ERROR",
          details: index === undefined ? { field: "synonyms" } : { field: "synonyms", index },
        });
      }
      expect(await tx`SELECT 1 FROM synonym_candidates`).toHaveLength(0);
      const anon = await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["raiz", "cork"]), "nope"), deps(tx));
      expect(anon.status).toBe(401);
    }));

  test("synonym candidates expire after the TTL, and go with their account", async () =>
    inRollback(sharedSql, async (tx) => {
      const t1 = await seedUser(tx, "u1");
      const t2 = await seedUser(tx, "u2");
      const d = deps(tx);
      await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["raiz", "cork"], ["aerial", "gainer"]), t1), d);
      await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["raiz", "cork"]), t2), d);
      await tx`UPDATE synonym_candidates SET submitted_at = now() - interval '31 days' WHERE name = 'aerial'`;
      await tx`UPDATE synonym_candidates SET submitted_at = now() - interval '29 days' WHERE name = 'raiz'`;
      await purgeExpiredAttribution(tx);
      expect(await tx`SELECT name FROM synonym_candidates`).toHaveLength(2);

      await deleteAccountData({ sql: tx, r2, candidateKey: testCandidateKey }, "u1");
      const left = await tx`SELECT account_hash FROM synonym_candidates`;
      expect(left.map((r: { account_hash: string }) => r.account_hash)).toEqual([
        await candidateAccountHash(testCandidateKey, "u2"),
      ]);
    }));
});

describeDb("synonym maintainer scripts", () => {
  test("labels:synonyms lists each direction by distinct accounts", async () =>
    inRollback(sharedSql, async (tx) => {
      const tokens = [await seedUser(tx, "u1"), await seedUser(tx, "u2")];
      for (const t of tokens) {
        await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["Cartwheel Full Twist", "cartfull"]), t), deps(tx));
      }
      await handlePostLabelSynonyms(post("/api/labels/synonyms", synonymsBody(["cartfull", "cartwheel full twist"]), tokens[0]!), deps(tx));

      const list = capture();
      expect(await labelSynonymsCli([], tx, list.io)).toBe(0);
      expect(list.out).toEqual(["    2  Cartwheel Full Twist → cartfull", "    1  cartfull → cartwheel full twist"]);
      const min = capture();
      expect(await labelSynonymsCli(["--min", "2"], tx, min.io)).toBe(0);
      expect(min.out).toEqual(["    2  Cartwheel Full Twist → cartfull"]);
      const none = capture();
      expect(await labelSynonymsCli(["--min", "3"], tx, none.io)).toBe(0);
      expect(none.err).toEqual(["No synonym candidates."]);
      expect(await labelSynonymsCli(["--bogus"], tx, capture().io)).toBe(2);
    }));

  test("labels:merge adds a name the vocabulary lacks under a trick, and settles its candidates", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await handlePostLabelCandidates(post("/api/labels/candidates", { names: ["cartwheel full twist"] }, token), deps(tx));
      await handlePostLabelSynonyms(
        post("/api/labels/synonyms", synonymsBody(["cartwheel full twist", "cartfull"], ["cartfull", "Cartwheel Full Twist"]), token),
        deps(tx),
      );
      const [{ before }] = await tx`SELECT max(taxonomy_version) AS before FROM label_taxonomy`;

      const merged = capture();
      expect(await mergeLabelsCli(["Cartwheel  Full Twist", "CARTFULL"], tx, merged.io)).toBe(0);
      expect(merged.out).toEqual([
        `Merged "cartwheel full twist" into "cartfull" at taxonomy version ${before + 1}: ` +
          "1 names remapped; 2 synonym and 1 candidate rows dropped.",
      ]);
      const vocab = await vocabularyOf(tx);
      expect(vocab.taxonomy_version).toBe(before + 1);
      expect(vocab.vocabulary.find((e) => e.canonical === "cartfull")).toEqual({
        canonical: "cartfull",
        aliases: ["cartfull", "cartwheel full twist"],
      });
      expect(await tx`SELECT 1 FROM synonym_candidates`).toHaveLength(0);
      expect(await tx`SELECT 1 FROM label_candidates`).toHaveLength(0);

      // The merged name is now accepted on clips, and a second merge is refused.
      await seedSource(tx);
      expect((await handlePostClips(post("/api/clips", clipsBody(["Cartwheel Full Twist"]), token), deps(tx))).status).toBe(200);
      const again = capture();
      expect(await mergeLabelsCli(["cartfull", "cartwheel full twist"], tx, again.io)).toBe(1);
      expect(again.err).toEqual([`"cartfull" and "cartwheel full twist" are already one trick, "cartfull".`]);
    }));

  test("labels:merge moves every name of a trick forward, to a new canonical when the target is new", async () =>
    inRollback(sharedSql, async (tx) => {
      const token = await seedUser(tx, "u1");
      await handlePostLabelSynonyms(
        post("/api/labels/synonyms", synonymsBody(["gainer", "hook"], ["corkscrew", "screw"]), token),
        deps(tx),
      );
      const [{ before }] = await tx`SELECT max(taxonomy_version) AS before FROM label_taxonomy`;

      expect(await mergeLabelsCli(["corkscrew", "screw"], tx, capture().io)).toBe(0);
      const vocab = await vocabularyOf(tx);
      // The whole cork trick moved, its canonical included, so nothing still lists "cork" as a canonical.
      expect(vocab.vocabulary.map((e) => e.canonical)).toEqual(["cartfull", "gainer", "hook", "scoot", "screw"]);
      expect(vocab.vocabulary.find((e) => e.canonical === "screw")!.aliases).toEqual(["cork", "corkscrew", "screw"]);
      const rows = await tx`SELECT raw, canonical FROM label_taxonomy WHERE taxonomy_version = ${before + 1} ORDER BY raw`;
      expect(rows.map((r: { raw: string; canonical: string }) => [r.raw, r.canonical])).toEqual([
        ["cork", "screw"],
        ["corkscrew", "screw"],
        ["screw", "screw"],
      ]);
      // Only the pair the merge settled is dropped.
      const left = await tx`SELECT name, same_as FROM synonym_candidates`;
      expect(left.map((r: { name: string; same_as: string }) => [r.name, r.same_as])).toEqual([["gainer", "hook"]]);
    }));

  test("labels:merge moves a canonical with no raw row of its own, two known tricks into one", async () =>
    inRollback(sharedSql, async (tx) => {
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES ('raiz', 'raiz flip', 2)`;
      expect(await mergeLabelsCli(["raiz flip", "gainer"], tx, capture().io)).toBe(0);
      const vocab = await vocabularyOf(tx);
      expect(vocab.taxonomy_version).toBe(3);
      expect(vocab.vocabulary.map((e) => e.canonical)).not.toContain("raiz flip");
      expect(vocab.vocabulary.find((e) => e.canonical === "gainer")!.aliases).toEqual(["gainer", "raiz", "raiz flip"]);
    }));

  test("labels:merge usage", async () =>
    inRollback(sharedSql, async (tx) => {
      for (const args of [[], ["cork"], ["cork", "cork "], ["cork", " "], ["cork", "gainer", "hook"], ["x".repeat(65), "cork"]]) {
        const out = capture();
        expect(await mergeLabelsCli(args, tx, out.io)).toBe(2);
        expect(out.err).toEqual(["usage: bun run labels:merge <name> <same_as>"]);
      }
      expect(await tx`SELECT 1 FROM label_taxonomy WHERE taxonomy_version > 1`).toHaveLength(0);
    }));
});
