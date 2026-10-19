// Public vocabulary (BACKEND_DESIGN.md §7.3; issue #32).
// GET /api/taxonomy/current — the farm's current vocabulary, independent of
// any model, so the app can suggest and group names before the first
// promotion and pick up curation between promotions. Public: no session
// (§7.1, §1.2.19); a session-bearing request is not tied to an account.
// The per-IP rate limit (suggested 30/min, §7.2) is applied in
// startServer's fetch wrapper next to the other per-IP buckets. Served
// with an ETag of the taxonomy_version and Cache-Control: max-age=3600.
// Always 200: the seed migration defines version 1.

import type { SQL } from "bun";

export interface TaxonomyDeps {
  sql: SQL;
}

export interface VocabularyEntry {
  canonical: string;
  aliases: string[];
}

interface TaxonomyRow {
  raw: string;
  canonical: string;
  taxonomy_version: number;
}

/**
 * Assemble the vocabulary from greatest-version taxonomy mappings, one
 * row per raw string. Each raw resolves through its greatest
 * taxonomy_version mapping (§3 "renames resolve forward": a rename adds,
 * at the new version, a row for every raw that mapped to the old canonical
 * pointing at the new one), then raws group by canonical. Entries and
 * aliases sort ascending, so the body is deterministic.
 */
export function buildVocabulary(rows: TaxonomyRow[]): VocabularyEntry[] {
  const byCanonical = new Map<string, string[]>();
  for (const { raw, canonical } of rows) {
    const aliases = byCanonical.get(canonical);
    if (aliases) aliases.push(raw);
    else byCanonical.set(canonical, [raw]);
  }
  return [...byCanonical.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([canonical, aliases]) => ({ canonical, aliases: aliases.sort() }));
}

// GET /api/taxonomy/current — the current vocabulary.
export async function handleGetTaxonomyCurrent(
  _req: Request,
  deps: TaxonomyDeps,
): Promise<Response> {
  // One query: the greatest-version mapping per raw. The current version
  // is the max over them — every table row belongs to some raw, so the max
  // over greatest-version rows is the max over the table (§1.2.8).
  const rows = (await deps.sql`
    SELECT raw, canonical, taxonomy_version
    FROM (
      SELECT DISTINCT ON (raw) raw, canonical, taxonomy_version
      FROM label_taxonomy
      ORDER BY raw, taxonomy_version DESC
    ) AS resolved
    ORDER BY raw ASC`) as TaxonomyRow[];

  // The seed migration defines version 1, so the table is never empty (§7.3).
  const version = Math.max(...rows.map((r) => r.taxonomy_version));
  return Response.json(
    { taxonomy_version: version, vocabulary: buildVocabulary(rows) },
    { headers: { ETag: `"${version}"`, "Cache-Control": "max-age=3600" } },
  );
}
