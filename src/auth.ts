// Sign in with Apple authentication (BACKEND_DESIGN.md §7.1). Stateless: every
// client request carries `Authorization: Bearer <apple-identity-token>`, which
// is verified against Apple's JWKS on every request. No sessions, no cookies.

import type { SQL } from "bun";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { errorResponse } from "./errors";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

// "exp within a small clock-skew leeway" (§7.1).
export const CLOCK_TOLERANCE_SECONDS = 60;

// Thrown for a token that is the client's fault: malformed, forged, for
// another app, or expired. The request gets 401 and the client must fetch a
// fresh identity token.
export class InvalidTokenError extends Error {
  constructor(readonly reason: "expired" | "invalid") {
    super(reason === "expired" ? "Identity token expired" : "Invalid identity token");
    this.name = "InvalidTokenError";
  }
}

// Verifies an identity token and returns its `sub` claim. Only the `sub`
// leaves the verifier: Apple tokens also carry email and real-user claims,
// which the farm never keeps (§8).
export type VerifyToken = (token: string) => Promise<string>;

// jose errors that mean the token itself is bad. Anything else, such as the
// JWKS being unreachable or Apple answering 5xx, is a server-side failure and
// surfaces as 500: a 401 would send every client back to sign-in during an
// outage.
const TOKEN_FAULTS = [
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

export function createAppleTokenVerifier({
  audience,
  jwksUrl = APPLE_JWKS_URL,
}: {
  // The iOS app bundle ID (APP_BUNDLE_ID).
  audience: string;
  jwksUrl?: string | URL;
}): VerifyToken {
  // Fetched on first use and cached; refetched (rate-limited) when a token
  // names a `kid` the cache doesn't have, so Apple's key rotation is picked up.
  const keys = createRemoteJWKSet(new URL(jwksUrl));

  return async (token) => {
    let sub: unknown;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: APPLE_ISSUER,
        audience,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp"],
      });
      sub = payload.sub;
    } catch (err) {
      if (err instanceof errors.JWTExpired) throw new InvalidTokenError("expired");
      if (TOKEN_FAULTS.some((fault) => err instanceof fault)) throw new InvalidTokenError("invalid");
      throw err;
    }
    if (typeof sub !== "string" || sub === "") throw new InvalidTokenError("invalid");
    return sub;
  };
}

export type ClientAuth = { userId: string } | Response;

// Authenticates a client request: returns the caller's user ID, or the error
// response to send. Route handlers start with
//
//   const auth = await authenticateClient(req, deps);
//   if (auth instanceof Response) return auth;
//
// and scope every query with `user_id = auth.userId`.
export async function authenticateClient(
  req: Request,
  deps: { verifyToken: VerifyToken; sql: SQL },
): Promise<ClientAuth> {
  const token = bearerToken(req);
  if (token === null) return unauthenticated("Missing bearer token", "missing");

  let userId: string;
  try {
    userId = await deps.verifyToken(token);
  } catch (err) {
    if (err instanceof InvalidTokenError) return unauthenticated(err.message, err.reason);
    throw err;
  }

  // Upsert on first sight; the row is never modified on this path (§4).
  // Two statements, not one CTE: the SELECT must take its snapshot after the
  // INSERT, or a concurrent first sign-in for the same user would find no row.
  await deps.sql`INSERT INTO users (id) VALUES (${userId}) ON CONFLICT (id) DO NOTHING`;
  const [user] = await deps.sql`SELECT is_blocked FROM users WHERE id = ${userId}`;
  if (user.is_blocked) return errorResponse(403, "ACCOUNT_BLOCKED", "Account blocked");

  return { userId };
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return match?.[1] ?? null;
}

function unauthenticated(message: string, reason: "missing" | "expired" | "invalid"): Response {
  // details.reason lets the client handle an expired token (get a fresh one)
  // differently from a rejected one without parsing the message.
  return errorResponse(401, "UNAUTHENTICATED", message, {
    details: { reason },
    headers: { "WWW-Authenticate": "Bearer" },
  });
}
