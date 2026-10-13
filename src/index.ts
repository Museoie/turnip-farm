import { SQL } from "bun";
import { startServer } from "./app";
import { createAppleTokenVerifier, createCodeExchanger, importApplePrivateKey } from "./auth/apple";
import { importRefreshTokenKey } from "./auth/tokens";
import { type Config, ConfigError, loadConfig } from "./config";
import { R2BlobStore } from "./ingest/store";
import { createPostgresSourceStore, startIngestPoller } from "./ingest/worker";

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

// The .p8 key passes the PEM shape check in config but can still be
// malformed; importing it here fails fast in the same error format.
async function importApplePrivateKeyOrExit(pem: string): Promise<CryptoKey> {
  try {
    return await importApplePrivateKey(pem);
  } catch {
    console.error(new ConfigError(["APPLE_PRIVATE_KEY is not a valid ES256 PKCS#8 key"]).message);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const privateKey = await importApplePrivateKeyOrExit(config.apple.privateKeyPem);
const sql = new SQL(config.databaseUrl);

const server = startServer(config.port, {
  sql,
  verifyIdentityToken: createAppleTokenVerifier({ audience: config.appBundleId }),
  exchangeCode: createCodeExchanger({
    credentials: {
      teamId: config.apple.teamId,
      keyId: config.apple.keyId,
      clientId: config.appBundleId,
      privateKey,
    },
  }),
  refreshTokenKey: await importRefreshTokenKey(config.apple.refreshTokenKey),
});
console.log(`turnip-farm listening on ${server.url}`);

// The ingest worker's "or poll" trigger (BACKEND_DESIGN.md §1.2.10):
// sweep the staging prefix on an interval. Optional env override;
// 0 disables (e.g. when R2 event notifications drive ingest instead).
const ingestIntervalMs = parseIngestIntervalMs(process.env.INGEST_POLL_INTERVAL_MS);
if (ingestIntervalMs > 0) {
  startIngestPoller(
    { store: new R2BlobStore(config.r2), sources: createPostgresSourceStore(sql) },
    ingestIntervalMs,
  );
  console.log(`ingest poller running every ${ingestIntervalMs}ms`);
}

function parseIngestIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30_000;
  const ms = Number(raw);
  return Number.isInteger(ms) && ms >= 0 ? ms : 30_000;
}
