// Test helpers for the admin sign-in (admin.ts): a stand-in for auth's
// client library, and a way to seed a signed-in session.

import type { TransactionSQL } from "bun";
import { randomBytes } from "node:crypto";
import type { AdminAuth, AdminAuthClient } from "./admin";
import { ADMIN_COOKIE } from "./admin";
import type { AccessClaims, AuthEvent, Login, Refreshed } from "./auth-client";
import { sha256Hex } from "./tokens";

export const FARM_ORIGIN = "https://farm.test";

export function accessClaims(overrides: Partial<AccessClaims> = {}): AccessClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://auth.test",
    sub: "usr_01jdz5w3k8x2q9v4m7n6p0r1st",
    aud: "turnip-farm",
    iat: now,
    exp: now + 600,
    sid: "ses_01jdz61c0q7h3m2k9x8v5t4w2a",
    username: "alice",
    name: "Alice",
    role: "admin",
    ...overrides,
  };
}

export interface FakeAuthClient extends AdminAuthClient {
  calls: { method: string; arg?: unknown }[];
  revoked: string[];
}

// Each behavior defaults to a successful admin sign-in; tests replace the
// ones they exercise.
export function fakeAuthClient(behavior: Partial<AdminAuthClient> = {}): FakeAuthClient {
  const calls: { method: string; arg?: unknown }[] = [];
  const revoked: string[] = [];
  const base: AdminAuthClient = {
    startLogin: async (_req, options) => ({
      redirectUrl: `https://auth.test/oauth/authorize?state=s`,
      loginCookie: `__Host-login=${Buffer.from(JSON.stringify(options ?? {})).toString("base64url")}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`,
    }),
    finishLogin: async (): Promise<Login> => ({
      claims: accessClaims(),
      idClaims: {
        iss: "https://auth.test",
        sub: accessClaims().sub,
        aud: "turnip-farm",
        iat: 0,
        exp: 0,
        nonce: "n",
        amr: ["pwd", "otp", "mfa"],
      },
      accessToken: "at",
      refreshToken: "rt_initial",
      returnTo: "/admin",
      clearCookie: "__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    }),
    refresh: async (): Promise<Refreshed> => ({ claims: accessClaims(), accessToken: "at2" }),
    revoke: async (token) => {
      revoked.push(token);
    },
    readEvent: async (body): Promise<AuthEvent> => JSON.parse(body) as AuthEvent,
    logoutUrl: async (redirect) => `https://auth.test/logout?post_logout_redirect_uri=${encodeURIComponent(redirect ?? "")}`,
  };
  const client = { ...base, ...behavior } as AdminAuthClient;
  const wrapped = Object.fromEntries(
    Object.entries(client).map(([method, fn]) => [
      method,
      (...args: unknown[]) => {
        calls.push({ method, arg: args[0] });
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as AdminAuthClient;
  return Object.assign(wrapped, { calls, revoked });
}

export function fakeAdminAuth(behavior: Partial<AdminAuthClient> = {}): AdminAuth & { client: FakeAuthClient } {
  return { client: fakeAuthClient(behavior), origin: FARM_ORIGIN };
}

export interface SeededSession {
  token: string;
  /** Headers for a GET; add `origin` for a write. */
  headers: Record<string, string>;
  /** Headers for a write from the farm's own pages. */
  writeHeaders: Record<string, string>;
}

/** Inserts a live admin session and returns its cookie. */
export async function seedAdminSession(
  tx: TransactionSQL,
  opts: {
    role?: string;
    sub?: string;
    sid?: string;
    refreshToken?: string | null;
    recheckIn?: string;
    verifiedAgo?: string;
    expiresIn?: string;
  } = {},
): Promise<SeededSession> {
  const token = randomBytes(32).toString("base64url");
  await tx`
    INSERT INTO admin_sessions
      (token_hash, auth_sub, auth_sid, username, role, refresh_token, recheck_at, verified_at, expires_at)
    VALUES (${sha256Hex(token)}, ${opts.sub ?? accessClaims().sub}, ${opts.sid ?? accessClaims().sid}, 'alice',
            ${opts.role ?? "admin"}, ${opts.refreshToken === undefined ? "rt_seeded" : opts.refreshToken},
            now() + ${opts.recheckIn ?? "10 minutes"}::interval,
            now() - ${opts.verifiedAgo ?? "0 seconds"}::interval,
            now() + ${opts.expiresIn ?? "12 hours"}::interval)`;
  const cookie = `${ADMIN_COOKIE}=${token}`;
  return { token, headers: { cookie }, writeHeaders: { cookie, origin: FARM_ORIGIN } };
}
