// Blob storage behind an interface, with the R2 (S3-compatible) production
// implementation. The ingest worker only depends on BlobStore, so tests
// substitute an in-memory fake.

import { BlobTooLargeError, MAX_CANONICAL_BLOB_BYTES } from "../r2/client";

export interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  // Base64 SHA-256 the object was stored with (x-amz-checksum-sha256),
  // when the object carries one.
  checksumSha256: string | null;
}

export interface BlobStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class R2Error extends Error {
  constructor(readonly status: number, readonly operation: string, message: string) {
    super(`R2 ${operation} failed: HTTP ${status}: ${message}`);
    this.name = "R2Error";
  }
}

const SERVICE = "s3";
const REGION = "auto"; // R2's SigV4 region
const TERMINATOR = "aws4_request";

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const amzDate =
    `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return { amzDate, dateStamp };
}

async function hmac(key: Uint8Array<ArrayBuffer> | string, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw: Uint8Array<ArrayBuffer> = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

async function sha256HexBytes(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

function encodePathSegment(s: string): string {
  return encodeURIComponent(s).replaceAll("%7E", "~");
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

// Minimal SigV4 signer for R2's S3-compatible API.
async function signRequest(
  cfg: R2Config,
  method: string,
  key: string | null, // null for bucket-level (list) operations
  query: Record<string, string>,
  extraHeaders: Record<string, string>,
  payload: Uint8Array<ArrayBuffer> | null,
): Promise<SignedRequest> {
  const { amzDate, dateStamp } = amzDates(new Date());
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const payloadHash = payload ? await sha256HexBytes(payload) : await sha256HexBytes(new Uint8Array(0));

  const path = key === null ? `/${cfg.bucket}` : `/${cfg.bucket}/${key.split("/").map(encodePathSegment).join("/")}`;
  const queryNames = Object.keys(query).sort();
  const canonicalQuery = queryNames
    .map((n) => `${encodeURIComponent(n)}=${encodeURIComponent(query[n]!)}`)
    .join("&");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const signedNames = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/${TERMINATOR}`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256HexBytes(new TextEncoder().encode(canonicalRequest))].join("\n");

  const kDate = await hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, TERMINATOR);
  const signature = Buffer.from(await hmac(kSigning, stringToSign)).toString("hex");

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;

  const url = `https://${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return { url, headers };
}

export class R2BlobStore implements BlobStore {
  private readonly doFetch: typeof fetch;
  private readonly maxBytes: number;

  constructor(
    private readonly cfg: R2Config,
    opts: { fetch?: typeof fetch; maxBytes?: number } = {},
  ) {
    this.doFetch = opts.fetch ?? fetch;
    this.maxBytes = opts.maxBytes ?? MAX_CANONICAL_BLOB_BYTES;
  }

  async get(key: string): Promise<StoredObject | null> {
    const { url, headers } = await signRequest(this.cfg, "GET", key, {}, {}, null);
    const res = await this.doFetch(url, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new R2Error(res.status, "GET", await res.text());
    // Stream with a running total instead of res.arrayBuffer(): the staged
    // object is the uploader-controlled blob the threat model names
    // (presigned PUTs cannot enforce content-length), so an unbounded read
    // lets one oversized upload exhaust the farm process's memory. The cap
    // reuses MAX_CANONICAL_BLOB_BYTES — a staged upload is at most 3x the
    // canonical rate, so 64 MiB still covers ~3 hours of footage — and
    // mirrors the canonical path's getBytes, including its content-length
    // fast path (headers can lie, so the stream is still counted).
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > this.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new BlobTooLargeError(key, this.maxBytes);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        checksumSha256: res.headers.get("x-amz-checksum-sha256"),
      };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BlobTooLargeError(key, this.maxBytes);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, off);
      off += chunk.byteLength;
    }
    return {
      bytes,
      checksumSha256: res.headers.get("x-amz-checksum-sha256"),
    };
  }

  async put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
    // Ship the SHA-256 as the object's checksum: transport integrity on the
    // canonical write, and a verifiable value for future GETs.
    const checksum = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("base64");
    const { url, headers } = await signRequest(this.cfg, "PUT", key, {}, {
      "content-type": contentType,
      "x-amz-checksum-sha256": checksum,
    }, bytes);
    const res = await fetch(url, { method: "PUT", headers, body: bytes });
    if (!res.ok) throw new R2Error(res.status, "PUT", await res.text());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = await signRequest(this.cfg, "DELETE", key, {}, {}, null);
    const res = await fetch(url, { method: "DELETE", headers });
    if (res.status !== 404 && !res.ok) throw new R2Error(res.status, "DELETE", await res.text());
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuation: string | undefined;
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
      if (continuation !== undefined) query["continuation-token"] = continuation;
      const { url, headers } = await signRequest(this.cfg, "GET", null, query, {}, null);
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) throw new R2Error(res.status, "LIST", await res.text());
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1]!);
      if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
        const token = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
        if (!token) break;
        continuation = token[1];
      } else break;
    }
    return keys;
  }
}
