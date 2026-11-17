// Env-based configuration. Every variable is checked at startup and all
// problems are reported together, so a misconfigured deploy fails fast with
// one actionable message instead of crashing on first use.

import { type ProxyRange, parseProxyRange } from "./ratelimit";

export interface Config {
  port: number;
  databaseUrl: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  // Sign in with Apple `aud` claim and client_id (BACKEND_DESIGN.md §7.1).
  appBundleId: string;
  // The farm's Sign in with Apple credentials (BACKEND_DESIGN.md §7.1).
  apple: {
    teamId: string;
    keyId: string;
    // PKCS#8 PEM of the .p8 key; imported (and fully validated) at startup.
    privateKeyPem: string;
    // AES-256-GCM key for users.apple_refresh_token: exactly 32 bytes.
    refreshTokenKey: Uint8Array<ArrayBuffer>;
  };
  // Service key for the pipeline endpoints (BACKEND_DESIGN.md §7.1).
  pipelineKey: string;
  // The maintainer's sign-in through the auth service, for the /admin page
  // and its endpoints (BACKEND_DESIGN.md §7.1 "Admin"). Null when the AUTH_*
  // variables are unset: the admin endpoints are off.
  adminAuth: AdminAuthConfig | null;
  // Proxies, besides loopback, whose X-Forwarded-For per-IP rate limits
  // read through (BACKEND_DESIGN.md §7.2). Empty when unset.
  trustedProxies: ProxyRange[];
  // The contribution disclosure version the app must have recorded with
  // POST /api/consent before contributing (BACKEND_DESIGN.md §7.3).
  // Default DEFAULT_DISCLOSURE_VERSION.
  currentDisclosureVersion: number;
}

export const REQUIRED_ENV = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "APP_BUNDLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_REFRESH_TOKEN_KEY",
  "TURNIP_PIPELINE_KEY",
] as const;

export const DEFAULT_PORT = 3000;

export interface AdminAuthConfig {
  issuer: string;
  backChannelUrl?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  audience?: string;
}

// Set together or not at all; AUTH_BACKCHANNEL_URL and AUTH_AUDIENCE are optional.
export const ADMIN_AUTH_ENV = ["AUTH_ISSUER", "AUTH_CLIENT_ID", "AUTH_CLIENT_SECRET", "AUTH_REDIRECT_URI"] as const;

// The farm's own callback route; AUTH_REDIRECT_URI must point at it.
export const ADMIN_CALLBACK_PATH = "/auth/callback";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Default CURRENT_DISCLOSURE_VERSION: the app's disclosure that says
// attribution is kept until deletion (BACKEND_DESIGN.md §1.2.17).
export const DEFAULT_DISCLOSURE_VERSION = 3;

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

  // .env files often carry the PEM on one line with literal \n escapes.
  const privateKeyPem = required.APPLE_PRIVATE_KEY?.replaceAll("\\n", "\n").trim();
  if (privateKeyPem !== undefined && !privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    problems.push("APPLE_PRIVATE_KEY must be the PKCS#8 PEM contents of the .p8 key");
  }

  const refreshTokenKey = parseKey(required.APPLE_REFRESH_TOKEN_KEY);
  if (required.APPLE_REFRESH_TOKEN_KEY !== undefined && refreshTokenKey === null) {
    problems.push("APPLE_REFRESH_TOKEN_KEY must be 32 random bytes, base64-encoded");
  }

  const trustedProxies: ProxyRange[] = [];
  for (const entry of (env.TRUSTED_PROXIES ?? "").split(",")) {
    if (entry.trim() === "") continue;
    const range = parseProxyRange(entry);
    if (range === null) {
      problems.push(`TRUSTED_PROXIES entry "${entry.trim()}" is not an IP address or CIDR range`);
    } else {
      trustedProxies.push(range);
    }
  }

  const adminAuth = parseAdminAuth(env, problems);

  const currentDisclosureVersion = parseDisclosureVersion(env.CURRENT_DISCLOSURE_VERSION);
  if (currentDisclosureVersion === null) {
    problems.push(
      `CURRENT_DISCLOSURE_VERSION must be a positive integer (got "${env.CURRENT_DISCLOSURE_VERSION}")`,
    );
  }

  if (
    problems.length > 0 ||
    port === null ||
    currentDisclosureVersion === null ||
    privateKeyPem === undefined ||
    refreshTokenKey === null
  ) {
    throw new ConfigError(problems);
  }

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
    apple: {
      teamId: required.APPLE_TEAM_ID,
      keyId: required.APPLE_KEY_ID,
      privateKeyPem,
      refreshTokenKey,
    },
    pipelineKey: required.TURNIP_PIPELINE_KEY,
    adminAuth,
    trustedProxies,
    currentDisclosureVersion,
  };
}

// An https URL, or http on a loopback host (local development), with no
// query or fragment.
function isWebUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ok = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return ok && url.search === "" && url.hash === "" ? url : null;
}

function parseAdminAuth(env: Env, problems: string[]): AdminAuthConfig | null {
  const value = (name: string) => {
    const v = env[name]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const set = ADMIN_AUTH_ENV.filter((name) => value(name) !== undefined);
  const optional = ["AUTH_BACKCHANNEL_URL", "AUTH_AUDIENCE"].filter((name) => value(name) !== undefined);
  if (set.length === 0 && optional.length === 0) return null;
  if (set.length < ADMIN_AUTH_ENV.length) {
    const missing = ADMIN_AUTH_ENV.filter((name) => value(name) === undefined);
    problems.push(`${missing.join(", ")} must be set with the other AUTH_* variables, or none of them`);
    return null;
  }
  const issuer = value("AUTH_ISSUER")!;
  const redirectUri = value("AUTH_REDIRECT_URI")!;
  const backChannelUrl = value("AUTH_BACKCHANNEL_URL");
  const before = problems.length;
  if (!isWebUrl(issuer)) problems.push("AUTH_ISSUER must be an https URL (http only for localhost)");
  const redirect = isWebUrl(redirectUri);
  if (!redirect || redirect.pathname !== ADMIN_CALLBACK_PATH) {
    problems.push(`AUTH_REDIRECT_URI must be this farm's https URL ending in ${ADMIN_CALLBACK_PATH}`);
  }
  if (backChannelUrl !== undefined) {
    try {
      const back = new URL(backChannelUrl);
      if ((back.protocol !== "https:" && back.protocol !== "http:") || back.search || back.hash) throw new Error();
    } catch {
      problems.push("AUTH_BACKCHANNEL_URL must be an http or https URL with no query");
    }
  }
  if (problems.length > before) return null;
  const config: AdminAuthConfig = {
    issuer,
    clientId: value("AUTH_CLIENT_ID")!,
    clientSecret: value("AUTH_CLIENT_SECRET")!,
    redirectUri,
  };
  if (backChannelUrl !== undefined) config.backChannelUrl = backChannelUrl;
  const audience = value("AUTH_AUDIENCE");
  if (audience !== undefined) config.audience = audience;
  return config;
}

function parseDisclosureVersion(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DISCLOSURE_VERSION;
  if (!/^\d+$/.test(raw.trim())) return null;
  const version = Number(raw);
  return version >= 1 && version <= 2_147_483_647 ? version : null;
}

function parseKey(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (raw === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.trim())) return null;
  const bytes = Buffer.from(raw.trim(), "base64");
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw.trim())) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}
