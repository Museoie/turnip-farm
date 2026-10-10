import { startServer } from "./app";
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

const config = loadConfigOrExit();
const server = startServer(config.port);
console.log(`turnip-farm listening on ${server.url}`);
