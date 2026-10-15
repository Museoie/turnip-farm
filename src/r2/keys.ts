// Key conventions (BACKEND_DESIGN.md §1.2.9, §7.3).
// Cross-PR contract with the ingest worker: the presigned upload URL
// from POST /api/sources MUST target the staging key
// `staging/<source_id>.tkp1.gz` — that is the exact key the ingest worker
// polls. The canonical key is deterministic per the design doc.

export const STAGING_PREFIX = "staging/";

export const stagingKeyFor = (sourceId: string): string =>
  `${STAGING_PREFIX}${sourceId}.tkp1.gz`;

export const canonicalKeyFor = (sourceId: string): string =>
  `poses/${sourceId}.tkp1.gz`;
