# Turnip Farm + ML Master Plan

*Rev 1 · 2026-10-05 · Draft for review.*

This document is the master plan for `turnip-farm` (backend + dataset) and
`turnip-ml` (training), and the contract they hold with `turnip-ios`.
It **supersedes** the backend, labeling, and ML sections of
`turnip-ios/docs/DESIGN.md` (Rev 8) on the points below, and records three
direction changes Hoie made on 2026-10-05:

1. **Community labeling with free-text trick names.** Users label their clips;
   labels are free-text, the UI prompts for the trick name, and a clip can
   carry multiple labels (e.g. a combo: `hook`, `scoot`, `gainer`,
   `cartfull`).
2. **Privacy-first farm: no video, ever.** Clips are never sent to the farm
   as video data. What leaves the device is an opaque video identifier plus
   the pose keypoint sequence. The iOS client matches server-side label data
   back to local videos using the video identifier.
3. **The ML engine trains a trick detection model, not a pose model.** The
   model takes a pose key sequence and answers *where the tricks are*
   (start/end frame of each trick) and *what they are called* (trick names).
   Eventually it runs on-device, turning the pose stream directly into a
   list of named clips.

`turnip-ios` remains the capture / pose / clip / export app. Pose detection
itself stays on-device (MoveNet Thunder, bundled) — the farm and the ML
pipeline never see a pixel.

---

## 1. Privacy architecture

This is the keystone. Everything else follows from it.

**Never leaves the device:** video pixels, audio, location, photo-library
identifiers, device identifiers, contacts, or anything derived from them.

**May leave the device (per explicit per-clip opt-in):**
- `video_id` — an opaque UUID v4 generated on-device at capture/import time.
  It is random, not a content hash, so it cannot be joined against any
  outside dataset. One ID per source video, stable for its lifetime.
- Pose keypoint sequence — per sampled frame, the model's keypoints
  (`x`, `y`, `confidence`, normalized). A stick figure: no face, no
  background, no clothing, no identity.
- Label payloads — trick windows (frame ranges) and free-text trick names.
- Account subject — the Sign in with Apple `sub` claim, which is already
  per-app opaque. Needed to attribute labels for reputation scoring.

**Why keypoints are safe enough:** a pose sequence contains no biometric
image data. Residual honesty: gait-from-keypoints is a real (if nascent)
research area, so we store the minimum viable representation (keypoints
only, no raw sensor data) and keep accounts pseudonymous. No mitigation
beyond minimization is warranted at this scale.

**What this kills from DESIGN.md Rev 8:** presigned video upload to R2,
server-side video storage, server-rendered video feed, and every sentence
with "upload the video to the backend" in it. R2 stays — for pose blobs
and model artifacts, not video.

---

## 2. Data model (farm)

Postgres. Additive migrations via `dbmate` from day one (unchanged
convention).

- `users` — `id`, `apple_subject` (unique), `display_name` (optional),
  `reputation`, `is_blocked`, `created_at`. Unchanged in shape; note the
  account holds no personal data beyond what Apple gives us.
- `sources` — one row per contributed source video. `id` UUID **generated
  on-device** (PK — the farm never mints video identities),
  `user_id` FK, `frame_count`, `sample_rate`, `keypoint_format`
  (e.g. `movenet-17`, versioned), `r2_key` (pose blob), `created_at`.
  No video bytes. No thumbnails.
- `clips` — `id`, `source_id` FK, `start_frame`, `end_frame`,
  `auto_detected` (bool: heuristic now, trick model later),
  `created_at`. A clip is a window into a source, nothing more.
- `labels` — `id`, `clip_id` FK, `user_id` FK (the labeler),
  `labels TEXT[]` (free-text trick names, **multiple per clip**),
  `start_frame` / `end_frame` (nullable — null means "accept the clip
  window"; labelers may tighten it), `quality_score`, `created_at`.
  `crop_rects` are gone from the server model: with keypoints, the
  athlete's location is already known, and crop is a client-side
  rendering concern for export.
- `label_taxonomy` — `raw` → `canonical` mapping plus `first_seen`.
  Free text is preserved forever; training consumes canonical names.
  Seeded from standard tricking vocabulary, grown from data (see §5).
- `models` — `id`, `version`, `model_type` (`trick-detection`),
  `r2_key`, `val_metrics` (JSONB), `promoted_at`.
- `reports` — retargeted at labels/clips (was: videos).
- `follows` / feed — **deferred**. A server video feed cannot exist
  without server video. Social sharing stays where DESIGN.md put it:
  the iOS Share Sheet, zero server involvement. If a feed is wanted
  later, the honest options are skeleton-preview rendering client-side
  from keypoints, or revisiting this privacy line deliberately —
  not silently.

**Pose blob format.** Canonical encoding: little-endian float32 arrays
(frames × keypoints × 3), gzip-compressed, with a small header
(magic, format version, keypoint count, frame count, sample rate).
Size math: 17 keypoints × 3 × 4 bytes × 10 fps ≈ 2 KB/s — a 60-second
session is ~120 KB. R2 presigned PUT for upload (same pattern as the old
video upload, now for blobs); the droplet never touches the bytes.

---

## 3. API (farm)

Bun + TypeScript + Postgres (unchanged stack). Auth via Sign in with
Apple (unchanged contract).

- `POST /api/sources` — register a source. Body:
  `{video_id, frame_count, sample_rate, keypoint_format, clips?:
  [{start_frame, end_frame, auto_detected}]}` plus the pose blob via
  presigned R2 PUT (URL minted here). Upload the **full source pose
  sequence once**; clips are frame windows into it — at ~2 KB/s there is
  no reason to slice per clip.
- `GET /api/labels/pending` — N clips needing labels:
  `[{clip_id, video_id, start_frame, end_frame, pose_url}]`
  (`pose_url` = presigned R2 GET for the source blob).
- `POST /api/clips/:id/labels` — `{labels: ["cork", "shuriken"],
  start_frame?, end_frame?}`. Multiple free-text names per clip;
  window optional.
- `DELETE /api/sources/:id` — owner-only hard delete (row + R2 blob).
  Replaces the old video delete; same "keep forever, user-deletable"
  retention posture.
- `GET /api/models/current` — trick-model manifest (version, URL,
  checksum). Same shape as before, new model type.
- `POST /api/models` — training pipeline publishes the champion
  (admin-scoped).
- `GET /api/labels/export?since=` — training pipeline pull: labels +
  pose blob references since a watermark.
- **Dropped:** video upload/serve, video feed endpoints, crop rects in
  labels.

---

## 4. iOS app contract (turnip-ios)

1. **Video identity.** Generate a UUID v4 per captured/imported video;
   persist the `video_id ↔ PHAsset localIdentifier` mapping in the
   app-local store. This is the join key for everything server-side.
2. **Contribution toggle (per clip, opt-in).** "Contribute to the
   community dataset" uploads `{video_id, pose key sequence,
   clip windows}` — keypoints, never video.
3. **Labeling tab (v2).** Fetches `GET /api/labels/pending`. For each
   clip, look up the local video by `video_id`:
   - Found → play the local video with the pose overlay, editable
     start/end handles, and free-text label chips. The UI **prompts for
     the trick name** and accepts **multiple labels per clip**.
   - Not found (deleted, or another device) → render a skeleton
     animation from the pose keypoints. Labeling works from the stick
     figure alone — which is also the proof of the privacy property.
   
   This covers both "label my own clips" (the primary flow — the
   owner's client already holds the video) and community labeling of
   others' clips.
4. **On-device trick model (endgame).** Poll `GET /api/models/current`
   for the trick-detection Core ML model; run it over the pose
   sequence to propose clips **and** trick names, replacing the
   heuristic `TrickWindowDetector` (which stays as the offline
   fallback). Two-model story from here on: bundled pose model
   (MoveNet, unchanged) + OTA trick model.

---

## 5. ML program (turnip-ml)

**Task reformulation.** Old: fine-tune a pose detector. New: train a
**trick detection + naming model**. Input: pose key sequence
(`T × 17 × 3`, variable length). Output: list of
`(start_frame, end_frame, trick_name)`. This is temporal action
detection with open-vocabulary names, collapsed to a closed label set
via the taxonomy.

**Data.** `GET /api/labels/export?since=` → (pose blob, clip windows,
free-text labels). Curation step: normalize raw strings to canonical
names via `label_taxonomy` (seed from tricking vocabulary; a combo
label like `"hook - scoot - gainer - cartfull (combo)"` splits into
four canonical labels on one window). Raw strings are never discarded.

**Splits.** 80/10/10 stratified by `user_id` — no user's clips leak
across splits. The held-out set stays admin-curated.

**Model.** Baseline: temporal encoder (TCN or small Transformer) over
the keypoint sequence with a detection head; sliding-window classifier
+ NMS is an acceptable MVP. Architecture choice belongs in the
training plan, not here — the contract is the input/output framing.

**Metrics.** Segment quality (mAP at tIoU thresholds) **and** name
accuracy, reported separately. Champion/challenger: promote only on
≥1% validation improvement, as before.

**Export + deploy.** `coremltools` → Core ML, upload to R2,
`POST /api/models`. The app picks it up via the existing OTA poll.

**What stays.** The `PoseAccuracy` harness and its CI gate: it now
guards the *input* to the trick model (pose quality on real footage)
rather than being the thing under training. Fine-tuning MoveNet
itself is off the table unless the pose escalation ladder in the iOS
design doc fires on empirical grounds.

**Trigger.** Nightly cron or manual dispatch; run only when new labels
since the last watermark exceed a threshold (start: 50).

---

## 6. Suggested changes to turnip-ios DESIGN.md

These are suggestions for Hoie to apply to `docs/DESIGN.md` (Rev 8);
this PR does not touch that file.

1. **Backend section** — replace the video-upload/R2-video design with
   §2–§3 of this plan (`sources`, pose blobs, no video bytes). Delete
   every "upload the video" sentence.
2. **Labels** — free-text `TEXT[]`, multiple per clip, labeler-settable
   windows; drop `crop_rects` from the server label model.
3. **ML section** — the pipeline trains a trick detection model
   (pose sequence → segments + names), not a fine-tuned pose model.
4. **Decisions** — #2 (*no classifier at launch*) is reversed: the
   classifier/detector **is** the ML program now. #4 (*keep videos
   forever*) is moot: there are no videos to keep. Add a privacy
   decision: *keypoints + opaque IDs only, never pixels* (this plan
   §1), with the reopen trigger being a deliberate product decision,
   never convenience.
5. **OTA models** — two-model story: bundled MoveNet (pose, unchanged)
   + OTA trick-detection model (replaces the old "pose+action model"
   language).
6. **Labeling UI** — prompt for the trick name, multi-label chips,
   match server clips to local video by `video_id`, skeleton fallback
   when the video is gone.
7. **New section: video identity** — UUID v4 per video, local
   `video_id ↔ PHAsset` mapping, the join key for the whole system.
8. **Social feed** — either defer it explicitly (recommended: Share
   Sheet already covers sharing) or restate it as client-rendered
   skeleton previews. The current server-feed design is incompatible
   with §1.
9. **Problem statement** — the "community labeling + continuous
   training platform" paragraph should now say the community trains
   *trick detection*, and the privacy claim ("nothing leaves your
   device" in the README) becomes literally true for v2 as well.

---

## 7. Open questions

1. **Label taxonomy curation.** Who canonicalizes new free-text names?
   Proposal: seed from standard tricking vocabulary; auto-suggest
   canonical matches in the labeling UI (fuzzy match); a trusted-user
   queue resolves the unmatched remainder.
2. **Auto window suggestions for labelers.** Keep the clip window as
   the suggested label window (yes — reduces labeling effort; the
   labeler tightens when wrong).
3. **Multi-device.** A `video_id` created on the iPhone won't resolve
   on the user's iPad → skeleton fallback covers it. Acceptable?
4. **Pose blob hosting.** R2 presigned PUT (recommended, keeps the
   droplet stateless) vs. direct POST for sub-1MB blobs. Either works;
   pick one in implementation.
5. **Reputation without video.** The existing reputation/spot-check
   design transfers unchanged (it scores *labels*, never footage).
