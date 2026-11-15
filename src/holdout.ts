// The curated holdout (BACKEND_DESIGN.md §1.2.28): the maintainer flags
// their own footage as holdout, and the training export carries the flag
// on every row so turnip-ml evaluates on it and never trains on it. Run
// from scripts/source-holdout.ts against the database directly; nothing
// here is reachable over HTTP.

import type { SQL } from "bun";
import { isVideoId } from "./contrib/validate";
import type { Output } from "./moderation";

// Sets or clears sources.holdout. updated_at moves with it, so the change
// reaches the export's row cursor (§6) like any other source write.
// "unchanged" when the source was already in that state; "unknown" when
// there is no such source.
export async function setHoldout(
  sql: SQL,
  sourceId: string,
  holdout: boolean,
): Promise<"changed" | "unchanged" | "unknown"> {
  const [updated] = await sql`
    UPDATE sources SET holdout = ${holdout}, updated_at = now()
    WHERE id = ${sourceId} AND holdout <> ${holdout}
    RETURNING id`;
  if (updated) return "changed";
  const [existing] = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
  return existing ? "unchanged" : "unknown";
}

// scripts/source-holdout.ts <video_id> [--clear]. Exit status: 0 done (or
// already so), 1 no such source, 2 usage.
export async function sourceHoldoutCli(args: string[], sql: SQL, io: Output): Promise<number> {
  const clear = args.includes("--clear");
  const rest = args.filter((a) => a !== "--clear");
  const [sourceId] = rest;
  if (rest.length !== 1 || args.length - rest.length > 1 || !isVideoId(sourceId)) {
    io.err("usage: bun run sources:holdout <video_id> [--clear]  (64-char lowercase hex)");
    return 2;
  }
  const result = await setHoldout(sql, sourceId, !clear);
  if (result === "unknown") {
    io.err(`No source ${sourceId}.`);
    return 1;
  }
  const state = clear ? "not holdout" : "holdout";
  io.out(result === "changed" ? `Source ${sourceId} is now ${state}.` : `Source ${sourceId} was already ${state}.`);
  return 0;
}
