// Calls to the admin endpoints (BACKEND_DESIGN.md §7.3). They carry the
// admin session cookie, which the farm sets after a sign-in through the
// auth service (§7.1 "Admin"); the page holds no credential of its own.

export interface AdminClip {
  id: string;
  start_frame: number;
  end_frame: number;
  names: string[];
}

export interface AdminSource {
  id: string;
  created_at: string;
  ingested_at: string | null;
  frame_count: number;
  sample_rate: number;
  ingested: boolean;
  holdout: boolean;
  quarantined: boolean;
  clips: AdminClip[];
}

export interface SourcePage {
  sources: AdminSource[];
  next_cursor: string | null;
}

export type HoldoutFilter = "all" | "true" | "false";

/** A refused or failed admin call. `status` is the HTTP status, 0 for a network failure. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export interface AdminSessionInfo {
  username: string;
  role: string;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    // Same-origin requests carry the session cookie; the browser adds the
    // Origin header the farm checks on writes.
    res = await fetch(path, {
      method,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new AdminError(0, null, "The farm could not be reached.");
  }
  if (res.ok) return res;
  let code: string | null = null;
  let message = `Request failed (HTTP ${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // A non-JSON body (a proxy error page) keeps the generic message.
  }
  throw new AdminError(res.status, code, message);
}

export async function getSession(): Promise<AdminSessionInfo> {
  const res = await call("GET", "/api/admin/session");
  return (await res.json()) as AdminSessionInfo;
}

export async function listSources(filter: HoldoutFilter, cursor: string | null): Promise<SourcePage> {
  const params = new URLSearchParams({ holdout: filter });
  if (cursor !== null) params.set("cursor", cursor);
  const res = await call("GET", `/api/admin/sources?${params}`);
  return (await res.json()) as SourcePage;
}

export async function setHoldout(sourceId: string, holdout: boolean): Promise<void> {
  await call(holdout ? "PUT" : "DELETE", `/api/admin/sources/${sourceId}/holdout`);
}

export async function fetchPoseBlob(sourceId: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await call("GET", `/api/admin/sources/${sourceId}/pose`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The first 12 hex characters of a video id. */
export function shortId(id: string): string {
  return id.slice(0, 12);
}

/** Two names an app user marked as one trick, as GET /api/admin/synonyms lists them (§1.2.29). */
export interface SynonymCandidate {
  name: string;
  same_as: string;
  accounts: number;
  /** The canonical each name resolves to now; null for a name the vocabulary lacks. */
  name_canonical: string | null;
  same_as_canonical: string | null;
  first_submitted_at: string;
}

/** What POST /api/admin/merges did. */
export type MergeOutcome =
  | { merged: false; name: string; canonical: string }
  | {
      merged: true;
      name: string;
      canonical: string;
      taxonomy_version: number;
      remapped: number;
      synonyms_dropped: number;
      candidates_dropped: number;
    };

export interface VocabularyEntry {
  canonical: string;
  aliases: string[];
}

export interface Vocabulary {
  taxonomy_version: number;
  vocabulary: VocabularyEntry[];
}

export interface SynonymList {
  synonyms: SynonymCandidate[];
  /** More pairs meet `min` than the list holds: the ones most accounts sent are listed. */
  truncated: boolean;
}

export async function listSynonyms(min: number): Promise<SynonymList> {
  const res = await call("GET", `/api/admin/synonyms?${new URLSearchParams({ min: String(min) })}`);
  return (await res.json()) as SynonymList;
}

/** Folds the trick `name` names into the trick `sameAs` names, keeping `sameAs`'s canonical. */
export async function mergeTricks(name: string, sameAs: string): Promise<MergeOutcome> {
  const res = await call("POST", "/api/admin/merges", { name, same_as: sameAs });
  return (await res.json()) as MergeOutcome;
}

/** The farm's current vocabulary: the public GET /api/taxonomy/current, read fresh. */
export async function getVocabulary(): Promise<Vocabulary> {
  const res = await call("GET", "/api/taxonomy/current");
  return (await res.json()) as Vocabulary;
}
