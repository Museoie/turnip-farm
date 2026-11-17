// The admin player's decoding and playback math (pose.ts), against blobs
// built with the farm's own encoder.

import { describe, expect, test } from "bun:test";
import { TKP1_FRAME_BYTES, Tkp1Error, encodeTkp1 } from "../../ingest/tkp1";
import { CONFIDENCE_FLOOR, PoseError, advance, decodePose, formatSeconds, gapRuns, gunzipCapped, skeletonAt } from "./pose";

// One frame with the given keypoints set to (x, y, confidence).
function frame(points: Record<number, [number, number, number]>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TKP1_FRAME_BYTES);
  const view = new DataView(out.buffer);
  for (const [k, [x, y, c]] of Object.entries(points)) {
    view.setFloat32(Number(k) * 12, x, true);
    view.setFloat32(Number(k) * 12 + 4, y, true);
    view.setFloat32(Number(k) * 12 + 8, c, true);
  }
  return out;
}

const GAP = new Uint8Array(TKP1_FRAME_BYTES);

function blob(frames: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(encodeTkp1({ frameCount: frames.length, sourceSampleRateHz: 30, frames }));
}

describe("decodePose", () => {
  test("decodes values and gaps from a canonical blob", async () => {
    const pose = await decodePose(
      blob([frame({ 0: [0.5, 0.2, 0.95], 5: [0.45, 0.35, 0.9] }), GAP, frame({ 0: [0.51, 0.21, 0.94] })]),
    );
    expect(pose.frameCount).toBe(3);
    expect(pose.gaps).toEqual([false, true, false]);
    expect(pose.values).toHaveLength(3 * 51);
    expect(pose.values[0]).toBeCloseTo(0.5, 6);
    expect(pose.values[5 * 3 + 1]).toBeCloseTo(0.35, 6);
    expect(pose.values[2 * 51 + 2]).toBeCloseTo(0.94, 6);
  });

  test("rejects what the farm's decoder rejects", async () => {
    const bytes = encodeTkp1({ frameCount: 1, sourceSampleRateHz: 10, frames: [GAP] });
    bytes[0] = 0x58; // "XKP1"
    await expect(decodePose(Bun.gzipSync(bytes))).rejects.toBeInstanceOf(Tkp1Error);
    const truncated = encodeTkp1({ frameCount: 2, sourceSampleRateHz: 10, frames: [GAP, GAP] }).slice(0, 24 + 204);
    await expect(decodePose(Bun.gzipSync(truncated))).rejects.toBeInstanceOf(Tkp1Error);
  });

  test("refuses bytes that aren't gzip, and output over the cap", async () => {
    await expect(gunzipCapped(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(PoseError);
    const big = Bun.gzipSync(new Uint8Array(4096));
    expect(await gunzipCapped(big, 4096)).toHaveLength(4096);
    await expect(gunzipCapped(big, 4095)).rejects.toThrow("decompresses past 4095 bytes");
  });
});

describe("skeletonAt", () => {
  test("draws only keypoints strictly above the confidence floor, and the bones between them", async () => {
    const pose = await decodePose(
      blob([
        frame({
          5: [0.4, 0.3, 0.9], // left shoulder
          6: [0.6, 0.3, 0.31], // right shoulder, just above: drawn
          7: [0.35, 0.45, CONFIDENCE_FLOOR], // left elbow, exactly at the floor: hidden, as in the app
          8: [0.65, 0.45, 0.29], // right elbow, under: hidden
          11: [0.42, 0.6, 0.8], // left hip
        }),
      ]),
    );
    const s = skeletonAt(pose, 0);
    if (s.gap) throw new Error("expected a pose");
    expect(s.points[5]).toEqual({ x: expect.closeTo(0.4, 6), y: expect.closeTo(0.3, 6) });
    expect(s.points[6]).not.toBeNull();
    expect(s.points[7]).toBeNull();
    expect(s.points[8]).toBeNull();
    expect(s.points.filter((p) => p !== null)).toHaveLength(3);
    expect(s.edges).toEqual([
      [5, 6],
      [5, 11],
    ]);
  });

  test("a gap frame draws nothing, and so does a frame out of range", async () => {
    const pose = await decodePose(blob([frame({ 0: [0.5, 0.5, 1] }), GAP]));
    expect(skeletonAt(pose, 0).gap).toBe(false);
    expect(skeletonAt(pose, 1)).toEqual({ gap: true });
    expect(skeletonAt(pose, 2)).toEqual({ gap: true });
  });
});

describe("playback", () => {
  test("advances at 10 Hz times the speed and stops on the last frame", () => {
    expect(advance(0, 100, 1, 50)).toEqual({ position: 1, ended: false });
    expect(advance(0, 1000, 0.5, 50)).toEqual({ position: 5, ended: false });
    expect(advance(10, 1000, 2, 50)).toEqual({ position: 30, ended: false });
    expect(advance(45, 1000, 1, 50)).toEqual({ position: 49, ended: true });
    expect(advance(0, 16, 1, 1)).toEqual({ position: 0, ended: true });
  });

  test("gap runs and time formatting", () => {
    expect(gapRuns([true, true, false, false, true, false, true])).toEqual([
      [0, 2],
      [4, 5],
      [6, 7],
    ]);
    expect(gapRuns([false, false])).toEqual([]);
    expect(formatSeconds(0)).toBe("0:00.0");
    expect(formatSeconds(65.25)).toBe("1:05.3");
    expect(formatSeconds(59.96)).toBe("1:00.0");
  });
});
