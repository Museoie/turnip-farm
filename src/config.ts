// Env-based configuration. Every variable is checked at startup and all
// problems are reported together, so a misconfigured deploy fails fast with
// one actionable message instead of crashing on first use.

export interface Config {
  port: number;
  databaseUrl: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  // Sign in with Apple `aud` claim (BACKEND_DESIGN.md §7.1).
  appBundleId: string;
  // Service key for the pipeline endpoints (BACKEND_DESIGN.md §7.1).
  pipelineKey: string;
}

export const REQUIRED_ENV = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "APP_BUNDLE_ID",
  "TURNIP_PIPELINE_KEY",
] as const;

export const DEFAULT_PORT = 3000;

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const required = {} as Record<(typeof REQUIRED_ENV)[number], string>;
  for (const name of REQUIRED_ENV) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      problems.push(`${name} is required`);
    } else {
      required[name] = value;
    }
  }

  const port = parsePort(env.PORT);
  if (port === null) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
  }

  if (problems.length > 0 || port === null) throw new ConfigError(problems);

  return {
    port,
    databaseUrl: required.DATABASE_URL,
    r2: {
      accountId: required.R2_ACCOUNT_ID,
      accessKeyId: required.R2_ACCESS_KEY_ID,
      secretAccessKey: required.R2_SECRET_ACCESS_KEY,
      bucket: required.R2_BUCKET,
    },
    appBundleId: required.APP_BUNDLE_ID,
    pipelineKey: required.TURNIP_PIPELINE_KEY,
  };
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw.trim())) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}
