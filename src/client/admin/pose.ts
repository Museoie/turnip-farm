// Pose decoding and playback math for the admin player. The blob is the
// canonical .tkp1.gz the farm stores (POSE_FORMAT.md), decoded with the
// farm's own TKP1 codec. No DOM here, so the tests run under bun test.

import { CANONICAL_HZ, TKP1_KEYPOINT_COUNT, decodeTkp1, isGapFrame } from "../../ingest/tkp1-codec";

export { CANONICAL_HZ };

/**
 * The largest decompressed blob the player accepts: the farm's own cap on a
 * canonical blob (MAX_CANONICAL_BLOB_BYTES), about ten hours at 10 Hz.
 */
export const MAX_POSE_BYTES = 64 * 1024 * 1024;

/**
 * A keypoint is drawn only when its confidence is strictly above this:
 * the app's own rule (turnip-ios `PoseKeypoint.confidenceThreshold`, used
 * as `confidence > threshold` by its pose overlays), so the page shows
 * what the app showed.
 */
export const CONFIDENCE_FLOOR = 0.3;

/** COCO keypoint pairs drawn as bones (POSE_FORMAT.md §4 indices): the app's `PoseOverlayView.edges`. */
export const SKELETON_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [0, 2], [1, 3], [2, 4], // face
  [5, 6], [5, 11], [6, 12], [11, 12], // torso
  [5, 7], [7, 9], [6, 8], [8, 10], // arms
  [11, 13], [13, 15], [12, 14], [14, 16], // legs
];

export interface Pose {
  frameCount: number;
  /** frameCount × 17 × (x, y, confidence), row-major. */
  values: Float32Array;
  /** gaps[i] is true when frame i is missing (POSE_FORMAT.md §7). */
  gaps: boolean[];
}

export class PoseError extends Error {
  override name = "PoseError";
}

/** Gunzips with a hard cap on the output, so a bad blob can't fill memory. */
export async function gunzipCapped(gzipped: Uint8Array<ArrayBuffer>, maxBytes = MAX_POSE_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PoseError(`the pose blob decompresses past ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PoseError) throw err;
    throw new PoseError("the pose blob is not valid gzip");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Decodes a .tkp1.gz blob; throws PoseError (or the codec's Tkp1Error). */
export async function decodePose(gzipped: Uint8Array<ArrayBuffer>): Promise<Pose> {
  const decoded = decodeTkp1(await gunzipCapped(gzipped));
  const stride = TKP1_KEYPOINT_COUNT * 3;
  const values = new Float32Array(decoded.frameCount * stride);
  const gaps: boolean[] = [];
  decoded.frames.forEach((frame, i) => {
    gaps.push(isGapFrame(frame));
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    for (let c = 0; c < stride; c++) values[i * stride + c] = view.getFloat32(c * 4, true);
  });
  return { frameCount: decoded.frameCount, values, gaps };
}

export type Skeleton =
  | { gap: true }
  | {
      gap: false;
      /** One entry per keypoint: its (x, y), or null when at or below the floor. */
      points: ({ x: number; y: number } | null)[];
      /** The SKELETON_EDGES whose both ends are drawn. */
      edges: (readonly [number, number])[];
    };

/** What to draw for one frame. */
// The comparison is in float32, as the app's Swift `Float` one is: the
// stored confidences are float32, and float32 0.3 is a little above the
// double 0.3, so a keypoint at exactly the floor would otherwise be drawn.
export function skeletonAt(pose: Pose, frame: number, floor = CONFIDENCE_FLOOR): Skeleton {
  if (pose.gaps[frame] !== false) return { gap: true };
  const base = frame * TKP1_KEYPOINT_COUNT * 3;
  const points: ({ x: number; y: number } | null)[] = [];
  for (let k = 0; k < TKP1_KEYPOINT_COUNT; k++) {
    const confidence = pose.values[base + k * 3 + 2]!;
    points.push(
      confidence > Math.fround(floor) ? { x: pose.values[base + k * 3]!, y: pose.values[base + k * 3 + 1]! } : null,
    );
  }
  const edges = SKELETON_EDGES.filter(([a, b]) => points[a] !== null && points[b] !== null);
  return { gap: false, points, edges };
}

/**
 * Advances a playback position, in frames (fractional), by dtMs of wall
 * time at the given speed. Stops at the last frame; returns the new
 * position and whether playback reached the end.
 */
export function advance(position: number, dtMs: number, speed: number, frameCount: number): { position: number; ended: boolean } {
  const last = Math.max(0, frameCount - 1);
  const next = position + (dtMs / 1000) * CANONICAL_HZ * speed;
  return next >= last ? { position: last, ended: true } : { position: next, ended: false };
}

/** Seconds as m:ss.s. */
export function formatSeconds(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Runs of consecutive gap frames, as [start, end) frame ranges. */
export function gapRuns(gaps: boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  gaps.forEach((gap, i) => {
    if (gap && start < 0) start = i;
    if (!gap && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, gaps.length]);
  return runs;
}
