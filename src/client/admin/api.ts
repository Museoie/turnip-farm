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

async function call(method: string, path: string): Promise<Response> {
  let res: Response;
  try {
    // Same-origin requests carry the session cookie; the browser adds the
    // Origin header the farm checks on writes.
    res = await fetch(path, {
      method,
      headers: { Accept: "application/json" },
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
