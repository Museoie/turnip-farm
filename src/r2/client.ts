// Minimal R2 client for the contribution endpoints (BACKEND_DESIGN.md
// §7.3): presigned upload/download URLs plus the two farm-side object
// operations the endpoints need — blob fetch for the §1.2.10 digest
// re-verification on clip submission, and blob delete on source delete.
// Reads/writes go through presigned URLs so there is a single SigV4 code
// path (presign.ts).

import { presignGet, presignPut, presignUrl, type PresignedUrl, type R2Config } from "./presign";

export type { PresignedUrl, R2Config };

export interface R2Client {
  presignPut(key: string): PresignedUrl;
  presignGet(key: string): PresignedUrl;
  /**
   * Object bytes, or null when the key does not exist.
   * The download is hard-capped at `opts.maxBytes` (default
   * MAX_CANONICAL_BLOB_BYTES): a key-holding contributor can PUT an
   * arbitrarily large blob to their presigned staging URL (presigned PUTs
   * cannot enforce content-length), so an unbounded read would let one
   * hostile blob exhaust the farm process's memory. Throws
   * BlobTooLargeError when the cap is exceeded.
   */
  getBytes(key: string, opts?: { maxBytes?: number }): Promise<Uint8Array | null>;
  /** Deleting a missing key is a no-op. */
  deleteObject(key: string): Promise<void>;
}

/** Thrown by getBytes when the blob exceeds the caller's maxBytes. */
export class BlobTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly maxBytes: number,
  ) {
    super(`R2 GET ${key}: blob exceeds ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

/**
 * Largest canonical blob the farm will buffer. Judgment call, grounded in
 * POSE_FORMAT.md §8: a canonical blob is ~2,040 bytes/s at 10 Hz (≈122 KB
 * for a 60-second session, gzip shrinking a further 5–25%), so 64 MiB is
 * roughly ten hours of tricking footage — two orders of magnitude above any
 * legit session. Anything larger is never legit, and the farm process must
 * never buffer more than this.
 */
export const MAX_CANONICAL_BLOB_BYTES = 64 * 1024 * 1024;

export function createR2Client(
  cfg: R2Config,
  opts: { now?: () => Date; fetch?: typeof fetch } = {},
): R2Client {
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetch ?? fetch;
  return {
    presignPut: (key) => presignPut(cfg, key, now()),
    presignGet: (key) => presignGet(cfg, key, now()),
    getBytes: async (key, opts = {}) => {
      const maxBytes = opts.maxBytes ?? MAX_CANONICAL_BLOB_BYTES;
      const { url } = presignUrl(cfg, "GET", key, 60, now());
      const res = await doFetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
      // Fast path: the declared length already exceeds the cap. Headers can
      // lie, so the stream is still counted below.
      const declared = res.headers.get("content-length");
      if (declared !== null && Number(declared) > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new BlobTooLargeError(key, maxBytes);
      }
      // Stream with a running total instead of res.arrayBuffer(): the body
      // is untrusted and arrayBuffer() buffers it unboundedly.
      const reader = res.body?.getReader();
      if (!reader) return new Uint8Array(await res.arrayBuffer());
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new BlobTooLargeError(key, maxBytes);
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const chunk of chunks) {
        out.set(chunk, off);
        off += chunk.byteLength;
      }
      return out;
    },
    deleteObject: async (key) => {
      const { url } = presignUrl(cfg, "DELETE", key, 60, now());
      const res = await doFetch(url, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
      }
    },
  };
}
