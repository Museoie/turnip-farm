// The one-off purge of training-segment blobs (BACKEND_DESIGN.md §1.2.24,
// removed), against an in-memory BlobStore.

import { describe, expect, test } from "bun:test";
import { purgeSegmentBlobs, SEGMENT_PREFIX } from "./segment-blobs";
import type { BlobStore, StoredObject } from "./store";

const seg = (i: number) => `segments/123e4567-e89b-42d3-a456-42661417${String(i).padStart(4, "0")}.tks1.gz`;

class PagedStore implements BlobStore {
  readonly deleted: string[] = [];
  readonly listed: string[] = [];
  constructor(
    private readonly keys: string[],
    private readonly pageSize: number,
    private readonly failOn?: string,
  ) {}
  async get(): Promise<StoredObject | null> {
    return null;
  }
  async put(): Promise<void> {}
  async delete(key: string): Promise<void> {
    if (key === this.failOn) throw new Error("R2 down");
    this.deleted.push(key);
  }
  async *listPages(prefix: string): AsyncIterable<string[]> {
    this.listed.push(prefix);
    const matching = this.keys.filter((k) => k.startsWith(prefix));
    for (let i = 0; i < matching.length; i += this.pageSize) yield matching.slice(i, i + this.pageSize);
  }
}

describe("purgeSegmentBlobs", () => {
  test("deletes every segment blob across pages, and only under segments/", async () => {
    const keys = [seg(1), seg(2), seg(3), seg(4), seg(5), "poses/" + "a".repeat(64) + ".tkp1.gz"];
    const store = new PagedStore(keys, 2);
    const lines: string[] = [];
    expect(await purgeSegmentBlobs(store, (l) => lines.push(l))).toEqual({ deleted: 5, skipped: 0 });
    expect(store.listed).toEqual([SEGMENT_PREFIX]);
    expect(store.deleted).toEqual([seg(1), seg(2), seg(3), seg(4), seg(5)]);
    expect(lines).toEqual(["deleted 5 segment blob(s), skipped 0"]);
  });

  test("leaves a key that isn't a segment blob's shape and reports it", async () => {
    const odd = "segments/notes.txt";
    const store = new PagedStore([seg(1), odd, `${seg(2)}.bak`], 10);
    const lines: string[] = [];
    expect(await purgeSegmentBlobs(store, (l) => lines.push(l))).toEqual({ deleted: 1, skipped: 2 });
    expect(store.deleted).toEqual([seg(1)]);
    expect(lines).toContain(`skipped ${odd}: not a segment blob key`);
  });

  test("a failed delete throws, so the script exits non-zero and a re-run continues", async () => {
    const store = new PagedStore([seg(1), seg(2), seg(3)], 10, seg(2));
    await expect(purgeSegmentBlobs(store, () => {})).rejects.toThrow("R2 down");
    expect(store.deleted).toEqual([seg(1)]);
  });
});
