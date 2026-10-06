# Turnip Farm — Database + API Design

**Scope.** This document is the detailed backend design for `turnip-farm`,
implementing the contract in the master plan
(`https://github.com/hoiekim/turnip-farm/blob/main/docs/MASTER_PLAN.md`,
merged Rev 3). It specifies the Postgres schema, index strategy, upsert
semantics, the training-data export pattern, and the full REST API, at a
level of detail intended to be implementable without guessing. Companion
documents: the `TKP1` wire-format specification (`TKP1.md`); the iOS
contribution design and the ML training design are specified separately.
Stack: Bun + TypeScript + Postgres + R2, per the master plan.

## 1. Design decisions

### 1.1 Labels: Clip → Label is one-to-many (explicit decision)

The master plan states the hierarchy **Source → Clip → Label, one-to-many
at every level**, but its drafted schema also said `labels.clip_id UNIQUE`
with exactly one label row per clip holding a `TEXT[]` of trick names —
which is effectively Clip → Label one-to-one with the multiplicity pushed
into an array column. This document resolves that inconsistency **in favor
of the stated one-to-many hierarchy**:

- **One label row per `(clip_id, trick_name)`.**
- Each row carries its own `taxonomy_version`, `created_at`, `updated_at`.
- Re-submission of a clip's labels **replaces the clip's whole label set in
  a single transaction** (DELETE existing rows for the clip, INSERT the new
  set). No merge logic, no array surgery.

**Rationale.** The maintainer specified one-to-many at every level; per-name
rows make per-name provenance exact (which taxonomy version was in effect
when *that* name was confirmed, when it was first seen) instead of smearing
it across an array; set-replacement keeps the client's "confirm →
contribute" flow idempotent; and `UNIQUE(clip_id, trick_name)` gives the
database, not application code, the job of deduplicating re-submissions.

Two departures from the master plan's label draft follow from this:

- **No per-label `user_id`.** Only the clip owner ever submits labels (the
  confirmed contribution flow has no community labeling queue), so
  attribution is `labels → clips → sources.user_id` — which is also the
  attribution the quarantine flow uses. A per-label `user_id` would be a
  second source of truth for the same fact.
- **No per-label `start_frame` / `end_frame`.** The label window *is* the
  clip window. The training target is one segment per confirmed clip window
  (master plan §6), so a second, label-level window is redundant. If a
  labeler tightens a window, they edit the clip and re-confirm.

### 1.2 Judgment calls (master plan silent or ambiguous)

1. `models.sha256` added — the model manifest must carry a checksum
   (master plan §4), so the digest lives on the row.
2. `data_quarantine.metrics JSONB` kept from the master plan draft — a
   snapshot of the regression metrics that triggered the quarantine, for
   the review queue.
3. **Purge = hard delete of the source row** (cascades to clips/labels;
   the R2 blob is deleted too). Consequence: "exclude quarantined sources
   from training" is implemented as "exclude sources with an *open*
   (unresolved) quarantine row". A released source rejoins training; a
   purged source is gone entirely.
4. One open quarantine per source, enforced by a partial unique index.
5. Single-resource GETs return **404 (not 403)** for resources the caller
   does not own, so resource IDs are not usable as an ownership oracle.
6. Follows the master plan's `GET /api/models/current` naming for the
   model manifest endpoint (an earlier draft used `/latest`).
7. Pipeline endpoints (`POST /api/models`, `GET /api/labels/export`)
   authenticate with a **service API key**, not Sign in with Apple.
8. Current taxonomy version = `max(taxonomy_version)` over
   `label_taxonomy`; the seed migration inserts version 1, so it is always
   defined.
9. `r2_key` is deterministic: `poses/<source_id>.tkp1.gz`.
   Re-contribution overwrites the same key.
10. Blob integrity is verified **server-side at clip-submission time**
    (fetch the R2 object, compare SHA-256 against `sources.sha256`).
    A source row registered but never uploaded is a harmless dangling row
    that self-heals on re-contribution.
11. `updated_at` is set explicitly in every upsert's `DO UPDATE` clause;
    no database triggers.
12. Label names are trimmed at the API boundary; uniqueness is on
    `(clip_id, lower(trick_name))`; the original casing is preserved in
    storage and the raw string is never altered.
13. **Source ownership is first-writer-wins.** `user_id` is never
    overwritten on source upsert. Rationale: for imported files the
    `video_id` is `SHA-256(file bytes)`, so two contributors importing the
    byte-identical file compute the identical ID (master plan §1 caveat).
    Transferring ownership to the second writer would let strangers claim
    each other's sources; keeping the first writer also matches the dedup
    intent (the second identical contribution carries no new bytes). A
    second contributor registering an already-claimed `video_id` receives
    `409 SOURCE_ALREADY_CLAIMED`.

## 2. Conventions

- Postgres 16+. Additive migrations via `dbmate` (`db/migrations/`),
  never destructive; every migration is additive and re-runnable.
- `CREATE EXTENSION IF NOT EXISTS pgcrypto;` for `gen_random_uuid()`.
- All timestamps `TIMESTAMPTZ`, `DEFAULT now()`.
- Identifiers: `sources.id` is the deterministic 64-char lowercase hex
  digest from the client; `clips.id` is a client-minted UUIDv4 the farm
  never mints; every other PK is `gen_random_uuid()`.
- No PII columns anywhere (see §9).

## 3. Tables

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  -- Sign in with Apple `sub` claim: per-app opaque pseudonymous subject.
  -- No name, email, or other Apple profile data is stored.
  reputation  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  is_blocked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id              CHAR(64) PRIMARY KEY,
  -- Deterministic video_id (master plan §1): SHA-256 hex of
  -- "turnip:phasset:" + PHAsset.localIdentifier (Photos videos) or of the
  -- file bytes (imports). The farm never mints source identities.
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frame_count     INTEGER NOT NULL CHECK (frame_count > 0),
  -- Canonical 10 Hz frame count of the stored pose sequence. The client
  -- computes it from its analysis rate via the TKP1 §6 resampling map;
  -- clip windows are validated against it, so every index the API
  -- accepts is canonical.
  sample_rate     REAL NOT NULL,
  -- As-sent analysis rate, provenance only. Stored pose data is canonical
  -- 10 Hz TKP1 (see TKP1.md §6).
  keypoint_format TEXT NOT NULL DEFAULT 'tkp1',
  r2_key          TEXT NOT NULL,
  -- Deterministic: poses/<id>.tkp1.gz. Re-contribution overwrites.
  sha256          CHAR(64) NOT NULL,
  -- Hex digest of the .tkp1.gz blob BYTES (integrity), distinct from `id`
  -- (digest of the asset identity). Verified at clip-submission time.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sources_id_hex  CHECK (id     ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sources_sha_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX sources_user_id_idx ON sources (user_id);

CREATE TABLE clips (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-minted once per clip; recovered from the server after
  -- reinstall (master plan §5.1), never re-derived, never minted here.
  source_id     CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  start_frame   INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame     INTEGER NOT NULL CHECK (end_frame > start_frame),
  -- Frame indices into the source's canonical 10 Hz pose sequence.
  -- end_frame <= sources.frame_count is enforced at the API layer
  -- (cross-table CHECKs are not expressible in Postgres).
  auto_detected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clips_source_id_idx ON clips (source_id);

CREATE TABLE labels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id          UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  trick_name       TEXT NOT NULL
                   CHECK (trick_name <> '' AND trick_name = btrim(trick_name)),
  -- Free text, stored trimmed and verbatim (casing preserved).
  -- Canonicalization happens at training-curation time via label_taxonomy.
  taxonomy_version INTEGER NOT NULL,
  -- Vocabulary version in effect when THIS name was confirmed.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX labels_clip_trick_uniq
  ON labels (clip_id, lower(trick_name));

CREATE TABLE label_taxonomy (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw              TEXT NOT NULL,
  canonical        TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  -- Monotonic int, bumped when canonical names are added or changed.
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT label_taxonomy_raw_version_uniq UNIQUE (raw, taxonomy_version)
);
CREATE INDEX label_taxonomy_lookup_idx
  ON label_taxonomy (raw, taxonomy_version DESC);

CREATE TABLE models (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version          TEXT NOT NULL UNIQUE,
  -- e.g. trickdet-20261006-01. Immutable: a version is never re-published.
  model_type       TEXT NOT NULL DEFAULT 'trick-detection'
                   CHECK (model_type = 'trick-detection'),
  taxonomy_version INTEGER NOT NULL,
  -- Vocabulary version the model trained on.
  r2_key           TEXT NOT NULL,
  sha256           CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Digest of the model artifact bytes; shipped in the manifest so the
  -- client can verify the download.
  val_metrics      JSONB NOT NULL DEFAULT '{}',
  promoted_at      TIMESTAMPTZ,
  -- NULL = trained but not champion. The current model is the row with the
  -- greatest non-null promoted_at.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_quarantine (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      CHAR(64) NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who uploaded the bad data (master plan §6 attribution).
  reason         TEXT NOT NULL,
  metrics        JSONB,
  -- Snapshot of the regression metrics that triggered the quarantine.
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT CHECK (resolution IN ('released', 'purged')),
  CONSTRAINT quarantine_resolution_consistent CHECK (
    (resolved_at IS NULL  AND resolution IS NULL) OR
    (resolved_at IS NOT NULL AND resolution IS NOT NULL)
  )
);
CREATE UNIQUE INDEX data_quarantine_open_uniq
  ON data_quarantine (source_id) WHERE resolved_at IS NULL;
CREATE INDEX data_quarantine_open_idx
  ON data_quarantine (quarantined_at) WHERE resolved_at IS NULL;

CREATE TABLE reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type      TEXT NOT NULL CHECK (target_type IN ('source', 'clip', 'label')),
  target_id        TEXT NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at)
  WHERE status = 'open';
```

The seed migration inserts the version-1 taxonomy rows, e.g.:

```sql
INSERT INTO label_taxonomy (raw, canonical, taxonomy_version) VALUES
  ('cork', 'cork', 1),
  ('corkscrew', 'cork', 1),
  ('gainer', 'gainer', 1),
  ('cartfull', 'cartfull', 1),
  ('hook', 'hook', 1),
  ('scoot', 'scoot', 1)
ON CONFLICT (raw, taxonomy_version) DO NOTHING;
```

(The real seed list comes from the standard tricking vocabulary; the
curation process itself is a separate concern — master plan §9 Q1.)

## 4. Upsert semantics

Every write is keyed on a client-supplied identity, which is what makes
re-submission idempotent. No `Idempotency-Key` header is needed; the IDs
*are* the idempotency keys.

**`users`** — identity row; immutable on the contribution path:

```sql
INSERT INTO users (id) VALUES ($1)
ON CONFLICT (id) DO NOTHING;
```

`reputation` / `is_blocked` change only through the moderation path, never
as a side effect of contribution.

**`sources`** — full replace on re-contribution, except ownership:

```sql
INSERT INTO sources
  (id, user_id, frame_count, sample_rate, keypoint_format, r2_key, sha256, updated_at)
VALUES ($1, $2, $3, $4, $5, 'poses/' || $1 || '.tkp1.gz', $6, now())
ON CONFLICT (id) DO UPDATE SET
  -- user_id is deliberately NOT overwritten: first writer wins (§1.2.13).
  frame_count     = EXCLUDED.frame_count,
  sample_rate     = EXCLUDED.sample_rate,
  keypoint_format = EXCLUDED.keypoint_format,
  r2_key          = EXCLUDED.r2_key,
  sha256          = EXCLUDED.sha256,
  updated_at      = now();
```

**`clips`** — batch upsert, one statement for the whole batch:

```sql
INSERT INTO clips
  (id, source_id, start_frame, end_frame, auto_detected, updated_at)
VALUES (...), (...)
ON CONFLICT (id) DO UPDATE SET
  source_id     = EXCLUDED.source_id,
  start_frame   = EXCLUDED.start_frame,
  end_frame     = EXCLUDED.end_frame,
  auto_detected = EXCLUDED.auto_detected,
  updated_at    = now();
```

**`labels`** — never upserted per-row; the whole set per clip is replaced
(§5).

**`label_taxonomy`** — mappings are immutable per version (curation path):

```sql
INSERT INTO label_taxonomy (raw, canonical, taxonomy_version)
VALUES ($1, $2, $3)
ON CONFLICT (raw, taxonomy_version) DO NOTHING;
```

**`models`** — versions are never re-published:

```sql
INSERT INTO models
  (version, taxonomy_version, r2_key, sha256, val_metrics, promoted_at)
VALUES ($1, $2, $3, $4, $5, now())
ON CONFLICT (version) DO NOTHING;
-- rowcount 0 → 409 VERSION_EXISTS
```

**`data_quarantine`** — plain append-only `INSERT`; the partial unique
index rejects a second open quarantine for the same source.

## 5. Label-set replacement transaction

`POST /api/clips` (batch) and `POST /api/clips/:id/labels` converge on one
primitive: **replace the label set of a clip**. It runs inside the same
transaction as the clip upserts, so a batch is all-or-nothing:

```sql
BEGIN;

-- 1. current taxonomy version, once per transaction
SELECT max(taxonomy_version) INTO v_tax FROM label_taxonomy;

-- 2. clip upserts (§4)

-- 3. per clip in the batch:
DELETE FROM labels WHERE clip_id = $1;
INSERT INTO labels (clip_id, trick_name, taxonomy_version)
SELECT $1, trim(name), v_tax
FROM unnest($2::text[]) AS name
WHERE trim(name) <> '';
-- (empty array → DELETE only; the clip is left unlabeled)

COMMIT;
```

Properties:

- **Idempotent.** Submitting the same set twice yields the same rows
  (same `(clip_id, lower(trick_name))`, fresh timestamps on the second
  write — timestamps are provenance, not identity).
- **Atomic.** A batch that fails validation rolls back entirely; the
  farm never holds half a contribution.
- **No merge logic.** The client is the source of truth for "what are
  this clip's names right now"; the farm does not diff.

## 6. Training-data queries (quarantine exclusion)

The training export must exclude quarantined sources. Because a purge
hard-deletes the source row (§1.2.3), "quarantined" for training purposes
means **has an open (unresolved) quarantine row**:

```sql
SELECT s.id            AS source_id,
       s.user_id,                       -- for user-stratified splits
       s.r2_key,
       s.sha256        AS blob_sha256,
       c.id            AS clip_id,
       c.start_frame,
       c.end_frame,
       l.trick_name,                    -- raw; canonicalized via label_taxonomy
       l.taxonomy_version,
       GREATEST(s.updated_at, c.updated_at, l.updated_at) AS row_cursor
FROM sources s
JOIN clips  c ON c.source_id = s.id
JOIN labels l ON l.clip_id   = c.id
LEFT JOIN data_quarantine q
       ON q.source_id = s.id AND q.resolved_at IS NULL
WHERE q.id IS NULL
  AND GREATEST(s.updated_at, c.updated_at, l.updated_at) > $1  -- since cursor
ORDER BY row_cursor ASC
LIMIT 10000;
```

Notes:

- Sources with no labels contribute no rows. (Unlabeled *regions* of
  labeled sources serve as background negatives — derived from clip
  windows, not from label-less sources.)
- `next_cursor` = `max(row_cursor)` over the returned rows; the training
  job passes it back as `since`.
- Canonicalization (`raw → canonical`) happens in the training job using
  the `taxonomy` block shipped with the export response (§7,
  `GET /api/labels/export`), not in SQL.

## 7. API

Base path `/api`. JSON request/response bodies, UTF-8. Timestamps are
RFC 3339 (`2026-10-06T07:30:00Z`).

### 7.1 Authentication

**Client (all endpoints except the two pipeline endpoints):** Sign in with
Apple. The client sends `Authorization: Bearer <apple-identity-token>`.
The farm verifies the JWT on every request (stateless; Apple's JWKS
cached): RS256 signature, `iss = https://appleid.apple.com`,
`aud` = the app's client ID, `exp` within a small clock-skew leeway.
The `sub` claim becomes `users.id` (upserted on first sight). Every query
is scoped with `user_id = <sub>`; there is no cross-user access.

**Pipeline** (`POST /api/models`, `GET /api/labels/export`): pre-shared
service key, `Authorization: Bearer <TURNIP_PIPELINE_KEY>`.

Blocked users (`users.is_blocked`) receive `403 ACCOUNT_BLOCKED` on all
endpoints.

### 7.2 Conventions

- **Idempotency** comes from client-supplied IDs (§4); no extra headers.
- **Errors** share one shape:

  ```json
  {"error": {"code": "VALIDATION_ERROR", "message": "...", "details": {}}}
  ```

  Codes: `UNAUTHENTICATED` (401), `ACCOUNT_BLOCKED` (403), `NOT_FOUND`
  (404), `VALIDATION_ERROR` (422), `UNSUPPORTED_FORMAT` (422),
  `BLOB_MISSING` (422), `BLOB_DIGEST_MISMATCH` (422),
  `SOURCE_ALREADY_CLAIMED` (409), `VERSION_EXISTS` (409),
  `RATE_LIMITED` (429), `INTERNAL` (500).
- **Ownership privacy:** single-resource GETs return `404 NOT_FOUND`
  (not 403) when the resource exists but belongs to another user.
- **Rate limiting:** per-user token bucket on POST endpoints
  (suggested: 60 requests/minute; `429 RATE_LIMITED` with
  `Retry-After`).

### 7.3 Endpoints

#### `POST /api/sources` — register a source, get the blob upload URL

Request:

```json
{
  "video_id": "<64-char lowercase hex>",
  "frame_count": 600,
  "sample_rate": 10.0,
  "keypoint_format": "tkp1",
  "sha256": "<64-char hex digest of the .tkp1.gz blob bytes>"
}
```

Validation: `video_id` and `sha256` match `^[0-9a-f]{64}$`;
`frame_count > 0`; `sample_rate` within the client's analysis range;
`keypoint_format` must be `tkp1` (anything else →
`422 UNSUPPORTED_FORMAT`).

Behavior: upserts the source row per §4 (`r2_key =
poses/<video_id>.tkp1.gz`; `user_id` never overwritten on conflict). If
the conflicting row belongs to a different user →
`409 SOURCE_ALREADY_CLAIMED` (the farm already holds these exact bytes).

Response (`201` new, `200` re-registered):

```json
{
  "source_id": "<video_id>",
  "r2_key": "poses/<video_id>.tkp1.gz",
  "upload_url": "<presigned R2 PUT, 15-minute expiry>",
  "upload_expires_at": "2026-10-06T08:00:00Z",
  "blob_present": false
}
```

`blob_present` is determined by the farm HEADing the R2 object at
registration time; when true, the client skips the PUT and goes straight
to clip submission. `frame_count` is the canonical 10 Hz count (client
computes it per TKP1 §6); clip windows submitted later are validated
against it, so the whole API speaks canonical indices.

The client then `PUT`s the `.tkp1.gz` blob to `upload_url` with
`Content-Type: application/gzip`, then submits clips (§7.3
`POST /api/clips`). A source row with no blob yet is a harmless dangling
row; it self-heals when the client re-registers and uploads.

#### `POST /api/clips` — batch upsert clips + replace their label sets

Request:

```json
{
  "clips": [
    {
      "clip_id": "<uuidv4, client-minted>",
      "source_id": "<64-char hex>",
      "start_frame": 120,
      "end_frame": 175,
      "auto_detected": false,
      "labels": ["cork"]
    }
  ]
}
```

Behavior, in a single transaction:

1. For each clip: the source must exist **and** belong to the caller,
   else the whole batch fails with `404 NOT_FOUND`.
2. `0 <= start_frame < end_frame <= source.frame_count`, else
   `422 VALIDATION_ERROR` (with the batch index and field in `details`).
3. **Blob verification** (once per distinct source in the batch): fetch
   the R2 object at `r2_key`; if absent → `422 BLOB_MISSING`; if its
   SHA-256 differs from `sources.sha256` → `422 BLOB_DIGEST_MISMATCH`.
   The client re-uploads via `POST /api/sources` and retries.
4. Upsert the clip rows (§4).
5. Replace each clip's label set (§5); `labels` is optional per clip and
   may be `[]` (clears the set).

Response `200`:

```json
{
  "clips": [
    {"clip_id": "<uuid>", "labels": ["cork"], "taxonomy_version": 3}
  ]
}
```

`labels` entries are trimmed; blank entries are dropped; duplicates
(case-insensitive) collapse via the unique index.

#### `POST /api/clips/:id/labels` — replace one clip's label set

Request:

```json
{"labels": ["hook", "scoot", "gainer", "cartfull"]}
```

Behavior: the clip must exist and belong to the caller (`404`
otherwise); runs the §5 replacement for that clip only. Idempotent:
submitting the current set is a no-op semantically.

Response `200`:

```json
{"clip_id": "<uuid>", "labels": ["hook", "scoot", "gainer", "cartfull"], "taxonomy_version": 3}
```

#### `GET /api/sources` — list my sources (reinstall reconciliation)

Query params: `limit` (default 100, max 1000), `cursor` (opaque;
`updated_at` of the last item from the previous page).

Response `200`:

```json
{
  "sources": [
    {
      "id": "<video_id>",
      "frame_count": 600,
      "clip_count": 2,
      "label_count": 3,
      "updated_at": "2026-10-06T07:00:00Z"
    }
  ],
  "next_cursor": "<opaque>"  // null when exhausted
}
```

`clip_count` / `label_count` come from `count()` over the joins; sources
with no clips report `0`/`0` (e.g. registered but never confirmed).

#### `GET /api/sources/:id` — source with confirmed clips + labels

Response `200` (`404` if missing or not mine):

```json
{
  "source": {
    "id": "<video_id>",
    "frame_count": 600,
    "sample_rate": 10.0,
    "keypoint_format": "tkp1",
    "sha256": "<blob digest>",
    "created_at": "2026-10-06T07:00:00Z",
    "updated_at": "2026-10-06T07:00:00Z"
  },
  "clips": [
    {
      "id": "<uuid>",
      "start_frame": 120,
      "end_frame": 175,
      "auto_detected": false,
      "labels": [
        {"trick_name": "cork", "taxonomy_version": 3, "created_at": "..."}
      ]
    }
  ]
}
```

This is the reinstall-reconciliation read: the client recomputes its
`video_id`s, lists sources, and pulls each source's clips + labels,
adopting the server's clip IDs into its rebuilt local state (master
plan §5.1).

#### `GET /api/sources/:id/pose` — owner-only pose blob download

Response `200` (`404` if missing or not mine):

```json
{
  "url": "<presigned R2 GET for poses/<id>.tkp1.gz, 15-minute expiry>",
  "expires_at": "2026-10-06T08:00:00Z"
}
```

Used by a device that no longer holds the local video (reinstall
restore, cross-device) to render skeleton previews from keypoints alone.
Presigned per request, scoped to the single blob; the owner-only rule is
what keeps one contributor's pose sequences from ever being downloadable
by another.

#### `DELETE /api/sources/:id` — owner-only hard delete

Deletes the R2 blob and the source row; clips, labels, and quarantine
rows cascade. `204` on success (`404` if missing or not mine). This is
the "keep forever, user-deletable" retention posture (master plan §4).

#### `GET /api/models/current` — trick-model manifest

Response `200`:

```json
{
  "version": "trickdet-20261006-01",
  "model_type": "trick-detection",
  "taxonomy_version": 3,
  "url": "<presigned R2 GET, 15-minute expiry>",
  "sha256": "<64-char hex of the artifact bytes>",
  "val_metrics": {"seg_map_05": 0.62, "name_accuracy": 0.81},
  "vocabulary": [
    {"canonical": "cork", "aliases": ["cork", "corkscrew"]},
    {"canonical": "gainer", "aliases": ["gainer"]}
  ],
  "promoted_at": "2026-10-06T06:00:00Z"
}
```

`vocabulary` is built from `label_taxonomy` at the model's
`taxonomy_version`: one entry per canonical name, `aliases` = every raw
string mapped to it. The client verifies the download against `sha256`
before installing. `404 NO_MODEL` when nothing has been promoted yet.

#### `POST /api/models` — pipeline publishes the champion (service key)

Request:

```json
{
  "version": "trickdet-20261006-01",
  "taxonomy_version": 3,
  "r2_key": "models/trickdet-20261006-01.mlmodelc.zip",
  "sha256": "<64-char hex>",
  "val_metrics": {"seg_map_05": 0.62, "name_accuracy": 0.81}
}
```

Behavior: inserts per §4 with `promoted_at = now()`; an existing
`version` → `409 VERSION_EXISTS` (bump the version instead). Response
`201`: `{"id": "<uuid>", "version": "...", "promoted_at": "..."}`.

#### `GET /api/labels/export?since=` — training pull (service key)

`since` is an RFC 3339 cursor (`row_cursor` from §6); omit for a full
pull. Returns label-granular rows (one per label row), quarantined
sources excluded, ordered by cursor ascending, `limit` 10000:

```json
{
  "rows": [
    {
      "source_id": "<video_id>",
      "user_id": "<apple sub>",
      "r2_key": "poses/<video_id>.tkp1.gz",
      "blob_sha256": "<64-char hex>",
      "clip_id": "<uuid>",
      "start_frame": 120,
      "end_frame": 175,
      "trick_name": "cork",
      "taxonomy_version": 3
    }
  ],
  "taxonomy": [
    {"raw": "corkscrew", "canonical": "cork", "taxonomy_version": 3}
  ],
  "next_cursor": "2026-10-06T07:00:00Z"
}
```

`taxonomy` carries the `(raw → canonical)` mappings for the versions
present in `rows`, so the training job canonicalizes without a second
call. The training job resolves each row's `r2_key` to pose bytes itself
(R2 access, verifying `blob_sha256`).

#### `POST /api/reports` — report a bad label/clip

Request:

```json
{"target_type": "clip", "target_id": "<uuid>", "reason": "wrong trick name"}
```

`target_type` ∈ `source | clip | label`. Response `201`:
`{"id": "<report uuid>"}`. Reports are a moderation queue for future
use; they do not change training data by themselves.

## 8. What the farm never accepts or stores

Restating the privacy boundary (master plan §1) as an implementation
checklist:

- No video pixels, audio, thumbnails, or contact sheets — in any table,
  blob, log, or error payload.
- No location, EXIF, photo-library identifiers, or device identifiers.
  The `PHAsset.localIdentifier` **never leaves the device**; the farm
  sees only its SHA-256-derived digest, which it cannot reverse.
- No Apple profile data beyond the `sub` claim: no name, no email.
- R2 keys contain only the opaque source ID
  (`poses/<video_id>.tkp1.gz`); presigned URLs are per-request,
  single-blob, short-lived.
- Request logs must not record Apple identity tokens; error payloads
  must not echo pose data.

## 9. Open questions

1. **Pipeline key management.** Who issues and rotates
   `TURNIP_PIPELINE_KEY`, and where is it stored? (Ops decision.)
2. **Reputation formula.** The master plan names `users.reputation` but
   specifies no algorithm. Training-time sampling weights and any
   contributor-facing effects need a definition before Phase 3.
3. **Apple token verification cost.** Specified as stateless
   per-request verification; revisit with caching if the contribution
   endpoints get hot.
4. **R2 topology.** Bucket, region, and presigned-URL TTL policy are ops
   details not specified here (15-minute TTLs assumed above).
5. **Taxonomy curation.** Who canonicalizes new free-text names and
   bumps `taxonomy_version` (master plan §9 Q1) — the versioning
   mechanics are specified here; the human process is not.
