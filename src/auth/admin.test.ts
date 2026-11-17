// The maintainer's sign-in through auth (admin.ts; BACKEND_DESIGN.md §7.1
// "Admin"). Most tests drive the routes with a stand-in for auth's client
// library; the last runs the real, vendored client against an in-process
// provider that signs with Ed25519, as auth does. DB tests run only when
// TEST_DATABASE_URL names a database, each in a rolled-back transaction.

import { SQL, type TransactionSQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { TEST_DATABASE_URL, inRollback } from "../../db/testing";
import { type AppDeps, createHandler } from "../app";
import type { R2Client } from "../r2/client";
import { TokenBucket } from "../ratelimit";
import { ADMIN_COOKIE, ADMIN_MAX_AGE_S, type AdminAuth, purgeExpiredAdminSessions } from "./admin";
import { FARM_ORIGIN, accessClaims, fakeAdminAuth, seedAdminSession } from "./admin-testing";
import { InvalidGrant, InvalidToken, type Login, LoginError, Unavailable, createAuthClient } from "./auth-client";
import { noDatabase, testCandidateKey } from "./testing";
import { sha256Hex } from "./tokens";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : (null as unknown as SQL);
afterAll(async () => {
  await sharedSql?.end();
});

const noR2 = {} as R2Client;

function handler(sql: SQL | TransactionSQL, adminAuth: AdminAuth | null) {
  const deps: AppDeps = {
    sql: sql as SQL,
    verifyIdentityToken: () => Promise.reject(new Error("unused")),
    exchangeCode: () => Promise.reject(new Error("unused")),
    verifyNotificationPayload: () => Promise.reject(new Error("unused")),
    revokeRefreshToken: () => Promise.reject(new Error("unused")),
    refreshTokenKey: {} as CryptoKey,
    r2: noR2,
    pipelineKey: "pipeline-key-for-tests",
    adminAuth,
    currentDisclosureVersion: 3,
    candidateKey: testCandidateKey,
    limits: {
      user: new TokenBucket(1000, 60000),
      ip: new TokenBucket(1000, 60000),
      publicIp: new TokenBucket(1000, 60000),
      adminIp: new TokenBucket(1000, 60000),
    },
  };
  return createHandler(deps);
}

function req(method: string, path: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request(`${FARM_ORIGIN}${path}`, { method, headers, body });
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("admin sign-in off", () => {
  test("every sign-in route and the session read answer 404 without AUTH_* config", async () => {
    const handle = handler(noDatabase, null);
    for (const [method, path] of [
      ["GET", "/auth/login"],
      ["GET", "/auth/callback?code=c&state=s"],
      ["POST", "/auth/logout"],
      ["POST", "/auth/events"],
      ["GET", "/api/admin/session"],
    ] as const) {
      const res = await handle(req(method, path, { origin: FARM_ORIGIN }));
      expect(res.status).toBe(404);
      expect(await code(res)).toBe("NOT_FOUND");
    }
  });

  test("an unknown /auth path is a JSON 404, never the web client", async () => {
    const res = await createHandler(
      { pipelineKey: "k" } as AppDeps,
      { clientDir: "/nonexistent" },
    )(req("GET", "/auth/nope"));
    expect(res.status).toBe(404);
    expect(await code(res)).toBe("NOT_FOUND");
  });
});

describe("GET /auth/login", () => {
  test("redirects to auth with the login cookie, asking for a sign-in within a day", async () => {
    const auth = fakeAdminAuth();
    const res = await handler(noDatabase, auth)(req("GET", "/auth/login"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://auth.test/oauth/authorize?state=s");
    expect(res.headers.get("Set-Cookie")).toStartWith("__Host-login=");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(auth.client.calls.find((c) => c.method === "startLogin")).toBeDefined();
    const login = JSON.parse(Buffer.from(res.headers.get("Set-Cookie")!.split(";")[0]!.split("=")[1]!, "base64url").toString());
    expect(login).toEqual({ returnTo: "/admin", maxAge: ADMIN_MAX_AGE_S });
  });

  test("auth unreachable: back to /admin with the reason", async () => {
    const auth = fakeAdminAuth({ startLogin: () => Promise.reject(new Unavailable("down")) });
    const res = await handler(noDatabase, auth)(req("GET", "/auth/login"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin?signin=unavailable");
  });
});

async function sessionRows(tx: TransactionSQL) {
  return (await tx`SELECT auth_sub, auth_sid, username, role, refresh_token,
                          recheck_at = to_timestamp(${accessClaims().exp}) AS recheck_at_exp,
                          expires_at = now() + interval '12 hours' AS expires_12h
                   FROM admin_sessions ORDER BY created_at`) as Record<string, unknown>[];
}

describeDb("GET /auth/callback", () => {
  test("opens a session: a Secure, HttpOnly, SameSite=Lax host cookie, and a row with the refresh token", async () =>
    inRollback(sharedSql, async (tx) => {
      const auth = fakeAdminAuth();
      const res = await handler(tx, auth)(req("GET", "/auth/callback?code=c&state=s"));
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin");
      const cookies = res.headers.getSetCookie();
      expect(cookies[0]).toBe("__Host-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
      const match = /^__Host-turnip-admin=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$/.exec(cookies[1]!);
      expect(match).not.toBeNull();
      expect(await sessionRows(tx)).toEqual([
        {
          auth_sub: accessClaims().sub,
          auth_sid: accessClaims().sid,
          username: "alice",
          role: "admin",
          refresh_token: "rt_initial",
          recheck_at_exp: true,
          expires_12h: true,
        },
      ]);
      const [row] = await tx`SELECT token_hash FROM admin_sessions`;
      expect(row!.token_hash).toBe(sha256Hex(match![1]!));

      const me = await handler(tx, auth)(req("GET", "/api/admin/session", { cookie: `${ADMIN_COOKIE}=${match![1]}` }));
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ username: "alice", role: "admin" });
    }));

  test("a role other than admin, or no second factor, opens nothing and revokes the refresh token", async () =>
    inRollback(sharedSql, async (tx) => {
      const base = fakeAdminAuth();
      const login = await base.client.finishLogin(req("GET", "/"));
      const variants: [Login, string][] = [
        [{ ...login, claims: { ...login.claims, role: "member" } }, "forbidden"],
        [{ ...login, idClaims: { ...login.idClaims, amr: ["pwd"] } }, "mfa_required"],
        [{ ...login, idClaims: { ...login.idClaims, amr: undefined } }, "mfa_required"],
      ];
      for (const [variant, reason] of variants) {
        const auth = fakeAdminAuth({ finishLogin: async () => variant });
        const res = await handler(tx, auth)(req("GET", "/auth/callback?code=c&state=s"));
        expect(res.headers.get("Location")).toBe(`/admin?signin=${reason}`);
        expect(res.headers.getSetCookie().some((c) => c.startsWith(`${ADMIN_COOKIE}=`))).toBe(false);
        expect(auth.client.revoked).toEqual(["rt_initial"]);
      }
      expect(await sessionRows(tx)).toEqual([]);
    }));

  test("a failed or unverifiable sign-in lands on /admin with the reason", async () =>
    inRollback(sharedSql, async (tx) => {
      for (const [error, reason] of [
        [new LoginError("state_mismatch"), "failed"],
        [new InvalidToken("nonce mismatch"), "failed"],
        [new InvalidGrant("used code"), "failed"],
        [new Unavailable("down"), "unavailable"],
      ] as const) {
        const auth = fakeAdminAuth({ finishLogin: () => Promise.reject(error) });
        const res = await handler(tx, auth)(req("GET", "/auth/callback?code=c&state=s"));
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe(`/admin?signin=${reason}`);
      }
      expect(await sessionRows(tx)).toEqual([]);
    }));
});

describeDb("admin session check", () => {
  const get = (tx: TransactionSQL, auth: AdminAuth, headers: Record<string, string>) =>
    handler(tx, auth)(req("GET", "/api/admin/session", headers));

  test("401 without a cookie, with an unknown or malformed one, or once expired", async () =>
    inRollback(sharedSql, async (tx) => {
      const auth = fakeAdminAuth();
      expect((await get(tx, auth, {})).status).toBe(401);
      expect((await get(tx, auth, { cookie: `${ADMIN_COOKIE}=${"A".repeat(43)}` })).status).toBe(401);
      expect((await get(tx, auth, { cookie: `${ADMIN_COOKIE}=short` })).status).toBe(401);
      const expired = await seedAdminSession(tx, { expiresIn: "-1 second" });
      expect((await get(tx, auth, expired.headers)).status).toBe(401);
      const live = await seedAdminSession(tx);
      expect((await get(tx, auth, live.headers)).status).toBe(200);
      expect(auth.client.calls.some((c) => c.method === "refresh")).toBe(false);
    }));

  test("when due, refreshes: keeps the session and stores a rotated refresh token", async () =>
    inRollback(sharedSql, async (tx) => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const auth = fakeAdminAuth({
        refresh: async () => ({ claims: accessClaims({ exp, username: "alice2" }), accessToken: "at", refreshToken: "rt_rotated" }),
      });
      const s = await seedAdminSession(tx, { recheckIn: "-1 second", verifiedAgo: "11 minutes" });
      const res = await get(tx, auth, s.headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ username: "alice2", role: "admin" });
      expect(auth.client.calls.filter((c) => c.method === "refresh")).toEqual([{ method: "refresh", arg: "rt_seeded" }]);
      const [row] = await tx`SELECT refresh_token, recheck_at = to_timestamp(${exp}) AS rechecked,
                                    verified_at = now() AS verified FROM admin_sessions`;
      expect(row).toEqual({ refresh_token: "rt_rotated", rechecked: true, verified: true });
    }));

  test("when due, ends the session on a lost role, a refused grant or a bad token", async () =>
    inRollback(sharedSql, async (tx) => {
      for (const refresh of [
        async () => ({ claims: accessClaims({ role: "member" }), accessToken: "at" }),
        () => Promise.reject(new InvalidGrant("ended")),
        () => Promise.reject(new InvalidToken("bad")),
      ]) {
        const s = await seedAdminSession(tx, { recheckIn: "-1 second" });
        const res = await get(tx, fakeAdminAuth({ refresh }), s.headers);
        expect(res.status).toBe(401);
        expect(await tx`SELECT 1 FROM admin_sessions WHERE token_hash = ${sha256Hex(s.token)}`).toHaveLength(0);
      }
      const noRefresh = await seedAdminSession(tx, { recheckIn: "-1 second", refreshToken: null });
      expect((await get(tx, fakeAdminAuth(), noRefresh.headers)).status).toBe(401);
    }));

  test("auth unreachable: let through within an hour of the last check, 503 after", async () =>
    inRollback(sharedSql, async (tx) => {
      const auth = fakeAdminAuth({ refresh: () => Promise.reject(new Unavailable("down")) });
      const recent = await seedAdminSession(tx, { recheckIn: "-1 second", verifiedAgo: "59 minutes" });
      expect((await get(tx, auth, recent.headers)).status).toBe(200);
      const stale = await seedAdminSession(tx, { recheckIn: "-1 second", verifiedAgo: "61 minutes" });
      const res = await get(tx, auth, stale.headers);
      expect(res.status).toBe(503);
      expect(await code(res)).toBe("AUTH_UNAVAILABLE");
      expect(await tx`SELECT 1 FROM admin_sessions`).toHaveLength(2);
    }));

  test("a write needs the farm's own Origin", async () =>
    inRollback(sharedSql, async (tx) => {
      const auth = fakeAdminAuth();
      const s = await seedAdminSession(tx);
      const put = (headers: Record<string, string>) =>
        handler(tx, auth)(req("PUT", `/api/admin/sources/${"a".repeat(64)}/holdout`, headers));
      for (const origin of [undefined, "https://evil.test", "null", "https://farm.test.evil.test"]) {
        const res = await put(origin === undefined ? s.headers : { ...s.headers, origin });
        expect(res.status).toBe(403);
        expect(await code(res)).toBe("FORBIDDEN");
      }
      expect((await put(s.writeHeaders)).status).toBe(404); // past the gate: no such source
    }));

  test("expired sessions are purged", async () =>
    inRollback(sharedSql, async (tx) => {
      await seedAdminSession(tx, { expiresIn: "-1 second" });
      const live = await seedAdminSession(tx);
      expect(await purgeExpiredAdminSessions(tx as unknown as SQL)).toBe(1);
      const rows = (await tx`SELECT token_hash FROM admin_sessions`) as { token_hash: string }[];
      expect(rows.map((r) => r.token_hash)).toEqual([sha256Hex(live.token)]);
    }));
});

describeDb("POST /auth/logout", () => {
  test("ends the session, revokes its refresh token, and signs out at auth", async () =>
    inRollback(sharedSql, async (tx) => {
      const auth = fakeAdminAuth();
      const s = await seedAdminSession(tx);
      const res = await handler(tx, auth)(req("POST", "/auth/logout", s.writeHeaders));
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe(
        `https://auth.test/logout?post_logout_redirect_uri=${encodeURIComponent(`${FARM_ORIGIN}/admin`)}`,
      );
      expect(res.headers.get("Set-Cookie")).toBe(`${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
      expect(auth.client.revoked).toEqual(["rt_seeded"]);
      expect(await tx`SELECT 1 FROM admin_sessions`).toHaveLength(0);
    }));

  test("refuses another origin, and keeps the session", async () =>
    inRollback(sharedSql, async (tx) => {
      const s = await seedAdminSession(tx);
      const res = await handler(tx, fakeAdminAuth())(req("POST", "/auth/logout", { ...s.headers, origin: "https://evil.test" }));
      expect(res.status).toBe(403);
      expect(await tx`SELECT 1 FROM admin_sessions`).toHaveLength(1);
    }));
});

describeDb("POST /auth/events", () => {
  const post = (tx: TransactionSQL, auth: AdminAuth, event: unknown) =>
    handler(tx, auth)(req("POST", "/auth/events", { "content-type": "application/secevent+jwt" }, JSON.stringify(event)));

  test("session.ended, user.disabled, user.deleted and a lost role end the sessions they name", async () =>
    inRollback(sharedSql, async (tx) => {
      const auth = fakeAdminAuth();
      const a = await seedAdminSession(tx, { sub: "usr_a", sid: "ses_a1" });
      const a2 = await seedAdminSession(tx, { sub: "usr_a", sid: "ses_a2" });
      const b = await seedAdminSession(tx, { sub: "usr_b", sid: "ses_b" });
      const c = await seedAdminSession(tx, { sub: "usr_c", sid: "ses_c" });
      const d = await seedAdminSession(tx, { sub: "usr_d", sid: "ses_d" });
      const left = async () =>
        ((await tx`SELECT auth_sid FROM admin_sessions ORDER BY auth_sid`) as { auth_sid: string }[]).map((r) => r.auth_sid);

      expect((await post(tx, auth, { type: "session.ended", jti: "1", sid: "ses_a1" })).status).toBe(204);
      expect(await left()).toEqual(["ses_a2", "ses_b", "ses_c", "ses_d"]);
      await post(tx, auth, { type: "access.changed", jti: "2", sub: "usr_b", role: "admin" });
      expect(await left()).toEqual(["ses_a2", "ses_b", "ses_c", "ses_d"]);
      await post(tx, auth, { type: "access.changed", jti: "3", sub: "usr_b", role: null });
      await post(tx, auth, { type: "access.changed", jti: "4", sub: "usr_a", role: "member" });
      expect(await left()).toEqual(["ses_c", "ses_d"]);
      await post(tx, auth, { type: "user.disabled", jti: "5", sub: "usr_c" });
      await post(tx, auth, { type: "user.deleted", jti: "6", sub: "usr_d" });
      expect(await left()).toEqual([]);
      // Redelivery is harmless, and unrelated events are acknowledged.
      expect((await post(tx, auth, { type: "user.deleted", jti: "6", sub: "usr_d" })).status).toBe(204);
      expect((await post(tx, auth, { type: "invite.accepted", jti: "7", sub: "usr_e", invite: "inv" })).status).toBe(204);
      void [a, a2, b, c, d];
    }));

  test("an invalid event is 422, an unverifiable one 503 so auth retries, an oversized one 422 unread", async () =>
    inRollback(sharedSql, async (tx) => {
      const invalid = fakeAdminAuth({ readEvent: () => Promise.reject(new InvalidToken("bad signature")) });
      expect((await post(tx, invalid, {})).status).toBe(422);
      const down = fakeAdminAuth({ readEvent: () => Promise.reject(new Unavailable("jwks")) });
      const res = await post(tx, down, {});
      expect(res.status).toBe(503);
      expect(await code(res)).toBe("AUTH_UNAVAILABLE");
      const auth = fakeAdminAuth();
      const big = await handler(tx, auth)(req("POST", "/auth/events", {}, "x".repeat(64 * 1024 + 1)));
      expect(big.status).toBe(422);
      expect(auth.client.calls.some((c) => c.method === "readEvent")).toBe(false);
    }));
});

// The real client library against a provider that answers as auth does
// (auth's docs/DESIGN.md §7.2, §7.3, §7.4): discovery, Ed25519 JWKS, the
// code and refresh grants, and a signed Security Event Token.
function fakeProvider() {
  const issuer = "https://auth.test";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const kid = "k1";
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const jwt = (typ: string, payload: Record<string, unknown>) => {
    const head = `${b64({ alg: "EdDSA", typ, kid })}.${b64(payload)}`;
    return `${head}.${sign(null, Buffer.from(head), privateKey).toString("base64url")}`;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (role: string) => ({
    iss: issuer, sub: "usr_alice", aud: "turnip-farm", iat: now(), exp: now() + 600,
    sid: "ses_alice", username: "alice", name: "Alice", role,
  });
  const nonces = new Map<string, string>();
  const state = { role: "admin", refreshes: 0, revoked: [] as string[] };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        end_session_endpoint: `${issuer}/logout`,
      });
    }
    if (url.pathname === "/.well-known/jwks.json") return json({ keys: [{ kty: "OKP", crv: "Ed25519", x, kid, use: "sig", alg: "EdDSA" }] });
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (url.pathname === "/oauth/token") {
      if (new Headers(init?.headers).get("authorization") !== `Basic ${Buffer.from("turnip-farm:secret").toString("base64")}`) {
        return json({ error: "invalid_client" }, 401);
      }
      if (form.get("grant_type") === "authorization_code") {
        const nonce = nonces.get(form.get("code") ?? "");
        if (!nonce) return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: jwt("at+jwt", claims(state.role)),
          id_token: jwt("JWT", { iss: issuer, sub: "usr_alice", aud: "turnip-farm", iat: now(), exp: now() + 600, nonce, auth_time: now(), amr: ["pwd", "otp", "mfa"] }),
          refresh_token: "rt_alice",
          token_type: "Bearer",
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        if (form.get("refresh_token") !== "rt_alice" || state.role === "gone") return json({ error: "invalid_grant" }, 400);
        return json({ access_token: jwt("at+jwt", claims(state.role)), token_type: "Bearer" });
      }
    }
    if (url.pathname === "/oauth/revoke") {
      state.revoked.push(form.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    return json({ error: "not_found" }, 404);
  }) as typeof globalThis.fetch;
  const authorize = (authorizeUrl: string, code: string) => {
    nonces.set(code, new URL(authorizeUrl).searchParams.get("nonce")!);
    return new URL(authorizeUrl).searchParams.get("state")!;
  };
  const event = (type: string, payload: Record<string, unknown>) =>
    jwt("secevent+jwt", { iss: issuer, aud: "turnip-farm", iat: now(), jti: `evt_${type}`, events: { [type]: payload } });
  return { issuer, fetch, authorize, event, state };
}

describeDb("with auth's client library", () => {
  test("signs in, re-checks, and ends the session on session.ended", async () =>
    inRollback(sharedSql, async (tx) => {
      const provider = fakeProvider();
      const auth: AdminAuth = {
        client: createAuthClient({
          issuer: provider.issuer,
          clientId: "turnip-farm",
          clientSecret: "secret",
          redirectUri: `${FARM_ORIGIN}/auth/callback`,
          fetch: provider.fetch,
        }),
        origin: FARM_ORIGIN,
      };
      const handle = handler(tx, auth);

      const start = await handle(req("GET", "/auth/login"));
      const authorizeUrl = start.headers.get("Location")!;
      expect(new URL(authorizeUrl).searchParams.get("max_age")).toBe(String(ADMIN_MAX_AGE_S));
      const loginCookie = start.headers.get("Set-Cookie")!.split(";")[0]!;
      const stateParam = provider.authorize(authorizeUrl, "code-1");

      const callback = await handle(
        req("GET", `/auth/callback?code=code-1&state=${encodeURIComponent(stateParam)}`, { cookie: loginCookie }),
      );
      expect(callback.headers.get("Location")).toBe("/admin");
      const cookie = callback.headers.getSetCookie().find((c) => c.startsWith(`${ADMIN_COOKIE}=`))!.split(";")[0]!;

      const me = () => handle(req("GET", "/api/admin/session", { cookie }));
      expect((await me()).status).toBe(200);

      await tx`UPDATE admin_sessions SET recheck_at = now() - interval '1 second'`;
      expect((await me()).status).toBe(200);
      expect(provider.state.refreshes).toBe(1);

      const ended = await handle(req("POST", "/auth/events", {}, provider.event("session.ended", { sid: "ses_alice" })));
      expect(ended.status).toBe(204);
      expect((await me()).status).toBe(401);

      // A forged event (another key) is refused and ends nothing.
      const forged = fakeProvider().event("user.disabled", { sub: "usr_alice" });
      expect((await handle(req("POST", "/auth/events", {}, forged))).status).toBe(422);
    }));

  test("a sign-in whose state doesn't match opens nothing", async () =>
    inRollback(sharedSql, async (tx) => {
      const provider = fakeProvider();
      const auth: AdminAuth = {
        client: createAuthClient({
          issuer: provider.issuer,
          clientId: "turnip-farm",
          clientSecret: "secret",
          redirectUri: `${FARM_ORIGIN}/auth/callback`,
          fetch: provider.fetch,
        }),
        origin: FARM_ORIGIN,
      };
      const handle = handler(tx, auth);
      const start = await handle(req("GET", "/auth/login"));
      provider.authorize(start.headers.get("Location")!, "code-1");
      const loginCookie = start.headers.get("Set-Cookie")!.split(";")[0]!;
      const res = await handle(req("GET", "/auth/callback?code=code-1&state=forged", { cookie: loginCookie }));
      expect(res.headers.get("Location")).toBe("/admin?signin=failed");
      expect(await tx`SELECT 1 FROM admin_sessions`).toHaveLength(0);
    }));
});
