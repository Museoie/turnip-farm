import { useCallback, useEffect, useRef, useState } from "react";

// Read-only status page for the farm. It reads only the public GET
// endpoints (BACKEND_DESIGN.md §7.3, §1.2.19): the health check, the
// current vocabulary, and the current champion model. Nothing here
// authenticates, and the page never renders the model's presigned R2 URL
// or object key — those stay out of the visible page even though the
// endpoint returns them.

interface VocabularyEntry {
  canonical: string;
  aliases: string[];
}

interface TaxonomyResponse {
  taxonomy_version: number;
  vocabulary: VocabularyEntry[];
}

interface ModelResponse {
  version: string;
  model_type: string;
  taxonomy_version: number;
  min_client_version: string | null;
  byte_size: number | null;
  promoted_at: string;
  val_metrics: Record<string, unknown>;
  name_metrics: Record<string, unknown>;
}

type Section<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "empty" }
  | { state: "error"; message: string };

async function fetchJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body (a proxy or gateway error page) reads as no body.
  }
  return { status: res.status, body };
}

function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isTaxonomy(body: unknown): body is TaxonomyResponse {
  if (typeof body !== "object" || body === null) return false;
  const { taxonomy_version: version, vocabulary } = body as {
    taxonomy_version?: unknown;
    vocabulary?: unknown;
  };
  return (
    typeof version === "number" &&
    Array.isArray(vocabulary) &&
    vocabulary.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { canonical?: unknown }).canonical === "string" &&
        Array.isArray((entry as { aliases?: unknown }).aliases),
    )
  );
}

function isModel(body: unknown): body is ModelResponse {
  if (typeof body !== "object" || body === null) return false;
  const m = body as { version?: unknown; model_type?: unknown };
  return typeof m.version === "string" && typeof m.model_type === "string";
}

function humanBytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function App() {
  const [health, setHealth] = useState<Section<{ status: string }>>({ state: "loading" });
  const [taxonomy, setTaxonomy] = useState<Section<TaxonomyResponse>>({ state: "loading" });
  const [model, setModel] = useState<Section<ModelResponse>>({ state: "loading" });
  // A refresh supersedes the load in flight; stale responses are ignored.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setHealth({ state: "loading" });
    setTaxonomy({ state: "loading" });
    setModel({ state: "loading" });

    const [healthRes, taxonomyRes, modelRes] = await Promise.allSettled([
      fetchJson("/healthz"),
      fetchJson("/api/taxonomy/current"),
      fetchJson("/api/models/current"),
    ]);
    if (requestRef.current !== requestId) return;

    if (healthRes.status === "fulfilled" && healthRes.value.status === 200) {
      setHealth({ state: "ready", data: { status: "ok" } });
    } else {
      setHealth({ state: "error", message: "The farm did not answer the health check." });
    }

    if (taxonomyRes.status === "fulfilled") {
      const { status, body } = taxonomyRes.value;
      if (status === 200 && isTaxonomy(body)) {
        setTaxonomy({ state: "ready", data: body });
      } else {
        setTaxonomy({ state: "error", message: `Vocabulary request failed (HTTP ${status}).` });
      }
    } else {
      setTaxonomy({ state: "error", message: "Vocabulary request failed." });
    }

    if (modelRes.status === "fulfilled") {
      const { status, body } = modelRes.value;
      if (status === 200 && isModel(body)) {
        setModel({ state: "ready", data: body });
      } else if (status === 404 && errorCode(body) === "NO_MODEL") {
        setModel({ state: "empty" });
      } else {
        setModel({ state: "error", message: `Model request failed (HTTP ${status}).` });
      }
    } else {
      setModel({ state: "error", message: "Model request failed." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main>
      <header>
        <h1>Turnip Farm</h1>
        <p>
          {health.state === "ready"
            ? "Service is up."
            : health.state === "error"
              ? health.message
              : "Checking service health…"}
        </p>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      <section>
        <h2>Current model</h2>
        {model.state === "loading" && <p>Loading…</p>}
        {model.state === "empty" && <p>No model has been promoted yet.</p>}
        {model.state === "error" && <p>{model.message}</p>}
        {model.state === "ready" && (
          <dl>
            <div>
              <dt>Version</dt>
              <dd>{model.data.version}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{model.data.model_type}</dd>
            </div>
            <div>
              <dt>Vocabulary version</dt>
              <dd>{model.data.taxonomy_version}</dd>
            </div>
            <div>
              <dt>Minimum client version</dt>
              <dd>{model.data.min_client_version ?? "none"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{humanBytes(model.data.byte_size)}</dd>
            </div>
            <div>
              <dt>Promoted</dt>
              <dd>{new Date(model.data.promoted_at).toLocaleString()}</dd>
            </div>
          </dl>
        )}
        {model.state === "ready" && (
          <>
            <details>
              <summary>Validation metrics</summary>
              <pre>{JSON.stringify(model.data.val_metrics, null, 2)}</pre>
            </details>
            <details>
              <summary>Name metrics</summary>
              <pre>{JSON.stringify(model.data.name_metrics, null, 2)}</pre>
            </details>
          </>
        )}
      </section>

      <section>
        <h2>Vocabulary</h2>
        {taxonomy.state === "loading" && <p>Loading…</p>}
        {taxonomy.state === "error" && <p>{taxonomy.message}</p>}
        {taxonomy.state === "ready" && (
          <>
            <p>
              Version {taxonomy.data.taxonomy_version} · {taxonomy.data.vocabulary.length}{" "}
              {taxonomy.data.vocabulary.length === 1 ? "trick name" : "trick names"}
            </p>
            <ul>
              {taxonomy.data.vocabulary.map((entry) => (
                <li key={entry.canonical}>
                  <strong>{entry.canonical}</strong>
                  {entry.aliases.length > 0 && (
                    <span> — also named {entry.aliases.join(", ")}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
