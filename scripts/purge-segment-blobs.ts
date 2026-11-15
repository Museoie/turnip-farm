// Deletes every training-segment blob under segments/ in R2
// (BACKEND_DESIGN.md §1.2.24, removed). Run once after deploying the
// migration that deleted the segment rows; safe to re-run.
//
//   bun run segments:purge-blobs
//
// Needs only the R2_* variables (Bun loads .env), not the database.

import { R2BlobStore } from "../src/ingest/store";
import { purgeSegmentBlobs } from "../src/ingest/segment-blobs";

const names = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const missing = names.filter((n) => !process.env[n]);
if (missing.length > 0) {
  console.error(`missing ${missing.join(", ")}`);
  process.exit(2);
}
const store = new R2BlobStore({
  accountId: process.env.R2_ACCOUNT_ID!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: process.env.R2_BUCKET!,
});
try {
  await purgeSegmentBlobs(store, (line) => console.log(line));
} catch (err) {
  console.error("purging segment blobs failed; re-run to continue:", err);
  process.exit(1);
}
