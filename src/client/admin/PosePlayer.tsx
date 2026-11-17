import { useEffect, useRef, useState } from "react";
import { AdminError, type AdminSource, fetchPoseBlob } from "./api";
import { CANONICAL_HZ, type Pose, advance, decodePose, formatSeconds, gapRuns, skeletonAt } from "./pose";

// Plays one source's canonical pose blob as a 17-keypoint skeleton, one
// drawn frame per 10 Hz sample (scaled by the speed). Clip windows sit on
// the scrubber with their trick names; gap frames draw nothing.

const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

// The video's aspect isn't stored, so the viewer picks one; x and y are
// normalized to the video frame (POSE_FORMAT.md §5).
const ASPECTS = {
  portrait: { label: "Portrait 9:16", width: 360, height: 640 },
  landscape: { label: "Landscape 16:9", width: 640, height: 360 },
  square: { label: "Square", width: 480, height: 480 },
} as const;
type Aspect = keyof typeof ASPECTS;

// Keypoints may fall outside 0..1 (letterboxing), so the video frame is
// inset by this fraction of the canvas on each side.
const INSET = 0.08;

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; pose: Pose };

function draw(canvas: HTMLCanvasElement, pose: Pose, frame: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  const css = getComputedStyle(canvas);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color("--bg-raised", "#111113");
  ctx.fillRect(0, 0, width, height);

  const ox = width * INSET;
  const oy = height * INSET;
  const w = width * (1 - 2 * INSET);
  const h = height * (1 - 2 * INSET);
  ctx.strokeStyle = color("--border", "#232326");
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.strokeRect(ox, oy, w, h);
  ctx.setLineDash([]);

  const skeleton = skeletonAt(pose, frame);
  if (skeleton.gap) {
    ctx.fillStyle = color("--text-dim", "#9a9aa2");
    ctx.font = "15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Gap: no pose in this frame", width / 2, height / 2);
    return;
  }
  const at = (p: { x: number; y: number }) => [ox + p.x * w, oy + p.y * h] as const;
  ctx.strokeStyle = color("--pink", "#e0509c");
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (const [a, b] of skeleton.edges) {
    const [x1, y1] = at(skeleton.points[a]!);
    const [x2, y2] = at(skeleton.points[b]!);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.fillStyle = color("--text", "#f2f2f4");
  for (const point of skeleton.points) {
    if (!point) continue;
    const [x, y] = at(point);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function PosePlayer({ source, onSignedOut }: { source: AdminSource; onSignedOut: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [aspect, setAspect] = useState<Aspect>("portrait");
  const positionRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const seek = (frame: number) => {
    positionRef.current = frame;
    setPosition(frame);
  };

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    setPlaying(false);
    seek(0);
    fetchPoseBlob(source.id)
      .then(decodePose)
      .then((pose) => {
        if (!cancelled) setLoad({ kind: "ready", pose });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AdminError && err.status === 401) onSignedOut();
        setLoad({ kind: "error", message: err instanceof Error ? err.message : "The pose could not be loaded." });
      });
    return () => {
      cancelled = true;
    };
  }, [source.id, onSignedOut]);

  const pose = load.kind === "ready" ? load.pose : null;
  const frameCount = pose?.frameCount ?? 0;
  const frame = Math.min(Math.floor(position), Math.max(0, frameCount - 1));

  useEffect(() => {
    if (!playing || !pose) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const next = advance(positionRef.current, now - last, speed, pose.frameCount);
      last = now;
      positionRef.current = next.position;
      setPosition(next.position);
      if (next.ended) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, pose]);

  // Redraws only when the sample changes, so the skeleton moves at the
  // blob's rate rather than the display's.
  useEffect(() => {
    if (pose && canvasRef.current) draw(canvasRef.current, pose, frame);
  }, [pose, frame, aspect]);

  const togglePlay = () => {
    if (!pose) return;
    if (!playing && positionRef.current >= pose.frameCount - 1) seek(0);
    setPlaying(!playing);
  };

  const size = ASPECTS[aspect];
  const pct = (f: number) => `${(f / Math.max(1, frameCount)) * 100}%`;
  const currentClip = source.clips.find((c) => frame >= c.start_frame && frame < c.end_frame);

  return (
    <div className="player">
      {load.kind === "loading" && <p>Loading pose…</p>}
      {load.kind === "error" && <p className="admin-error">{load.message}</p>}
      {pose && (
        <>
          <canvas
            ref={canvasRef}
            className="player-canvas"
            width={size.width}
            height={size.height}
            aria-label={`Pose skeleton, frame ${frame + 1} of ${frameCount}`}
          />
          <div className="player-controls">
            <button className="btn btn-primary" type="button" onClick={togglePlay}>
              {playing ? "Pause" : "Play"}
            </button>
            <label>
              Speed{" "}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            <label>
              Frame{" "}
              <select value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)}>
                {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
                  <option key={a} value={a}>
                    {ASPECTS[a].label}
                  </option>
                ))}
              </select>
            </label>
            <span className="player-time">
              {formatSeconds(frame / CANONICAL_HZ)} / {formatSeconds(Math.max(0, frameCount - 1) / CANONICAL_HZ)} ·
              frame {frame + 1} of {frameCount}
              {pose.gaps[frame] ? " · gap" : ""}
            </span>
          </div>
          <div className="scrubber">
            <div className="scrub-track">
              {gapRuns(pose.gaps).map(([start, end]) => (
                <span key={`gap-${start}`} className="scrub-gap" style={{ left: pct(start), width: pct(end - start) }} />
              ))}
              {source.clips.map((clip) => {
                const names = clip.names.join(", ") || "unlabeled";
                return (
                  <button
                    key={clip.id}
                    type="button"
                    className={`scrub-clip${clip === currentClip ? " is-current" : ""}`}
                    style={{ left: pct(clip.start_frame), width: pct(clip.end_frame - clip.start_frame) }}
                    title={names}
                    aria-label={`Jump to clip: ${names}`}
                    onClick={() => seek(clip.start_frame)}
                  >
                    {names}
                  </button>
                );
              })}
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, frameCount - 1)}
              step={1}
              value={frame}
              aria-label="Scrub"
              onChange={(e) => seek(Number(e.target.value))}
            />
          </div>
          {source.clips.length === 0 ? (
            <p className="dim">No clips on this source.</p>
          ) : (
            <ol className="clip-list">
              {source.clips.map((clip) => (
                <li key={clip.id}>
                  <button
                    type="button"
                    className={`clip-jump${clip === currentClip ? " is-current" : ""}`}
                    onClick={() => seek(clip.start_frame)}
                  >
                    <span className="clip-time">
                      {formatSeconds(clip.start_frame / CANONICAL_HZ)}–{formatSeconds(clip.end_frame / CANONICAL_HZ)}
                    </span>{" "}
                    {clip.names.length > 0 ? clip.names.join(", ") : <em>unlabeled</em>}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
