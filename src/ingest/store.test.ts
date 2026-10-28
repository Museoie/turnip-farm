// Pure unit tests (no DB): the fetch is stubbed and the clock is frozen,
// so the production SigV4 signer executes under test for the first time.
// The signer was previously untestable: it used the global fetch and
// `new Date()` directly, while the worker tests substitute a fake.
//
// The expected signature below is recomputed in this file from the SigV4
// spec (canonical request + HMAC key chain via node:crypto), independently
// of the store's WebCrypto implementation — a canonicalization slip in
// either one fails the comparison. The golden value pins the result
// against regressions, following presign.test.ts.

import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { R2BlobStore, R2Error } from "./store";

const CFG = {
  accountId: "123456789012",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  bucket: "turnip-farm",
};
// Synthetic credentials (never live).
const NOW = new Date("2026-10-28T12:00:00.000Z");
const HOST = `${CFG.accountId}.r2.cloudflarestorage.com`;

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDateStrings(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  return {
    dateStamp,
    amzDate: `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`,
  };
}

// Independent SigV4 header-signature computation, from the spec: build the
// canonical request, hash it, derive the signing key, sign the string to
// sign. Deliberately written without reusing any store helper.
function expectedAuthorization(
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string,
  now: Date,
): string {
  const { amzDate, dateStamp } = amzDateStrings(now);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((n) => `${encodeURIComponent(n)}=${encodeURIComponent(query[n]!)}`)
    .join("&");
  const signedNames = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  let key: Buffer | string = `AWS4${CFG.secretAccessKey}`;
  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) key = hmacSha256(key, part);
  const signature = hmacSha256(key, stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${CFG.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
}

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: unknown };
}

function capturingFetch(
  respond: (call: CapturedCall, index: number) => Response,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: unknown, init?: Record<string, unknown>) => {
    const call: CapturedCall = { url: String(url), init: (init ?? {}) as CapturedCall["init"] };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const EMPTY_HASH = sha256Hex(new Uint8Array(0));

describe("R2BlobStore signing", () => {
  test("GET signs the canonical request for a fixed date", async () => {
    const { fetch, calls } = capturingFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "x-amz-checksum-sha256": "abc==" },
        }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    const got = await store.get("poses/abcd.tkp1.gz");

    expect(got?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(got?.checksumSha256).toBe("abc==");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://${HOST}/turnip-farm/poses/abcd.tkp1.gz`);
    expect(call.init.method).toBe("GET");
    const headers = call.init.headers!;
    expect(headers["x-amz-date"]).toBe("20261028T120000Z");
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_HASH);
    const expected = expectedAuthorization(
      "GET",
      "/turnip-farm/poses/abcd.tkp1.gz",
      {},
      { host: HOST, "x-amz-content-sha256": EMPTY_HASH, "x-amz-date": "20261028T120000Z" },
      EMPTY_HASH,
      NOW,
    );
    expect(headers["authorization"]).toBe(expected);
  });

  test("signature is stable for fixed inputs (regression pin)", async () => {
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 404 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await expect(store.get("poses/abcd.tkp1.gz")).resolves.toBeNull();
    const auth = calls[0]!.init.headers!["authorization"]!;
    expect(auth).toMatch(/Signature=([0-9a-f]{64})$/);
    expect(auth.split("Signature=")[1]).toBe(
      "135b3f29ac31acdf20bf51b2a591b475ec95a61d83a623aaeab2632d38b81ba2",
    );
  });

  test("PUT signs content-type and the checksum header, and sends both", async () => {
    const payload = new TextEncoder().encode("hi");
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 200 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await store.put("staging/x.tkp1.gz", payload, "application/octet-stream");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe("PUT");
    const headers = call.init.headers!;
    const checksum = Buffer.from(createHash("sha256").update(payload).digest()).toString("base64");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["x-amz-checksum-sha256"]).toBe(checksum);
    const payloadHash = sha256Hex(payload);
    expect(headers["x-amz-content-sha256"]).toBe(payloadHash);
    expect(headers["authorization"]).toBe(
      expectedAuthorization(
        "PUT",
        "/turnip-farm/staging/x.tkp1.gz",
        {},
        {
          host: HOST,
          "content-type": "application/octet-stream",
          "x-amz-content-sha256": payloadHash,
          "x-amz-checksum-sha256": checksum,
          "x-amz-date": "20261028T120000Z",
        },
        payloadHash,
        NOW,
      ),
    );
    expect(call.init.body).toBe(payload);
  });

  test("path segments are encoded and slashes stay separators", async () => {
    const { fetch, calls } = capturingFetch(() => new Response(null, { status: 404 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await store.get("sp ace/uni-é/file+name?.bin");
    await store.get("a~b/c.d");

    expect(calls[0]!.url).toBe(`https://${HOST}/turnip-farm/sp%20ace/uni-%C3%A9/file%2Bname%3F.bin`);
    expect(calls[1]!.url).toBe(`https://${HOST}/turnip-farm/a~b/c.d`);
  });

  test("DELETE resolves on 404 and throws R2Error on failure", async () => {
    const { fetch, calls } = capturingFetch((_, i) =>
      i === 0 ? new Response(null, { status: 404 }) : new Response("nope", { status: 500 }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await expect(store.delete("poses/gone.tkp1.gz")).resolves.toBeUndefined();
    await expect(store.delete("poses/bad.tkp1.gz")).rejects.toThrow(/R2 DELETE failed: HTTP 500/);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[1]!.init.method).toBe("DELETE");
  });
});

describe("R2BlobStore list parsing", () => {
  const page = (keys: string[], truncated: boolean, token?: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
    `<IsTruncated>${truncated}</IsTruncated>` +
    keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
    (token ? `<NextContinuationToken>${token}</NextContinuationToken>` : "") +
    `</ListBucketResult>`;

  test("follows pagination with the continuation token", async () => {
    const { fetch, calls } = capturingFetch((_, i) =>
      i === 0
        ? new Response(page(["staging/a.tkp1.gz", "staging/b.tkp1.gz"], true, "tok-1"), { status: 200 })
        : new Response(page(["staging/c.tkp1.gz"], false), { status: 200 }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    const keys = await store.list("staging/");

    expect(keys).toEqual(["staging/a.tkp1.gz", "staging/b.tkp1.gz", "staging/c.tkp1.gz"]);
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get("list-type")).toBe("2");
    expect(first.searchParams.get("prefix")).toBe("staging/");
    expect(first.searchParams.get("max-keys")).toBe("1000");
    expect(first.searchParams.get("continuation-token")).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get("continuation-token")).toBe("tok-1");
  });

  test("a truncated page with no token stops instead of looping", async () => {
    const { fetch, calls } = capturingFetch(
      () => new Response(page(["staging/a.tkp1.gz"], true), { status: 200 }),
    );
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await expect(store.list("staging/")).resolves.toEqual(["staging/a.tkp1.gz"]);
    expect(calls).toHaveLength(1);
  });

  test("a failed list throws R2Error", async () => {
    const { fetch } = capturingFetch(() => new Response("denied", { status: 403 }));
    const store = new R2BlobStore(CFG, { fetch, now: () => NOW });
    await expect(store.list("staging/")).rejects.toBeInstanceOf(R2Error);
    await expect(store.list("staging/")).rejects.toThrow(/R2 LIST failed: HTTP 403/);
  });
});
