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
  /** Object bytes, or null when the key does not exist. */
  getBytes(key: string): Promise<Uint8Array | null>;
  /** Deleting a missing key is a no-op. */
  deleteObject(key: string): Promise<void>;
}

export function createR2Client(
  cfg: R2Config,
  opts: { now?: () => Date; fetch?: typeof fetch } = {},
): R2Client {
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetch ?? fetch;
  return {
    presignPut: (key) => presignPut(cfg, key, now()),
    presignGet: (key) => presignGet(cfg, key, now()),
    getBytes: async (key) => {
      const { url } = presignUrl(cfg, "GET", key, 60, now());
      const res = await doFetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
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
