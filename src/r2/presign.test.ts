import { describe, expect, test } from "bun:test";
import { presignGet, presignPut, presignUrl, PRESIGN_TTL_SEC, r2Host } from "./presign";

const CFG = {
  accountId: "123456789012",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  bucket: "turnip-farm",
};
// Synthetic credentials (never live); the expected signature below was
// produced by this implementation and pins it against regressions. The
// SigV4 construction itself was verified against AWS's documented
// query-string example (canonical request matched byte-for-byte; HMAC
// chain cross-checked with an independent implementation).
const NOW = new Date("2026-10-14T08:00:00.000Z");

describe("presignUrl", () => {
  test("PUT url carries the SigV4 presign parameters and a 15-minute TTL", () => {
    const { url, expiresAt } = presignPut(CFG, "staging/abcd.tkp1.gz", NOW);
    const u = new URL(url);
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe(r2Host(CFG));
    expect(u.pathname).toBe("/staging/abcd.tkp1.gz");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe(
      "test-access-key-id/20261014/auto/s3/aws4_request"
    );
    expect(u.searchParams.get("X-Amz-Date")).toBe("20261014T080000Z");
    expect(u.searchParams.get("X-Amz-Expires")).toBe(String(PRESIGN_TTL_SEC));
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.toISOString()).toBe("2026-10-14T08:15:00.000Z");
  });

  test("signature is stable for fixed inputs (regression pin)", () => {
    const { url } = presignGet(CFG, "poses/abcd.tkp1.gz", NOW);
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "6315e2bed89e090156ea1d688947d476d8c8d260842fbd538b35fbe2d5f7ad3c"
    );
  });

  test("method feeds the signature: PUT and GET differ", () => {
    const put = new URL(presignUrl(CFG, "PUT", "poses/k.tkp1.gz", 900, NOW).url);
    const get = new URL(presignUrl(CFG, "GET", "poses/k.tkp1.gz", 900, NOW).url);
    expect(put.searchParams.get("X-Amz-Signature")).not.toBe(
      get.searchParams.get("X-Amz-Signature")
    );
  });
});
