import { MAX_CANONICAL_BLOB_BYTES } from "../r2/client";

// TKP1 pose-blob codec and canonical 10 Hz resampling (POSE_FORMAT.md).
// Pure functions: no I/O, no clock, except gunzipStaged, which streams
// its decompression so a hostile staged blob cannot exhaust memory
// before the size check. The ingest worker (worker.ts) wires these to
// R2 and Postgres.

export const TKP1_MAGIC = "TKP1";
export const TKP1_VERSION = 1;
export const TKP1_KEYPOINT_COUNT = 17;
export const TKP1_HEADER_BYTES = 24;
export const TKP1_FRAME_BYTES = TKP1_KEYPOINT_COUNT * 3 * 4; // 17 kp x (x,y,conf) f32 = 204
export const CANONICAL_HZ = 10;
// The client analysis range the farm accepts (BACKEND_DESIGN.md §7.3,
// POST /api/sources validation).
export const MIN_SOURCE_HZ = 1;
export const MAX_SOURCE_HZ = 30;

export class Tkp1Error extends Error {
  constructor(readonly reason: string) {
    super(`invalid TKP1 blob: ${reason}`);
    this.name = "Tkp1Error";
  }
}

export interface DecodedTkp1 {
  frameCount: number;
  // As-sent analysis rate, provenance only (f32 header field).
  sourceSampleRateHz: number;
  // n x 204 raw frame bytes, in source order. A gap frame is 204 zero bytes.
  frames: Uint8Array<ArrayBuffer>[];
}

function readF32LE(view: DataView, offset: number): number {
  return view.getFloat32(offset, true);
}

// A frame is missing iff all 17 confidence values are exactly 0.0f
// (POSE_FORMAT.md §7 decoder rule).
export function isGapFrame(frame: Uint8Array<ArrayBuffer>): boolean {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let k = 0; k < TKP1_KEYPOINT_COUNT; k++) {
    if (readF32LE(view, k * 12 + 8) !== 0) return false;
  }
  return true;
}

// Decode fail-closed (POSE_FORMAT.md §9): any header or size violation
// rejects the whole blob.
export function decodeTkp1(bytes: Uint8Array<ArrayBuffer>): DecodedTkp1 {
  if (bytes.length < TKP1_HEADER_BYTES) {
    throw new Tkp1Error(`too short for a header (${bytes.length} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== TKP1_MAGIC) throw new Tkp1Error(`bad magic ${JSON.stringify(magic)}`);
  const version = view.getUint16(4, true);
  if (version !== TKP1_VERSION) throw new Tkp1Error(`unsupported format_version ${version}`);
  const keypointCount = view.getUint16(6, true);
  if (keypointCount !== TKP1_KEYPOINT_COUNT) {
    throw new Tkp1Error(`unsupported keypoint_count ${keypointCount}`);
  }
  const frameCount = view.getUint32(8, true);
  if (frameCount < 1) throw new Tkp1Error(`frame_count ${frameCount} < 1`);
  const flags = view.getUint32(20, true);
  if (flags !== 0) throw new Tkp1Error(`unsupported flags ${flags}`);
  const expected = TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * frameCount;
  if (bytes.length !== expected) {
    throw new Tkp1Error(`size ${bytes.length} != 24 + 204*${frameCount} (${expected})`);
  }
  const sourceSampleRateHz = readF32LE(view, 16);
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(
      bytes.slice(TKP1_HEADER_BYTES + i * TKP1_FRAME_BYTES, TKP1_HEADER_BYTES + (i + 1) * TKP1_FRAME_BYTES),
    );
  }
  return { frameCount, sourceSampleRateHz, frames };
}

export function encodeTkp1(decoded: DecodedTkp1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TKP1_HEADER_BYTES + TKP1_FRAME_BYTES * decoded.frameCount);
  const view = new DataView(out.buffer);
  out[0] = 0x54; out[1] = 0x4b; out[2] = 0x50; out[3] = 0x31; // "TKP1"
  view.setUint16(4, TKP1_VERSION, true);
  view.setUint16(6, TKP1_KEYPOINT_COUNT, true);
  view.setUint32(8, decoded.frameCount, true);
  view.setFloat32(12, CANONICAL_HZ, true);
  view.setFloat32(16, decoded.sourceSampleRateHz, true);
  view.setUint32(20, 0, true);
  for (let i = 0; i < decoded.frameCount; i++) {
    out.set(decoded.frames[i]!, TKP1_HEADER_BYTES + i * TKP1_FRAME_BYTES);
  }
  return out;
}

// Resample to the canonical 10 Hz grid (POSE_FORMAT.md §6). The output
// header carries sample_rate_hz = 10 and preserves the as-sent rate in
// source_sample_rate_hz. Gaps break interpolation: a canonical frame
// touching a gap frame on either side is itself a gap.
export function resampleToCanonical10Hz(decoded: DecodedTkp1): DecodedTkp1 {
  const r = decoded.sourceSampleRateHz;
  if (!(r >= MIN_SOURCE_HZ && r <= MAX_SOURCE_HZ)) {
    throw new Tkp1Error(`source_sample_rate_hz ${r} outside ${MIN_SOURCE_HZ}..${MAX_SOURCE_HZ}`);
  }
  const n = decoded.frameCount;

  // Exactly 10 Hz: the grid coincides with the source frames, so this is
  // a byte-identical passthrough (no float rounding through interpolation).
  if (r === CANONICAL_HZ) {
    return {
      frameCount: n,
      sourceSampleRateHz: r,
      frames: decoded.frames.map((f) => f.slice()),
    };
  }

  const outCount = Math.floor(((n - 1) / r) * CANONICAL_HZ) + 1;
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let k = 0; k < outCount; k++) {
    // p = t * r with t = k/10; computed as (k*r)/10 so integer rates hit
    // exact integers, then snapped to kill float dust near integers.
    let p = (k * r) / CANONICAL_HZ;
    const nearest = Math.round(p);
    if (Math.abs(p - nearest) <= 1e-9 * Math.max(1, Math.abs(p))) p = nearest;
    const i = Math.floor(p);
    const frac = p - i;
    if (frac === 0) {
      frames.push(decoded.frames[i]!.slice());
      continue;
    }
    const a = decoded.frames[i]!;
    const b = decoded.frames[i + 1]!;
    if (isGapFrame(a) || isGapFrame(b)) {
      frames.push(new Uint8Array(TKP1_FRAME_BYTES)); // gaps break interpolation
      continue;
    }
    frames.push(interpolateFrame(a, b, frac));
  }
  return { frameCount: outCount, sourceSampleRateHz: r, frames };
}

function interpolateFrame(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
  frac: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TKP1_FRAME_BYTES);
  const va = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const vb = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const vo = new DataView(out.buffer);
  for (let c = 0; c < TKP1_KEYPOINT_COUNT * 3; c++) {
    const v = (1 - frac) * va.getFloat32(c * 4, true) + frac * vb.getFloat32(c * 4, true);
    vo.setFloat32(c * 4, v, true);
  }
  return out;
}

// Gzip the canonical blob for storage. Bun writes mtime = 0, so encoding
// is deterministic: re-ingesting the same staged upload yields identical
// bytes (and therefore an identical digest), making the worker idempotent.
export function gzipCanonical(uncompressed: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(uncompressed);
}

// Decompress a staged blob with a hard output cap. A bare gunzipSync
// buffers the entire expansion, so a zip bomb exhausts the farm process
// before decodeTkp1's size check ever runs. The cap reuses
// MAX_CANONICAL_BLOB_BYTES: a staged blob decompresses to at most 3x
// the canonical rate (30 Hz vs 10 Hz), so 64 MiB is still ~3 hours of
// footage — orders of magnitude above any legit session — while the
// farm never buffers more than the cap for one staged object.
export async function gunzipStaged(
  gzipped: Uint8Array<ArrayBuffer>,
  opts: { maxBytes?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const maxBytes = opts.maxBytes ?? MAX_CANONICAL_BLOB_BYTES;
  try {
    const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Tkp1Error(`staged decompressed size exceeds ${maxBytes} bytes`);
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
  } catch (err) {
    if (err instanceof Tkp1Error) throw err;
    throw new Tkp1Error("staged object is not valid gzip");
  }
}
