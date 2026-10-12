import { SQL } from "bun";
import { startServer } from "./app";
import { createAppleTokenVerifier, createCodeExchanger, importApplePrivateKey } from "./auth/apple";
import { importRefreshTokenKey } from "./auth/tokens";
import { type Config, ConfigError, loadConfig } from "./config";

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

const server = startServer(config.port, {
  sql: new SQL(config.databaseUrl),
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
