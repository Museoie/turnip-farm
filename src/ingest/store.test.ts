// Bounded R2BlobStore.get for the ingest worker: the staged object is the
// uploader-controlled blob, so the download must be capped like the
// canonical path's getBytes. Pure unit tests (no DB, no network): the
// fetch is stubbed, the SigV4 URL is real but never leaves the process.
import { describe, expect, test } from "bun:test";
import { BlobTooLargeError } from "../r2/client";
import { R2BlobStore } from "./store";

const CFG = {
  accountId: "123456789012",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  bucket: "turnip-farm",
};
// Synthetic credentials (never live); SigV4 output is pinned in presign.test.ts.

const KEY = "staging/abcd.tkp1.gz";

type RespBody = ConstructorParameters<typeof Response>[0];

function stubFetch(
  body: RespBody,
  init: { status?: number; headers?: Record<string, string> } = {},
): typeof fetch {
  return (async (_url: unknown) =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.headers,
    })) as unknown as typeof fetch;
}

function streamOf(chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });
}

describe("R2BlobStore.get", () => {
  test("returns bytes and checksum when under the cap", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const store = new R2BlobStore(CFG, {
      fetch: stubFetch(data, { headers: { "x-amz-checksum-sha256": "abc==" } }),
      maxBytes: 10,
    });
    const got = await store.get(KEY);
    expect(got?.bytes).toEqual(data);
    expect(got?.checksumSha256).toBe("abc==");
  });

  test("streams chunked bodies without a content-length", async () => {
    const store = new R2BlobStore(CFG, { fetch: stubFetch(streamOf([3, 4])), maxBytes: 10 });
    const got = await store.get(KEY);
    expect(got?.bytes).toEqual(new Uint8Array(7));
  });

  test("rejects once streamed chunks exceed the cap", async () => {
    // A fresh stub per call: a consumed stream cannot be re-read.
    const makeStore = () =>
      new R2BlobStore(CFG, { fetch: stubFetch(streamOf([6, 6])), maxBytes: 10 });
    await expect(makeStore().get(KEY)).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(makeStore().get(KEY)).rejects.toThrow(/exceeds 10 bytes/);
  });

  test("rejects on a declared content-length over the cap", async () => {
    const store = new R2BlobStore(CFG, {
      fetch: stubFetch(new Uint8Array([1]), { headers: { "content-length": "999" } }),
      maxBytes: 10,
    });
    await expect(store.get(KEY)).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  test("404 returns null", async () => {
    const store = new R2BlobStore(CFG, { fetch: stubFetch(null, { status: 404 }), maxBytes: 10 });
    await expect(store.get(KEY)).resolves.toBeNull();
  });
});
