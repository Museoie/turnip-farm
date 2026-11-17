// The maintainer's sign-in for the /admin page (BACKEND_DESIGN.md §7.1
// "Admin"), through the auth service as a confidential OIDC client, by
// that service's web-app contract: the /auth/login, /auth/callback,
// /auth/logout and /auth/events routes, a session row per sign-in with
// the refresh token, and a re-check of the role when the access token
// would have expired. auth's client library (auth-client.ts, vendored)
// does the protocol; this file holds the farm's side.
//
// An admin session is the `admin` role on the farm's service in auth,
// signed in with a second factor. Nothing here touches users, sources or
// attribution, and no token is logged (§8).

import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { errorResponse } from "../errors";
import { type AuthClient, InvalidGrant, InvalidToken, type AuthEvent, type Login, LoginError, Unavailable } from "./auth-client";
import { sha256Hex } from "./tokens";

/** The role on the farm's service that opens the admin endpoints. */
export const ADMIN_ROLE = "admin";

/** The cookie holding an admin session's token; `__Host-` keeps sibling hosts from setting it. */
export const ADMIN_COOKIE = "__Host-turnip-admin";

/** A session ends this long after sign-in, whatever its re-checks say. */
export const ADMIN_SESSION_TTL_S = 12 * 60 * 60;

/** auth's re-check window (its §7.1): sign in again if refreshing has failed this long. */
const MAX_STALE = "1 hour";

/** auth answers a sign-in older than a day with a fresh sign-in (its §7.1 `max_age`). */
export const ADMIN_MAX_AGE_S = 24 * 60 * 60;

/** The largest event body read; a Security Event Token is a few hundred bytes. */
const MAX_EVENT_BYTES = 64 * 1024;

export type AdminAuthClient = Pick<AuthClient, "startLogin" | "finishLogin" | "refresh" | "revoke" | "readEvent" | "logoutUrl">;

export interface AdminAuth {
  client: AdminAuthClient;
  /** The farm's public origin, from AUTH_REDIRECT_URI: writes must come from it. */
  origin: string;
}

export interface AdminAuthDeps {
  sql: SQL;
  /** Null or absent: admin sign-in isn't configured, and every admin route answers 404. */
  adminAuth?: AdminAuth | null;
}

export interface AdminSession {
  id: string;
  username: string;
  role: string;
}

/** Why the callback sent the browser back to /admin without a session; the page explains each. */
export type SignInFailure = "failed" | "unavailable" | "forbidden" | "mfa_required";

const notFound = () => errorResponse(404, "NOT_FOUND", "Not found");
const NO_STORE = { "Cache-Control": "no-store" };

function sessionCookie(token: string, maxAgeS: number): string {
  return `${ADMIN_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ Location: location, ...NO_STORE });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

/**
 * A write must come from the farm's own pages: the Origin header, which
 * page scripts can't set, names the farm's origin. SameSite=Lax already
 * keeps the cookie off cross-site writes; this is the second layer.
 */
export function isSameOrigin(req: Request, origin: string): boolean {
  return req.headers.get("origin") === origin;
}

async function deleteSession(sql: SQL, tokenHash: string): Promise<string | null> {
  const [row] = await sql`DELETE FROM admin_sessions WHERE token_hash = ${tokenHash} RETURNING refresh_token`;
  return row ? ((row.refresh_token as string | null) ?? null) : null;
}

/**
 * The admin session a request carries, or the response refusing it:
 * 404 when sign-in isn't configured, 401 without a live admin session,
 * 403 for a write from another origin, 503 when auth has been unreachable
 * for longer than the re-check window allows.
 */
export async function authenticateAdmin(req: Request, deps: AdminAuthDeps): Promise<AdminSession | Response> {
  const auth = deps.adminAuth;
  if (!auth) return notFound();
  if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req, auth.origin)) {
    return errorResponse(403, "FORBIDDEN", "Admin writes must come from the farm's own pages");
  }
  const unauthenticated = () =>
    errorResponse(401, "UNAUTHENTICATED", "Sign in at /auth/login", { headers: NO_STORE });
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return unauthenticated();
  const tokenHash = sha256Hex(token);

  const [row] = await deps.sql`
    SELECT id, username, role, refresh_token,
           recheck_at <= now() AS due,
           verified_at > now() - ${MAX_STALE}::interval AS fresh
    FROM admin_sessions
    WHERE token_hash = ${tokenHash} AND expires_at > now()`;
  if (!row) return unauthenticated();
  const session: AdminSession = { id: row.id as string, username: row.username as string, role: row.role as string };
  if (!row.due) return session.role === ADMIN_ROLE ? session : unauthenticated();

  // The access token this session was issued with has expired: refresh it
  // over the back channel, which carries the role auth holds now.
  const refreshToken = row.refresh_token as string | null;
  if (refreshToken === null) {
    await deleteSession(deps.sql, tokenHash);
    return unauthenticated();
  }
  try {
    const refreshed = await auth.client.refresh(refreshToken);
    if (refreshed.claims.role !== ADMIN_ROLE) {
      await deleteSession(deps.sql, tokenHash);
      return unauthenticated();
    }
    await deps.sql`
      UPDATE admin_sessions
      SET role = ${refreshed.claims.role},
          username = ${refreshed.claims.username},
          refresh_token = ${refreshed.refreshToken ?? refreshToken},
          recheck_at = to_timestamp(${refreshed.claims.exp}),
          verified_at = now()
      WHERE id = ${session.id}`;
    return { ...session, role: refreshed.claims.role, username: refreshed.claims.username };
  } catch (err) {
    if (err instanceof InvalidGrant || err instanceof InvalidToken) {
      await deleteSession(deps.sql, tokenHash);
      return unauthenticated();
    }
    if (err instanceof Unavailable) {
      // auth's rule: let the request through while the last good check is
      // recent, and try again on the next one.
      if (row.fresh && session.role === ADMIN_ROLE) return session;
      return errorResponse(503, "AUTH_UNAVAILABLE", "The sign-in service is unreachable; retry later");
    }
    throw err;
  }
}

// GET /auth/login — start a sign-in at auth, landing back on /admin.
export async function handleAdminLogin(req: Request, deps: AdminAuthDeps): Promise<Response> {
  const auth = deps.adminAuth;
  if (!auth) return notFound();
  try {
    const { redirectUrl, loginCookie } = await auth.client.startLogin(req, {
      returnTo: "/admin",
      maxAge: ADMIN_MAX_AGE_S,
    });
    return redirect(redirectUrl, [loginCookie]);
  } catch (err) {
    if (err instanceof Unavailable) return redirect("/admin?signin=unavailable");
    throw err;
  }
}

// GET /auth/callback — finish the sign-in and open an admin session. Every
// failure lands back on /admin with a fixed reason the page explains.
export async function handleAdminCallback(req: Request, deps: AdminAuthDeps): Promise<Response> {
  const auth = deps.adminAuth;
  if (!auth) return notFound();
  // The login cookie expires by itself within minutes; a new sign-in replaces it.
  const fail = (reason: SignInFailure) => redirect(`/admin?signin=${reason}`);

  let login: Login;
  try {
    login = await auth.client.finishLogin(req);
  } catch (err) {
    if (err instanceof LoginError || err instanceof InvalidToken || err instanceof InvalidGrant) return fail("failed");
    if (err instanceof Unavailable) return fail("unavailable");
    throw err;
  }
  const revoke = () => (login.refreshToken ? auth.client.revoke(login.refreshToken).catch(() => {}) : undefined);
  if (login.claims.role !== ADMIN_ROLE) {
    await revoke();
    return fail("forbidden");
  }
  if (!login.idClaims.amr?.includes("mfa")) {
    await revoke();
    return fail("mfa_required");
  }

  const token = randomBytes(32).toString("base64url");
  await deps.sql`
    INSERT INTO admin_sessions
      (token_hash, auth_sub, auth_sid, username, role, refresh_token, recheck_at, expires_at)
    VALUES (${sha256Hex(token)}, ${login.claims.sub}, ${login.claims.sid}, ${login.claims.username},
            ${login.claims.role}, ${login.refreshToken ?? null}, to_timestamp(${login.claims.exp}),
            now() + ${`${ADMIN_SESSION_TTL_S} seconds`}::interval)`;
  return redirect(login.returnTo, [login.clearCookie, sessionCookie(token, ADMIN_SESSION_TTL_S)]);
}

// POST /auth/logout — end this session, revoke its refresh token, and end
// the sign-in at auth too, returning to /admin.
export async function handleAdminLogout(req: Request, deps: AdminAuthDeps): Promise<Response> {
  const auth = deps.adminAuth;
  if (!auth) return notFound();
  if (!isSameOrigin(req, auth.origin)) {
    return errorResponse(403, "FORBIDDEN", "Sign out from the farm's own pages");
  }
  const cookies = [sessionCookie("", 0)];
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return redirect("/admin", cookies, 303);
  const refreshToken = await deleteSession(deps.sql, sha256Hex(token));
  if (refreshToken) await auth.client.revoke(refreshToken).catch(() => {});
  try {
    return redirect(await auth.client.logoutUrl(`${auth.origin}/admin`), cookies, 303);
  } catch {
    return redirect("/admin", cookies, 303);
  }
}

async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// POST /auth/events — auth's push events (its §7.4). Each is verified by
// the client library; the farm ends the sessions an event names, so a
// sign-out, a disabled account or a lost role takes effect at once
// rather than at the next re-check. Delivery is at least once, and every
// handler here is idempotent.
export async function handleAuthEvents(req: Request, deps: AdminAuthDeps): Promise<Response> {
  const auth = deps.adminAuth;
  if (!auth) return notFound();
  const body = await readCapped(req, MAX_EVENT_BYTES);
  if (body === null) return errorResponse(422, "VALIDATION_ERROR", "Event too large");
  let event: AuthEvent;
  try {
    event = await auth.client.readEvent(body);
  } catch (err) {
    if (err instanceof InvalidToken) return errorResponse(422, "VALIDATION_ERROR", "Invalid event");
    if (err instanceof Unavailable) return errorResponse(503, "AUTH_UNAVAILABLE", "Can't verify the event yet");
    throw err;
  }
  switch (event.type) {
    case "session.ended":
      await deps.sql`DELETE FROM admin_sessions WHERE auth_sid = ${event.sid!}`;
      break;
    case "user.disabled":
    case "user.deleted":
      await deps.sql`DELETE FROM admin_sessions WHERE auth_sub = ${event.sub!}`;
      break;
    case "access.changed":
      if (event.role === ADMIN_ROLE) {
        await deps.sql`UPDATE admin_sessions SET role = ${event.role} WHERE auth_sub = ${event.sub!}`;
      } else {
        await deps.sql`DELETE FROM admin_sessions WHERE auth_sub = ${event.sub!}`;
      }
      break;
    default:
      // Not about sessions (invite.accepted, credential.revoked) or not known: acknowledge.
      break;
  }
  return new Response(null, { status: 204 });
}

// GET /api/admin/session — who is signed in, for the page.
export async function handleAdminSession(req: Request, deps: AdminAuthDeps): Promise<Response> {
  const session = await authenticateAdmin(req, deps);
  if (session instanceof Response) return session;
  return Response.json({ username: session.username, role: session.role }, { headers: NO_STORE });
}

/** Deletes expired admin sessions; run with the hourly retention jobs. */
export async function purgeExpiredAdminSessions(sql: SQL): Promise<number> {
  const rows = await sql`DELETE FROM admin_sessions WHERE expires_at <= now() RETURNING id`;
  return rows.length;
}
