import { useCallback, useEffect, useRef, useState } from "react";
import { PosePlayer } from "../admin/PosePlayer";
import {
  AdminError,
  type AdminSource,
  type AdminSessionInfo,
  type HoldoutFilter,
  getSession,
  listSources,
  setHoldout,
  shortId,
} from "../admin/api";
import { CANONICAL_HZ, formatSeconds } from "../admin/pose";

// The maintainer's holdout page, at /admin (BACKEND_DESIGN.md §1.2.28,
// §7.3 admin endpoints). The maintainer signs in through the auth service
// (§7.1 "Admin"), which leaves an admin session cookie the endpoints
// check; the page shows nothing until GET /api/admin/session answers.
// It shows no contributor account ids: the endpoints return none.

const MARK_NOTE =
  "Holdout should be footage of people who never contribute: turnip-ml evaluates on it and never trains on it.";
const UNMARK_NOTE = "Unmarked, this source can be trained on again from turnip-ml's next export pull.";

const FILTERS: { value: HoldoutFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "false", label: "Not holdout" },
  { value: "true", label: "Holdout only" },
];

function SourceRow({
  source,
  selected,
  onPlay,
  onSetHoldout,
}: {
  source: AdminSource;
  selected: boolean;
  onPlay: (source: AdminSource) => void;
  onSetHoldout: (source: AdminSource, holdout: boolean) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const names = [...new Set(source.clips.flatMap((c) => c.names))];
  const mark = !source.holdout;

  const confirm = async () => {
    setBusy(true);
    try {
      await onSetHoldout(source, mark);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`source-row${selected ? " is-selected" : ""}`}>
      <div className="source-main">
        <code title={source.id}>{shortId(source.id)}</code>
        {source.holdout && <span className="tag tag-holdout">holdout</span>}
        {source.quarantined && <span className="tag tag-quarantine">quarantined</span>}
        {!source.ingested && <span className="tag">not ingested</span>}
      </div>
      <div className="source-meta">
        <span>Registered {new Date(source.created_at).toLocaleString()}</span>
        {source.ingested && (
          <span>
            {source.ingested_at
              ? `Ingested ${new Date(source.ingested_at).toLocaleString()}`
              : "Ingested (time not recorded)"}
          </span>
        )}
        <span>
          {source.frame_count} frames · {formatSeconds(source.frame_count / CANONICAL_HZ)}
        </span>
        <span>
          {source.clips.length} {source.clips.length === 1 ? "clip" : "clips"}
          {names.length > 0 ? `: ${names.join(", ")}` : ""}
        </span>
      </div>
      {confirming ? (
        <div className="confirm">
          <p>{mark ? MARK_NOTE : UNMARK_NOTE}</p>
          <div className="source-actions">
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void confirm()}>
              {mark ? "Yes, mark as holdout" : "Yes, unmark"}
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="source-actions">
          <button className="btn btn-ghost" type="button" disabled={!source.ingested} onClick={() => onPlay(source)}>
            {selected ? "Playing" : "Play pose"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setConfirming(true)}>
            {mark ? "Mark as holdout" : "Unmark"}
          </button>
        </div>
      )}
    </li>
  );
}

interface Listing {
  sources: AdminSource[];
  cursor: string | null;
  state: "ready" | "loading" | "error";
  message?: string;
}

function useListing(filter: HoldoutFilter, onSignedOut: () => void) {
  const [listing, setListing] = useState<Listing>({ sources: [], cursor: null, state: "loading" });
  // A newer load (a filter change, a reload) supersedes one in flight.
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const requestId = ++requestRef.current;
      setListing((l) => ({ ...l, state: "loading" }));
      try {
        const page = await listSources(filter, cursor);
        if (requestRef.current !== requestId) return;
        setListing((l) => ({
          sources: cursor === null ? page.sources : [...l.sources, ...page.sources],
          cursor: page.next_cursor,
          state: "ready",
        }));
      } catch (err) {
        if (requestRef.current !== requestId) return;
        if (err instanceof AdminError && err.status === 401) onSignedOut();
        setListing((l) => ({ ...l, state: "error", message: err instanceof Error ? err.message : "Request failed." }));
      }
    },
    [filter, onSignedOut],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const replace = (updated: AdminSource) =>
    setListing((l) => ({
      ...l,
      sources: l.sources
        .map((s) => (s.id === updated.id ? updated : s))
        .filter((s) => filter === "all" || s.holdout === (filter === "true")),
    }));

  return { listing, reload: () => load(null), more: () => load(listing.cursor), replace };
}

function SourceList({
  listing,
  empty,
  selectedId,
  onPlay,
  onSetHoldout,
  onMore,
}: {
  listing: Listing;
  empty: string;
  selectedId: string | null;
  onPlay: (source: AdminSource) => void;
  onSetHoldout: (source: AdminSource, holdout: boolean) => Promise<void>;
  onMore: () => void;
}) {
  return (
    <>
      {listing.state === "error" && <p className="admin-error">{listing.message}</p>}
      {listing.sources.length === 0 && listing.state === "ready" && <p className="dim">{empty}</p>}
      <ul className="source-list">
        {listing.sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            selected={source.id === selectedId}
            onPlay={onPlay}
            onSetHoldout={onSetHoldout}
          />
        ))}
      </ul>
      {listing.state === "loading" && <p>Loading…</p>}
      {listing.cursor !== null && listing.state !== "loading" && (
        <p>
          <button className="btn btn-ghost" type="button" onClick={onMore}>
            Load more
          </button>
        </p>
      )}
    </>
  );
}

function Console({ session, onSignedOut }: { session: AdminSessionInfo; onSignedOut: () => void }) {
  const [filter, setFilter] = useState<HoldoutFilter>("all");
  const [selected, setSelected] = useState<AdminSource | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const playerRef = useRef<HTMLElement>(null);
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedId]);
  const holdouts = useListing("true", onSignedOut);
  const browse = useListing(filter, onSignedOut);

  const onSetHoldout = async (source: AdminSource, holdout: boolean) => {
    setActionError(null);
    try {
      await setHoldout(source.id, holdout);
    } catch (err) {
      if (err instanceof AdminError && err.status === 401) onSignedOut();
      setActionError(err instanceof Error ? err.message : "The change failed.");
      return;
    }
    const updated = { ...source, holdout };
    browse.replace(updated);
    if (selected?.id === source.id) setSelected(updated);
    await holdouts.reload();
  };

  return (
    <>
      <form className="admin-session" method="post" action="/auth/logout">
        <span className="dim">Signed in as {session.username}</span>
        <button className="btn btn-ghost" type="submit">
          Sign out
        </button>
      </form>
      {actionError && <p className="admin-error">{actionError}</p>}

      <section>
        <h2>Current holdouts</h2>
        <SourceList
          listing={holdouts.listing}
          empty="No source is flagged as holdout. turnip-ml won't train until at least one is."
          selectedId={selected?.id ?? null}
          onPlay={setSelected}
          onSetHoldout={onSetHoldout}
          onMore={() => void holdouts.more()}
        />
      </section>

      {selected && (
        <section ref={playerRef}>
          <h2>
            Pose <code title={selected.id}>{shortId(selected.id)}</code>
          </h2>
          <PosePlayer source={selected} onSignedOut={onSignedOut} />
        </section>
      )}

      <section>
        <h2>Sources</h2>
        <p className="dim">Newest first. Durations are at the canonical 10 Hz.</p>
        <div className="filter-row" role="radiogroup" aria-label="Holdout filter">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              className={`btn ${filter === f.value ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <SourceList
          listing={browse.listing}
          empty="No sources match."
          selectedId={selected?.id ?? null}
          onPlay={setSelected}
          onSetHoldout={onSetHoldout}
          onMore={() => void browse.more()}
        />
      </section>
    </>
  );
}

// Why /auth/callback sent the browser back without a session (auth/admin.ts).
const SIGN_IN_FAILURES: Record<string, string> = {
  failed: "The sign-in didn't complete. Try again.",
  unavailable: "The sign-in service is unreachable. Try again shortly.",
  forbidden: "This account doesn't have the admin role on the farm.",
  mfa_required: "Admin access needs a sign-in with a second factor. Set one up on your account, then sign in again.",
};

type PageState =
  | { kind: "checking" }
  | { kind: "off" }
  | { kind: "signed-out"; notice: string | null }
  | { kind: "error"; message: string }
  | { kind: "signed-in"; session: AdminSessionInfo };

export function AdminPage() {
  const [state, setState] = useState<PageState>({ kind: "checking" });

  useEffect(() => {
    const previous = document.title;
    document.title = "Turnip — Holdouts";
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("signin");
    const notice = reason === null ? null : (SIGN_IN_FAILURES[reason] ?? SIGN_IN_FAILURES.failed!);
    if (reason !== null) window.history.replaceState(null, "", "/admin");
    getSession()
      .then((session) => setState({ kind: "signed-in", session }))
      .catch((err: unknown) => {
        if (err instanceof AdminError && err.status === 404) setState({ kind: "off" });
        else if (err instanceof AdminError && err.status === 401) setState({ kind: "signed-out", notice });
        else setState({ kind: "error", message: err instanceof Error ? err.message : "The farm could not be reached." });
      });
  }, []);

  const onSignedOut = useCallback(() => {
    setState({ kind: "signed-out", notice: "Your admin session ended. Sign in again." });
  }, []);

  return (
    <main className="page admin">
      <div className="wrap">
        <h1>Holdouts</h1>
        <p className="lead">The curated holdout: sources turnip-ml evaluates on and never trains on.</p>
        {state.kind === "checking" && <p>Checking your session…</p>}
        {state.kind === "off" && <p>Admin sign-in isn't configured on this farm (the AUTH_* settings are unset).</p>}
        {state.kind === "error" && <p className="admin-error">{state.message}</p>}
        {state.kind === "signed-out" && (
          <>
            {state.notice && <p className="admin-error">{state.notice}</p>}
            <p>
              <a className="btn btn-primary" href="/auth/login">
                Sign in
              </a>
            </p>
          </>
        )}
        {state.kind === "signed-in" && <Console session={state.session} onSignedOut={onSignedOut} />}
      </div>
    </main>
  );
}
