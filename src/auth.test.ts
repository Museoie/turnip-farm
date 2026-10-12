import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import {
  APPLE_ISSUER,
  InvalidTokenError,
  type VerifyToken,
  authenticateClient,
  createAppleTokenVerifier,
} from "./auth";

const AUDIENCE = "kim.hoie.turnip";
const SUB = "001234.0123456789abcdef0123456789abcdef.0123";

// A stand-in for Apple's JWKS endpoint, serving one RS256 key as kid "k1".
const apple = await generateKeyPair("RS256", { extractable: true });
const appleJwk = { ...(await exportJWK(apple.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const jwksServer = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [appleJwk] }) });
afterAll(() => jwksServer.stop(true));

const verifyToken = createAppleTokenVerifier({
  audience: AUDIENCE,
  jwksUrl: new URL("/auth/keys", jwksServer.url),
});

const now = () => Math.floor(Date.now() / 1000);

// An identity token shaped like Apple's, including the email claims the
// farm must never keep. HS256 when signed with a shared secret.
function identityToken({
  kid = "k1",
  key = apple.privateKey,
  claims = {},
}: { kid?: string; key?: CryptoKey | Uint8Array; claims?: Record<string, unknown> } = {}) {
  return new SignJWT({
    iss: APPLE_ISSUER,
    aud: AUDIENCE,
    sub: SUB,
    iat: now(),
    exp: now() + 600,
    email: "abc@privaterelay.appleid.com",
    is_private_email: true,
    ...claims,
  })
    .setProtectedHeader({ alg: key instanceof Uint8Array ? "HS256" : "RS256", kid })
    .sign(key);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err) => err,
  );
}

describe("createAppleTokenVerifier", () => {
  test("returns only the sub of a valid token", async () => {
    expect(await verifyToken(await identityToken())).toBe(SUB);
  });

  test("accepts a token expired within the clock-skew leeway", async () => {
    expect(await verifyToken(await identityToken({ claims: { exp: now() - 20 } }))).toBe(SUB);
  });

  test.each([
    ["expired beyond the leeway", () => identityToken({ claims: { exp: now() - 120 } }), "expired"],
    ["unknown kid", () => identityToken({ kid: "k2" }), "invalid"],
    ["wrong issuer", () => identityToken({ claims: { iss: "https://example.com" } }), "invalid"],
    ["wrong audience", () => identityToken({ claims: { aud: "com.example.other" } }), "invalid"],
    ["missing sub", () => identityToken({ claims: { sub: undefined } }), "invalid"],
    ["missing exp", () => identityToken({ claims: { exp: undefined } }), "invalid"],
    [
      "known kid, signed by another key",
      async () => identityToken({ key: (await generateKeyPair("RS256")).privateKey }),
      "invalid",
    ],
    [
      "HS256 (algorithm confusion)",
      () => identityToken({ key: new TextEncoder().encode("a-shared-secret-of-32-bytes-long") }),
      "invalid",
    ],
    ["not a JWT", async () => "not.a.jwt", "invalid"],
  ])("rejects a token: %s", async (_, makeToken, reason) => {
    const err = await rejection(verifyToken(await makeToken()));
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err).toMatchObject({ reason });
  });

  // A JWKS outage must not read as a bad token (that would be a 401).
  async function verifyAgainst(jwks: (req: Request) => Response, { stopFirst = false } = {}) {
    const server = Bun.serve({ port: 0, fetch: jwks });
    if (stopFirst) server.stop(true);
    try {
      const verify = createAppleTokenVerifier({ audience: AUDIENCE, jwksUrl: server.url });
      return await rejection(verify(await identityToken()));
    } finally {
      server.stop(true);
    }
  }

  test("does not blame the token when the JWKS is unreachable", async () => {
    const err = await verifyAgainst(() => new Response(), { stopFirst: true });
    expect(err).not.toBeInstanceOf(InvalidTokenError);
  });

  test("does not blame the token when the JWKS answers 500", async () => {
    const err = await verifyAgainst(() => new Response("unavailable", { status: 500 }));
    expect(err).not.toBeInstanceOf(InvalidTokenError);
  });
});

// A database handle that fails the test if a request ever reaches it.
const noDatabase = (() => {
  throw new Error("the database was queried");
}) as unknown as SQL;

function request(authorization?: string): Request {
  const headers = authorization === undefined ? undefined : { authorization };
  return new Request("http://farm.test/api/sources", { headers });
}

async function expectUnauthenticated(auth: Response | { userId: string }, reason: string) {
  expect(auth).toBeInstanceOf(Response);
  const res = auth as Response;
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe("Bearer");
  expect(await res.json()).toEqual({
    error: { code: "UNAUTHENTICATED", message: expect.any(String), details: { reason } },
  });
}

describe("authenticateClient", () => {
  test.each([
    ["no Authorization header", undefined],
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ["an empty Bearer token", "Bearer "],
  ])("returns 401 for %s without touching the database", async (_, authorization) => {
    const auth = await authenticateClient(request(authorization), { verifyToken, sql: noDatabase });
    await expectUnauthenticated(auth, "missing");
  });

  test("returns 401 for an invalid token without touching the database", async () => {
    const token = await identityToken({ claims: { aud: "com.example.other" } });
    const auth = await authenticateClient(request(`Bearer ${token}`), { verifyToken, sql: noDatabase });
    await expectUnauthenticated(auth, "invalid");
  });

  test("returns 401 with reason expired for an expired token", async () => {
    const token = await identityToken({ claims: { exp: now() - 120 } });
    const auth = await authenticateClient(request(`Bearer ${token}`), { verifyToken, sql: noDatabase });
    await expectUnauthenticated(auth, "expired");
  });

  test("propagates verifier failures that are not the token's fault", async () => {
    const outage: VerifyToken = () => Promise.reject(new Error("JWKS unreachable"));
    const err = await rejection(authenticateClient(request("Bearer x.y.z"), { verifyToken: outage, sql: noDatabase }));
    expect((err as Error).message).toBe("JWKS unreachable");
  });

  describe.skipIf(!TEST_DATABASE_URL)("with a database", () => {
    const sql = new SQL(TEST_DATABASE_URL ?? "");
    afterAll(() => sql.close());

    test("creates the user on first sight and returns the sub as the user ID", async () => {
      await inRollback(sql, async (tx) => {
        const auth = await authenticateClient(request(`Bearer ${await identityToken()}`), { verifyToken, sql: tx });
        expect(auth).toEqual({ userId: SUB });

        const [user] = await tx`SELECT reputation, is_blocked FROM users WHERE id = ${SUB}`;
        expect(user).toEqual({ reputation: 1, is_blocked: false });
      });
    });

    test("leaves an existing user row untouched (§4)", async () => {
      await inRollback(sql, async (tx) => {
        await tx`INSERT INTO users (id, reputation, updated_at) VALUES (${SUB}, 7.5, '2000-01-01T00:00:00Z')`;
        const [before] = await tx`SELECT ctid::text FROM users WHERE id = ${SUB}`;

        const auth = await authenticateClient(request(`Bearer ${await identityToken()}`), { verifyToken, sql: tx });
        expect(auth).toEqual({ userId: SUB });

        // Same tuple (ctid): the row was not rewritten, not even by a no-op update.
        const [after] = await tx`SELECT ctid::text, reputation, updated_at FROM users WHERE id = ${SUB}`;
        expect(after).toEqual({
          ctid: before.ctid,
          reputation: 7.5,
          updated_at: new Date("2000-01-01T00:00:00Z"),
        });
      });
    });

    test("returns 403 ACCOUNT_BLOCKED for a blocked user", async () => {
      await inRollback(sql, async (tx) => {
        await tx`INSERT INTO users (id, is_blocked) VALUES (${SUB}, TRUE)`;

        const auth = await authenticateClient(request(`Bearer ${await identityToken()}`), { verifyToken, sql: tx });
        expect(auth).toBeInstanceOf(Response);
        const res = auth as Response;
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: { code: "ACCOUNT_BLOCKED", message: "Account blocked", details: {} },
        });
      });
    });
  });
});
