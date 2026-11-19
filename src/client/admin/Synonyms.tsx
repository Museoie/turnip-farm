import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminError,
  type MergeOutcome,
  type SynonymCandidate,
  type SynonymList,
  type Vocabulary,
  getVocabulary,
  listSynonyms,
  mergeTricks,
} from "./api";

// The maintainer's synonyms page, at /admin/synonyms (BACKEND_DESIGN.md
// §1.2.29, §7.3): the pairs app users sent as one trick, and the merge that
// makes two tricks one for every app and every training label. The same
// list and merge as `bun run labels:synonyms` and `bun run labels:merge`.

const MERGE_NOTE =
  "From the next taxonomy version, every name of the first trick resolves to the second, for every app and in every training export.";

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

function outcomeText(outcome: MergeOutcome): string {
  if (!outcome.merged) return `“${outcome.name}” is already part of “${outcome.canonical}”. Nothing changed.`;
  return (
    `Merged “${outcome.name}” into “${outcome.canonical}” at taxonomy version ${outcome.taxonomy_version}: ` +
    `${outcome.remapped} ${outcome.remapped === 1 ? "name" : "names"} remapped; ` +
    `${outcome.synonyms_dropped} synonym and ${outcome.candidates_dropped} candidate rows dropped.`
  );
}

/** A name and what it resolves to now. */
function NameTag({ name, canonical }: { name: string; canonical: string | null }) {
  return (
    <span className="synonym-name">
      <strong>{name}</strong>
      {canonical === null ? (
        <span className="tag">not in vocabulary</span>
      ) : canonical.toLowerCase() !== name.toLowerCase() ? (
        <span className="tag">= {canonical}</span>
      ) : null}
    </span>
  );
}

/** Asks before a merge, saying which name is kept; `onMerge` runs it. */
function MergeConfirm({
  name,
  into,
  onMerge,
  onCancel,
}: {
  name: string;
  into: string;
  onMerge: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onMerge();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="confirm">
      <p>
        Merge “{name}” into “{into}”? {MERGE_NOTE}
      </p>
      <div className="source-actions">
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void run()}>
          Yes, merge
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PairRow({ pair, onMerge }: { pair: SynonymCandidate; onMerge: (name: string, into: string) => Promise<void> }) {
  // Which way to merge: as sent (keep same_as), or the other way (keep name).
  const [confirming, setConfirming] = useState<"as-sent" | "reversed" | null>(null);
  const settled = pair.name_canonical !== null && pair.name_canonical === pair.same_as_canonical;
  const [from, into] = confirming === "reversed" ? [pair.same_as, pair.name] : [pair.name, pair.same_as];

  return (
    <li className="source-row">
      <div className="source-main">
        <NameTag name={pair.name} canonical={pair.name_canonical} />
        <span className="dim">→</span>
        <NameTag name={pair.same_as} canonical={pair.same_as_canonical} />
        {settled && <span className="tag tag-holdout">already one trick</span>}
      </div>
      <div className="source-meta">
        <span>
          {pair.accounts} {pair.accounts === 1 ? "account" : "accounts"}
        </span>
        <span>First sent {new Date(pair.first_submitted_at).toLocaleString()}</span>
      </div>
      {confirming ? (
        <MergeConfirm
          name={from}
          into={into}
          onMerge={async () => {
            await onMerge(from, into);
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : (
        <div className="source-actions">
          <button className="btn btn-ghost" type="button" disabled={settled} onClick={() => setConfirming("as-sent")}>
            Keep “{pair.same_as}”
          </button>
          <button className="btn btn-ghost" type="button" disabled={settled} onClick={() => setConfirming("reversed")}>
            Keep “{pair.name}”
          </button>
        </div>
      )}
    </li>
  );
}

/** Any two names, typed: for a merge no app user has sent. */
function MergeForm({
  vocabulary,
  onMerge,
}: {
  vocabulary: Vocabulary | null;
  onMerge: (name: string, into: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [into, setInto] = useState("");
  const [confirming, setConfirming] = useState(false);
  const ready = name.trim() !== "" && into.trim() !== "" && name.trim().toLowerCase() !== into.trim().toLowerCase();
  const spellings = useMemo(
    () => [...new Set(vocabulary?.vocabulary.flatMap((e) => [e.canonical, ...e.aliases]) ?? [])].sort(),
    [vocabulary],
  );

  return (
    <div className="merge-form">
      <datalist id="vocabulary-names">
        {spellings.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <label>
        <span className="dim">Merge the trick</span>
        <input
          type="text"
          list="vocabulary-names"
          value={name}
          maxLength={64}
          onChange={(e) => {
            setName(e.target.value);
            setConfirming(false);
          }}
          placeholder="cartwheel full twist"
        />
      </label>
      <label>
        <span className="dim">into the trick</span>
        <input
          type="text"
          list="vocabulary-names"
          value={into}
          maxLength={64}
          onChange={(e) => {
            setInto(e.target.value);
            setConfirming(false);
          }}
          placeholder="cartfull"
        />
      </label>
      {confirming ? (
        <MergeConfirm
          name={name.trim()}
          into={into.trim()}
          onMerge={async () => {
            await onMerge(name, into);
            setConfirming(false);
            setName("");
            setInto("");
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <p>
          <button className="btn btn-primary" type="button" disabled={!ready} onClick={() => setConfirming(true)}>
            Merge
          </button>
        </p>
      )}
    </div>
  );
}

function VocabularyList({ vocabulary }: { vocabulary: Vocabulary }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const entries = vocabulary.vocabulary.filter(
    (e) => q === "" || [e.canonical, ...e.aliases].some((s) => s.toLowerCase().includes(q)),
  );
  return (
    <>
      <p className="dim">
        Taxonomy version {vocabulary.taxonomy_version}: {vocabulary.vocabulary.length}{" "}
        {vocabulary.vocabulary.length === 1 ? "trick" : "tricks"}.
      </p>
      <div className="filter-row">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter"
          aria-label="Filter the vocabulary"
        />
      </div>
      <ul className="vocabulary-list">
        {entries.map((e) => (
          <li key={e.canonical}>
            <strong>{e.canonical}</strong>
            {e.aliases.filter((a) => a !== e.canonical).length > 0 && (
              <span className="dim"> · {e.aliases.filter((a) => a !== e.canonical).join(" · ")}</span>
            )}
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="dim">No trick matches.</p>}
    </>
  );
}

export function SynonymsConsole({ onSignedOut }: { onSignedOut: () => void }) {
  const [min, setMin] = useState(1);
  const [pairs, setPairs] = useState<Load<SynonymList>>({ state: "loading" });
  const [vocabulary, setVocabulary] = useState<Load<Vocabulary>>({ state: "loading" });
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const failed = useCallback(
    (err: unknown): string => {
      if (err instanceof AdminError && err.status === 401) onSignedOut();
      return err instanceof Error ? err.message : "Request failed.";
    },
    [onSignedOut],
  );

  // A newer load (another minimum, a reload after a merge) supersedes one in flight: only the
  // latest request's reply reaches the list.
  const pairsRequest = useRef(0);
  const loadPairs = useCallback(async () => {
    const request = ++pairsRequest.current;
    setPairs({ state: "loading" });
    try {
      const data = await listSynonyms(min);
      if (pairsRequest.current === request) setPairs({ state: "ready", data });
    } catch (err) {
      if (pairsRequest.current === request) setPairs({ state: "error", message: failed(err) });
    }
  }, [min, failed]);

  const loadVocabulary = useCallback(async () => {
    try {
      setVocabulary({ state: "ready", data: await getVocabulary() });
    } catch (err) {
      setVocabulary({ state: "error", message: failed(err) });
    }
  }, [failed]);

  useEffect(() => {
    void loadPairs();
  }, [loadPairs]);
  useEffect(() => {
    void loadVocabulary();
  }, [loadVocabulary]);

  const onMerge = async (name: string, into: string) => {
    setNotice(null);
    try {
      const outcome = await mergeTricks(name, into);
      setNotice({ kind: "ok", text: outcomeText(outcome) });
    } catch (err) {
      setNotice({ kind: "error", text: failed(err) });
      return;
    }
    await Promise.all([loadPairs(), loadVocabulary()]);
  };

  return (
    <>
      {notice && <p className={notice.kind === "error" ? "admin-error" : "admin-notice"}>{notice.text}</p>}

      <section>
        <h2>Sent by app users</h2>
        <p className="dim">
          Pairs of names app users marked as one trick, most accounts first. Nothing changes until you merge one;
          a pair expires 30 days after it was first sent.
        </p>
        <div className="filter-row">
          <label>
            <span className="dim">At least </span>
            <input
              type="number"
              min={1}
              value={min}
              onChange={(e) => setMin(Math.max(1, Math.floor(Number(e.target.value)) || 1))}
              aria-label="Minimum accounts"
            />
            <span className="dim"> {min === 1 ? "account" : "accounts"}</span>
          </label>
        </div>
        {pairs.state === "loading" && <p>Loading…</p>}
        {pairs.state === "error" && <p className="admin-error">{pairs.message}</p>}
        {pairs.state === "ready" && pairs.data.synonyms.length === 0 && <p className="dim">No pairs waiting.</p>}
        {pairs.state === "ready" && pairs.data.truncated && (
          <p className="dim">
            Showing the {pairs.data.synonyms.length} pairs the most accounts sent. Raise the minimum to see the pairs more
            accounts agree on.
          </p>
        )}
        {pairs.state === "ready" && (
          <ul className="source-list">
            {pairs.data.synonyms.map((pair) => (
              <PairRow key={`${pair.name.toLowerCase()}\u0000${pair.same_as.toLowerCase()}`} pair={pair} onMerge={onMerge} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Merge two tricks</h2>
        <p className="dim">
          Any two names, in the vocabulary or not. A name it lacks joins the second trick; a second name it lacks
          becomes a trick of its own.
        </p>
        <MergeForm vocabulary={vocabulary.state === "ready" ? vocabulary.data : null} onMerge={onMerge} />
      </section>

      <section>
        <h2>Vocabulary</h2>
        {vocabulary.state === "loading" && <p>Loading…</p>}
        {vocabulary.state === "error" && <p className="admin-error">{vocabulary.message}</p>}
        {vocabulary.state === "ready" && <VocabularyList vocabulary={vocabulary.data} />}
      </section>
    </>
  );
}
