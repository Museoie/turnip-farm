// Deletes the blobs training segments left in R2 (BACKEND_DESIGN.md
// §1.2.24, removed). The migration that deleted the segment rows can't
// reach R2, so `bun run segments:purge-blobs` lists the segments/ prefix
// and deletes what it finds. Listing by prefix, not by row, finds every
// blob whether or not its row still existed, and a re-run after a failure
// picks up where the last one stopped.

import type { BlobStore } from "./store";

export const SEGMENT_PREFIX = "segments/";

// segments/<uuid>.tks1.gz, the only key shape the segmenter wrote. Any
// other key under the prefix is left alone and reported.
const SEGMENT_KEY = /^segments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tks1\.gz$/;

export async function purgeSegmentBlobs(
  store: BlobStore,
  out: (line: string) => void,
): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0;
  let skipped = 0;
  for await (const page of store.listPages(SEGMENT_PREFIX)) {
    for (const key of page) {
      if (!SEGMENT_KEY.test(key)) {
        out(`skipped ${key}: not a segment blob key`);
        skipped++;
        continue;
      }
      await store.delete(key);
      deleted++;
    }
  }
  out(`deleted ${deleted} segment blob(s), skipped ${skipped}`);
  return { deleted, skipped };
}
