// Request validation for the contribution endpoints (BACKEND_DESIGN.md
// §7.2, §7.3). Pure functions, unit-tested; handlers map `null` results to
// 422 VALIDATION_ERROR (or 404 for key-shaped-but-wrong ownership proofs,
// per the §7.2 ownership-privacy rule).

// Deterministic video_id: 64-char lowercase hex (master plan §1).
export const VIDEO_ID_RE = /^[0-9a-f]{64}$/;
// Source key: 32 random bytes, base64url without padding (§7.2).
export const SOURCE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isVideoId = (s: unknown): s is string =>
  typeof s === "string" && VIDEO_ID_RE.test(s);

export const isSourceKey = (s: unknown): s is string =>
  typeof s === "string" && SOURCE_KEY_RE.test(s);

export const isUuid = (s: unknown): s is string =>
  typeof s === "string" && UUID_RE.test(s);

/** Parses a JSON object body; null when the body is not a JSON object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * Dedupe label names per BACKEND_DESIGN.md §5: trim, drop blanks, collapse
 * case-insensitive duplicates keeping the alphabetically-first casing per
 * group (mirrors DISTINCT ON (lower(trim(name))) ... ORDER BY
 * lower(trim(name)), trim(name)). Order is first-seen, so the response
 * echoes the client's submission order.
 */
export function dedupeLabelNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const groups = new Map<string, { name: string; order: number }>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    const cur = groups.get(key);
    if (cur === undefined) {
      groups.set(key, { name: trimmed, order: groups.size });
    } else if (trimmed < cur.name) {
      groups.set(key, { name: trimmed, order: cur.order });
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => g.name);
}
