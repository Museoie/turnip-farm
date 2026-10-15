// 30-day purge (BACKEND_DESIGN.md §1.2.17, §4): contributions stay linked
// to an account for 30 days after the source's last write, then the link
// is deleted; reports are deleted 30 days after they are filed, reviewed
// or not. Runs at startup and hourly from src/index.ts. Every read of
// source_attribution elsewhere also filters the 30-day window, so a late
// purge never extends the link.

import type { SQL } from "bun";

export async function purgeExpiredAttribution(sql: SQL): Promise<void> {
  await sql`DELETE FROM source_attribution WHERE attributed_at < now() - interval '30 days'`;
  await sql`DELETE FROM reports WHERE created_at < now() - interval '30 days'`;
}
