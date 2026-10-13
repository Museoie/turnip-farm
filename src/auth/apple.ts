// Talking to Sign in with Apple (BACKEND_DESIGN.md §7.1): verifying Apple's
// JWTs, and exchanging an authorization code for Apple's tokens.

import { SignJWT, createRemoteJWKSet, errors, importPKCS8, jwtVerify } from "jose";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";

// "exp within a 60-second clock-skew leeway" (§7.1).
export const CLOCK_TOLERANCE_SECONDS = 60;

// The request's fault: a malformed, forged, expired, or replayed token, or an
// authorization code Apple rejects. The client gets 401 and signs in again.
export class InvalidTokenError extends Error {
  constructor(message = "Invalid identity token") {
    super(message);
    this.name = "InvalidTokenError";
  }
}

// Apple's token endpoint is unreachable, timed out, or answered 5xx. The
// client gets 503 APPLE_UNAVAILABLE and retries; its sign-in was fine.
export class AppleUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppleUnavailableError";
  }
}

// What the farm reads from a verified Apple token, and nothing else: Apple
// tokens also carry email and real-user claims, which the farm never keeps
// (§8).
export interface AppleIdentity {
  sub: string;
  nonce: string | undefined;
}

export type VerifyIdentityToken = (token: string) => Promise<AppleIdentity>;

// jose errors that mean the token itself is bad. Anything else, such as the
// JWKS being unreachable, is a server-side failure and surfaces as 500: a 401
// would send every client back to sign-in during an outage.
const TOKEN_FAULTS = [
  errors.JWTExpired,
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
}): VerifyIdentityToken {
  // Fetched on first use and cached; refetched (rate-limited) when a token
  // names a `kid` the cache doesn't have, so Apple's key rotation is picked up.
  const keys = createRemoteJWKSet(new URL(jwksUrl));

  return async (token) => {
    let claims: { sub?: unknown; nonce?: unknown };
    try {
      ({ payload: claims } = await jwtVerify(token, keys, {
        issuer: APPLE_ISSUER,
        audience,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ["sub", "exp"],
      }));
    } catch (err) {
      if (TOKEN_FAULTS.some((fault) => err instanceof fault)) throw new InvalidTokenError();
      throw err;
    }
    if (typeof claims.sub !== "string" || claims.sub === "") throw new InvalidTokenError();
    return { sub: claims.sub, nonce: typeof claims.nonce === "string" ? claims.nonce : undefined };
  };
}

// The farm's credentials with Apple: the Sign in with Apple key, and the
// bundle ID as client_id.
export interface AppleCredentials {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKey: CryptoKey;
}

export function importApplePrivateKey(pem: string): Promise<CryptoKey> {
  return importPKCS8(pem, "ES256");
}

// The client secret Apple's token endpoints require (§7.1): an ES256 JWT
// minted per call, so it needs no caching and expires in minutes.
export function mintClientSecret({ teamId, keyId, clientId, privateKey }: AppleCredentials): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

export interface AppleTokens {
  idToken: string;
  refreshToken: string;
}

export type ExchangeCode = (authorizationCode: string) => Promise<AppleTokens>;

export function createCodeExchanger({
  credentials,
  tokenUrl = APPLE_TOKEN_URL,
  timeoutMs = 10_000,
}: {
  credentials: AppleCredentials;
  tokenUrl?: string | URL;
  timeoutMs?: number;
}): ExchangeCode {
  return async (authorizationCode) => {
    const form = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: await mintClientSecret(credentials),
      code: authorizationCode,
      grant_type: "authorization_code",
    });

    let res: Response;
    try {
      res = await fetch(tokenUrl, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new AppleUnavailableError("Apple's token endpoint is unreachable", { cause: err });
    }
    if (res.status >= 500) throw new AppleUnavailableError(`Apple's token endpoint answered ${res.status}`);

    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      // invalid_grant: the code expired, was already used, or was revoked.
      if (body?.error === "invalid_grant") throw new InvalidTokenError("Authorization code rejected");
      // Anything else (e.g. invalid_client) means the farm is misconfigured.
      throw new Error(`Apple's token endpoint answered ${res.status} ${String(body?.error ?? "")}`.trim());
    }
    // The refresh token's only job is revocation on account deletion
    // (§1.2.15); a sign-in without one could never be revoked.
    if (typeof body?.id_token !== "string" || typeof body.refresh_token !== "string") {
      throw new Error("Apple's token response lacks id_token or refresh_token");
    }
    return { idToken: body.id_token, refreshToken: body.refresh_token };
  };
}
