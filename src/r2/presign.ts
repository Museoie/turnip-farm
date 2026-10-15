// AWS SigV4 presigned URLs for R2 (BACKEND_DESIGN.md §1.2.10, §7.3).
// R2 is S3-compatible; region is "auto". Only the `host` header is signed,
// so the client may attach the checksum header the transport-integrity
// layer requires (Content-MD5 or x-amz-checksum-sha256) — R2 validates the
// uploaded bytes against it at write time. Presigning cannot force the
// header; the client contract (§7.1) has the client attach it.

import { createHash, createHmac } from "node:crypto";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

const REGION = "auto";
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
// 15 minutes, per the endpoint specs (§7.3 POST /api/sources,
// GET /api/sources/:id/pose).
export const PRESIGN_TTL_SEC = 15 * 60;

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function toAmzDate(d: Date): string {
  // YYYYMMDDTHHMMSSZ
  return d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

function encodeKey(key: string): string {
  // S3 signs each path segment; "/" stays a separator. Our keys are
  // [a-z0-9/.] so this is a no-op for them, but correct in general.
  return key.split("/").map(encodeURIComponent).join("/");
}

export function r2Host(cfg: R2Config): string {
  return `${cfg.bucket}.${cfg.accountId}.r2.cloudflarestorage.com`;
}

export function presignUrl(
  cfg: R2Config,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  expiresInSec: number = PRESIGN_TTL_SEC,
  now: Date = new Date(),
): PresignedUrl {
  const host = r2Host(cfg);
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalUri = `/${encodeKey(key)}`;

  const query: [string, string][] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${cfg.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSec)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, REGION);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const expiresAt = new Date(now.getTime() + expiresInSec * 1000);
  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt,
  };
}

export const presignPut = (cfg: R2Config, key: string, now?: Date): PresignedUrl =>
  presignUrl(cfg, "PUT", key, PRESIGN_TTL_SEC, now);

export const presignGet = (cfg: R2Config, key: string, now?: Date): PresignedUrl =>
  presignUrl(cfg, "GET", key, PRESIGN_TTL_SEC, now);
