// Vocabulary-only labels (BACKEND_DESIGN.md §1.2.25, §7.3).
// Clip writes accept only names in label_taxonomy (422 UNKNOWN_LABEL), so
// no free text reaches `labels`. A name the vocabulary lacks goes to
// POST /api/labels/candidates instead: kept for LABEL_CANDIDATE_TTL_DAYS,
// counted per account by an HMAC of the account id under a server key, and
// promoted into the taxonomy by the maintainer (scripts/promote-label.ts).
// Two names an app user marks as one trick go to POST /api/labels/synonyms
// (§1.2.29), kept the same way, and the maintainer merges them
// (scripts/merge-labels.ts).

import type { SQL } from "bun";
import type { RateLimits } from "./app";
import { transaction } from "./db";
import { authenticateClient } from "./auth/sessions";
import { ASCII_WHITESPACE_RUN, readJsonObject, trimAsciiWhitespace } from "./contrib/validate";
import { errorResponse } from "./errors";
import type { Output } from "./moderation";

/** Candidate names expire this long after an account first submits them (judgment call). */
export const LABEL_CANDIDATE_TTL_DAYS = 30;
/** Most names one POST /api/labels/candidates may carry. */
export const MAX_CANDIDATES_PER_REQUEST = 20;
/** Longest candidate name, in characters after trimming. */
export const MAX_CANDIDATE_LENGTH = 64;
/** Most pairs one POST /api/labels/synonyms may carry. */
export const MAX_SYNONYMS_PER_REQUEST = 20;

/**
 * A label name's comparison form, shared with the app (turnip-ios #314):
 * trimmed, runs of whitespace collapsed to one space, lowercased, where
 * whitespace is ASCII only (space, \t \n \v \f \r). Two names
 * are the same vocabulary entry when their normalized forms are equal.
 * The export resolves stored names with the same rule in SQL (src/export.ts).
 */
export function normalizeName(name: string): string {
  return trimAsciiWhitespace(name).replace(ASCII_WHITESPACE_RUN, " ").toLowerCase();
}

/**
 * The vocabulary, normalized: every raw string and every canonical name in
 * label_taxonomy, at any version. A canonical counts even with no raw row
 * of its own (`labels:promote raiz "raiz flip"`), since the app lists it.
 */
export async function vocabulary(sql: SQL): Promise<Set<string>> {
  const rows = (await sql`
    SELECT raw AS name FROM label_taxonomy
    UNION
    SELECT canonical FROM label_taxonomy`) as { name: string }[];
  return new Set(rows.map((r) => normalizeName(r.name)));
}

/** A raw name and the canonical it resolves to now, both as stored. */
interface Mapping {
  raw: string;
  canonical: string;
}

/**
 * The vocabulary as it stands, resolved as the export resolves a label
 * name (§6, src/export.ts): each normalized raw through its
 * greatest-version mapping (§3 "renames resolve forward"), and each
 * normalized canonical at any version that no raw spells, mapped to
 * itself, as the export's fallback reaches it. One entry per normalized
 * name, so `resolver` matches `COALESCE(raw_map, canonical_map)`.
 */
async function currentMappings(sql: SQL): Promise<Mapping[]> {
  const rows = (await sql`
    SELECT raw, canonical FROM label_taxonomy ORDER BY taxonomy_version DESC, raw`) as Mapping[];
  const byRaw = new Map<string, Mapping>();
  const canonicals = new Map<string, string>();
  for (const row of rows) {
    const rawKey = normalizeName(row.raw);
    if (!byRaw.has(rawKey)) byRaw.set(rawKey, row);
    const canonicalKey = normalizeName(row.canonical);
    if (!canonicals.has(canonicalKey)) canonicals.set(canonicalKey, row.canonical);
  }
  const canonicalOnly = [...canonicals]
    .filter(([key]) => !byRaw.has(key))
    .map(([, canonical]) => ({ raw: canonical, canonical }));
  return [...byRaw.values(), ...canonicalOnly];
}

/** Normalized name → the normalized canonical it resolves to now. */
function resolver(mappings: readonly Mapping[]): Map<string, string> {
  return new Map(mappings.map((m) => [normalizeName(m.raw), normalizeName(m.canonical)]));
}

/**
 * A candidate name as sent: trimmed of ASCII whitespace with inner runs
 * collapsed to one space, so "back  flip" and "back flip" count as one
 * name. `null` when not a string, blank, or longer than MAX_CANDIDATE_LENGTH.
 */
function readCandidateName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = trimAsciiWhitespace(value).replace(ASCII_WHITESPACE_RUN, " ");
  return name === "" || name.length > MAX_CANDIDATE_LENGTH ? null : name;
}

/** The names, in order and without duplicates, whose normalized form the vocabulary lacks. */
export function unknownNames(vocab: Set<string>, names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => !vocab.has(normalizeName(n))))];
}

export function unknownLabelResponse(names: string[], details: Record<string, unknown> = {}): Response {
  return errorResponse(422, "UNKNOWN_LABEL", `Not in the vocabulary: ${names.join(", ")}`, {
    details: { ...details, field: "labels", names },
  });
}

/**
 * The HMAC key for candidate counts, derived from the 32-byte
 * APPLE_REFRESH_TOKEN_KEY with HKDF-SHA-256 under its own label, so the farm
 * needs no second secret and the two uses never share a key.
 */
export async function deriveCandidateKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("turnip-farm label candidates v1"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** Lowercase hex HMAC-SHA-256 of the account id: the only account trace on a candidate. */
export async function candidateAccountHash(key: CryptoKey, userId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return Buffer.from(mac).toString("hex");
}

export interface CandidatesDeps {
  sql: SQL;
  limits: RateLimits;
  candidateKey: CryptoKey;
}

// POST /api/labels/candidates {"names": [string]} → 202.
export async function handlePostLabelCandidates(req: Request, deps: CandidatesDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  if (!deps.limits.user.take(auth.userId)) {
    return errorResponse(429, "RATE_LIMITED", "Too many requests", {
      headers: { "Retry-After": String(deps.limits.user.retryAfterSec(auth.userId)) },
    });
  }

  const body = await readJsonObject(req);
  const raw = body?.names;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CANDIDATES_PER_REQUEST) {
    return errorResponse(422, "VALIDATION_ERROR", `names must be an array of 1 to ${MAX_CANDIDATES_PER_REQUEST} strings`, {
      details: { field: "names" },
    });
  }
  const names: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const name = readCandidateName(raw[i]);
    if (name === null) {
      return errorResponse(422, "VALIDATION_ERROR", `names[${i}] must be a non-empty string of at most ${MAX_CANDIDATE_LENGTH} characters`, {
        details: { field: "names", index: i },
      });
    }
    names.push(name);
  }

  // A name already in the vocabulary needs no candidate.
  const fresh = unknownNames(await vocabulary(deps.sql), names);
  const accountHash = await candidateAccountHash(deps.candidateKey, auth.userId);
  for (const name of fresh) {
    await deps.sql`
      INSERT INTO label_candidates (name, account_hash)
      VALUES (${name}, ${accountHash})
      ON CONFLICT (lower(name), account_hash) DO NOTHING`;
  }
  return new Response(null, { status: 202 });
}

// POST /api/labels/synonyms {"synonyms": [{"name": string, "same_as": string}]} → 202.
export async function handlePostLabelSynonyms(req: Request, deps: CandidatesDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps);
  if (auth instanceof Response) return auth;
  if (!deps.limits.user.take(auth.userId)) {
    return errorResponse(429, "RATE_LIMITED", "Too many requests", {
      headers: { "Retry-After": String(deps.limits.user.retryAfterSec(auth.userId)) },
    });
  }

  const body = await readJsonObject(req);
  const raw = body?.synonyms;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SYNONYMS_PER_REQUEST) {
    return errorResponse(
      422,
      "VALIDATION_ERROR",
      `synonyms must be an array of 1 to ${MAX_SYNONYMS_PER_REQUEST} {name, same_as} objects`,
      { details: { field: "synonyms" } },
    );
  }
  const pairs: { name: string; sameAs: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const object = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const name = readCandidateName(object.name);
    const sameAs = readCandidateName(object.same_as);
    if (name === null || sameAs === null || normalizeName(name) === normalizeName(sameAs)) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        `synonyms[${i}] must have two different names of 1 to ${MAX_CANDIDATE_LENGTH} characters`,
        { details: { field: "synonyms", index: i } },
      );
    }
    pairs.push({ name, sameAs });
  }

  // A pair the vocabulary already resolves to one trick needs no candidate.
  const resolve = resolver(await currentMappings(deps.sql));
  const accountHash = await candidateAccountHash(deps.candidateKey, auth.userId);
  for (const { name, sameAs } of pairs) {
    const trick = resolve.get(normalizeName(name));
    if (trick !== undefined && trick === resolve.get(normalizeName(sameAs))) continue;
    await deps.sql`
      INSERT INTO synonym_candidates (name, same_as, account_hash)
      VALUES (${name}, ${sameAs}, ${accountHash})
      ON CONFLICT (lower(name), lower(same_as), account_hash) DO NOTHING`;
  }
  return new Response(null, { status: 202 });
}

/** Deletes an account's candidate names and synonyms (account deletion, §7.3). */
export async function deleteAccountCandidates(sql: SQL, key: CryptoKey, userId: string): Promise<void> {
  const accountHash = await candidateAccountHash(key, userId);
  await sql`DELETE FROM label_candidates WHERE account_hash = ${accountHash}`;
  await sql`DELETE FROM synonym_candidates WHERE account_hash = ${accountHash}`;
}

// scripts/label-candidates.ts [--min N]: the open candidates, most-submitted
// first, as "<accounts>  <name>". Exit status: 0, or 2 for usage.
export async function labelCandidatesCli(args: string[], sql: SQL, io: Output): Promise<number> {
  let min = 1;
  if (args.length === 2 && args[0] === "--min" && /^\d+$/.test(args[1]!)) min = Number(args[1]);
  else if (args.length !== 0) {
    io.err("usage: bun run labels:candidates [--min N]");
    return 2;
  }
  const rows = (await sql`
    SELECT min(name) AS name, count(DISTINCT account_hash)::int AS accounts
    FROM label_candidates
    GROUP BY lower(name)
    HAVING count(DISTINCT account_hash) >= ${min}
    ORDER BY accounts DESC, lower(name)`) as { name: string; accounts: number }[];
  for (const r of rows) io.out(`${String(r.accounts).padStart(5)}  ${r.name}`);
  if (rows.length === 0) io.err("No candidates.");
  return 0;
}

// scripts/promote-label.ts <name> [<canonical>]: adds the name to the
// taxonomy at a new version (canonical defaults to the name itself) and
// drops its candidates. Exit status: 0 promoted, 1 already in the
// vocabulary, 2 usage.
export async function promoteLabelCli(args: string[], sql: SQL, io: Output): Promise<number> {
  const [rawArg, canonicalArg] = args;
  const raw = normalizeName(rawArg ?? "");
  const canonical = normalizeName(canonicalArg ?? rawArg ?? "");
  if (args.length < 1 || args.length > 2 || raw === "" || canonical === "" || raw.length > MAX_CANDIDATE_LENGTH) {
    io.err("usage: bun run labels:promote <name> [<canonical>]");
    return 2;
  }
  return transaction(sql, async (tx) => {
    if ((await vocabulary(tx)).has(raw)) {
      io.err(`"${raw}" is already in the vocabulary.`);
      return 1;
    }
    // Serialize version bumps: two promotions must not both claim max + 1.
    await tx`LOCK TABLE label_taxonomy IN SHARE ROW EXCLUSIVE MODE`;
    const [{ version }] = await tx`SELECT max(taxonomy_version) + 1 AS version FROM label_taxonomy`;
    await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES (${raw}, ${canonical}, ${version})`;
    const dropped = await tx`DELETE FROM label_candidates WHERE lower(name) = ${raw} RETURNING 1`;
    io.out(`Promoted "${raw}" → "${canonical}" at taxonomy version ${version}; ${dropped.length} candidate rows dropped.`);
    return 0;
  });
}

// scripts/label-synonyms.ts [--min N]: the open synonym candidates, the
// pairs most accounts sent first, as "<accounts>  <name> → <same_as>".
// Each direction is its own line: which name to keep is part of what was
// sent. Exit status: 0, or 2 for usage.
export async function labelSynonymsCli(args: string[], sql: SQL, io: Output): Promise<number> {
  let min = 1;
  if (args.length === 2 && args[0] === "--min" && /^\d+$/.test(args[1]!)) min = Number(args[1]);
  else if (args.length !== 0) {
    io.err("usage: bun run labels:synonyms [--min N]");
    return 2;
  }
  const rows = (await sql`
    SELECT min(name) AS name, min(same_as) AS same_as, count(DISTINCT account_hash)::int AS accounts
    FROM synonym_candidates
    GROUP BY lower(name), lower(same_as)
    HAVING count(DISTINCT account_hash) >= ${min}
    ORDER BY accounts DESC, lower(name), lower(same_as)`) as { name: string; same_as: string; accounts: number }[];
  for (const r of rows) io.out(`${String(r.accounts).padStart(5)}  ${r.name} → ${r.same_as}`);
  if (rows.length === 0) io.err("No synonym candidates.");
  return 0;
}

// scripts/merge-labels.ts <name> <same_as>: makes the trick <name> names
// part of the trick <same_as> names, at a new taxonomy version. Every raw
// that resolves to <name>'s canonical (the canonical itself included) is
// remapped to <same_as>'s canonical, as a rename is (§3 "renames resolve
// forward"); a name the vocabulary lacks is added under it, and a <same_as>
// it lacks becomes a canonical of its own. Then the candidates the merge
// settles are dropped: names now in the vocabulary, and pairs now one
// trick. Exit status: 0 merged, 1 already one trick, 2 usage.
export async function mergeLabelsCli(args: string[], sql: SQL, io: Output): Promise<number> {
  const name = normalizeName(args[0] ?? "");
  const into = normalizeName(args[1] ?? "");
  if (
    args.length !== 2 || name === "" || into === "" || name === into ||
    name.length > MAX_CANDIDATE_LENGTH || into.length > MAX_CANDIDATE_LENGTH
  ) {
    io.err("usage: bun run labels:merge <name> <same_as>");
    return 2;
  }
  return transaction(sql, async (tx) => {
    // Serialize version bumps, as labels:promote does.
    await tx`LOCK TABLE label_taxonomy IN SHARE ROW EXCLUSIVE MODE`;
    const mappings = await currentMappings(tx);
    const resolve = resolver(mappings);
    const target = resolve.get(into);
    const targetCanonical = target === undefined
      ? into
      : mappings.find((m) => normalizeName(m.canonical) === target)!.canonical;
    const source = resolve.get(name);
    if (source !== undefined && source === target) {
      io.err(`"${name}" and "${into}" are already one trick, "${targetCanonical}".`);
      return 1;
    }
    const moved = source === undefined
      ? [name]
      : mappings.filter((m) => normalizeName(m.canonical) === source).map((m) => m.raw);
    const added = target === undefined ? [into] : [];
    const [{ version }] = await tx`SELECT max(taxonomy_version) + 1 AS version FROM label_taxonomy`;
    for (const raw of moved) {
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES (${raw}, ${targetCanonical}, ${version})`;
    }
    for (const raw of added) {
      await tx`INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES (${raw}, ${raw}, ${version})`;
    }

    let candidates = 0;
    for (const raw of [...moved, ...added]) {
      candidates += (await tx`DELETE FROM label_candidates WHERE lower(name) = ${normalizeName(raw)} RETURNING 1`).length;
    }
    const after = resolver(await currentMappings(tx));
    const pairs = (await tx`
      SELECT DISTINCT lower(name) AS name, lower(same_as) AS same_as FROM synonym_candidates`) as { name: string; same_as: string }[];
    let synonyms = 0;
    for (const pair of pairs) {
      const trick = after.get(normalizeName(pair.name));
      if (trick === undefined || trick !== after.get(normalizeName(pair.same_as))) continue;
      synonyms += (await tx`
        DELETE FROM synonym_candidates
        WHERE lower(name) = ${pair.name} AND lower(same_as) = ${pair.same_as}
        RETURNING 1`).length;
    }
    io.out(
      `Merged "${name}" into "${targetCanonical}" at taxonomy version ${version}: ` +
        `${moved.length} names remapped; ${synonyms} synonym and ${candidates} candidate rows dropped.`,
    );
    return 0;
  });
}
