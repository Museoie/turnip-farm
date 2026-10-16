import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { generateKeyPair, jwtVerify } from "jose";
import {
  APPLE_ISSUER,
  AppleUnavailableError,
  InvalidTokenError,
  createAppleJwtVerifier,
  createAppleTokenVerifier,
  createCodeExchanger,
  mintClientSecret,
} from "./apple";
import { APPLE_REFRESH_TOKEN, AUDIENCE, SUB, startMockApple } from "./testing";

const apple = await startMockApple();
afterAll(() => apple.stop());
afterEach(() => apple.reset());

const verify = createAppleTokenVerifier({ audience: AUDIENCE, jwksUrl: apple.jwksUrl });
const now = () => Math.floor(Date.now() / 1000);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err) => err,
  );
}

describe("createAppleTokenVerifier", () => {
  test("returns only the sub and nonce of a valid token", async () => {
    const identity = await verify(await apple.identityToken({ claims: { nonce: "n0nce" } }));
    expect(identity).toEqual({ sub: SUB, nonce: "n0nce" });
  });

  test("reports an absent nonce as undefined", async () => {
    expect(await verify(await apple.identityToken())).toEqual({ sub: SUB, nonce: undefined });
  });

  test("accepts a token expired within the clock-skew leeway", async () => {
    expect((await verify(await apple.identityToken({ claims: { exp: now() - 20 } }))).sub).toBe(SUB);
  });

  test.each([
    ["expired beyond the leeway", () => apple.identityToken({ claims: { exp: now() - 120 } })],
    ["unknown kid", () => apple.identityToken({ kid: "k2" })],
    ["wrong issuer", () => apple.identityToken({ claims: { iss: "https://example.com" } })],
    ["wrong audience", () => apple.identityToken({ claims: { aud: "com.example.other" } })],
    ["missing sub", () => apple.identityToken({ claims: { sub: undefined } })],
    ["missing exp", () => apple.identityToken({ claims: { exp: undefined } })],
    [
      "known kid, signed by another key",
      async () => apple.identityToken({ key: (await generateKeyPair("RS256")).privateKey }),
    ],
    [
      "HS256 (algorithm confusion)",
      () => apple.identityToken({ key: new TextEncoder().encode("a-shared-secret-of-32-bytes-long") }),
    ],
    ["not a JWT", async () => "not.a.jwt"],
  ])("rejects a token: %s", async (_, makeToken) => {
    expect(await rejection(verify(await makeToken()))).toBeInstanceOf(InvalidTokenError);
  });

  // A JWKS outage must not read as a bad token (that would be a 401).
  async function verifyAgainst(jwks: () => Response, { stopFirst = false } = {}) {
    const server = Bun.serve({ port: 0, fetch: jwks });
    if (stopFirst) server.stop(true);
    try {
      const verifyHere = createAppleTokenVerifier({ audience: AUDIENCE, jwksUrl: server.url });
      return await rejection(verifyHere(await apple.identityToken()));
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

describe("createAppleJwtVerifier in notification mode (requireExp: false)", () => {
  const verifyNotification = createAppleJwtVerifier({ audience: AUDIENCE, jwksUrl: apple.jwksUrl, requireExp: false });

  test("accepts Apple's notification shape: no exp, subject inside events only", async () => {
    const payload = await verifyNotification(
      await apple.notificationPayload({ claims: { events: { type: "consent-revoked", sub: SUB } } }),
    );
    expect(payload.iss).toBe(APPLE_ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
    expect(payload.sub).toBeUndefined();
    expect(payload.events).toEqual({ type: "consent-revoked", sub: SUB });
  });

  test.each([
    ["wrong issuer", () => apple.notificationPayload({ claims: { iss: "https://example.com" } })],
    ["wrong audience", () => apple.notificationPayload({ claims: { aud: "com.example.other" } })],
    [
      "known kid, signed by another key",
      async () => apple.notificationPayload({ key: (await generateKeyPair("RS256")).privateKey }),
    ],
    ["not a JWT", async () => "not.a.jwt"],
  ])("still rejects a bad payload: %s", async (_, makeToken) => {
    expect(await rejection(verifyNotification(await makeToken()))).toBeInstanceOf(InvalidTokenError);
  });
});

describe("mintClientSecret", () => {
  test("is an ES256 JWT from the team, for Apple, about the app, valid five minutes", async () => {
    const secret = await mintClientSecret(apple.credentials);
    const { payload, protectedHeader } = await jwtVerify(secret, apple.farmPublicKey, {
      issuer: "TEAM123456",
      audience: APPLE_ISSUER,
      subject: AUDIENCE,
    });
    expect(protectedHeader).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });
});

describe("createCodeExchanger", () => {
  const exchange = createCodeExchanger({ credentials: apple.credentials, tokenUrl: apple.tokenUrl });

  test("posts the code with a valid client secret and returns Apple's tokens", async () => {
    const tokens = await exchange("auth-code");
    expect(tokens.refreshToken).toBe(APPLE_REFRESH_TOKEN);
    expect((await verify(tokens.idToken)).sub).toBe(SUB);

    const [form] = apple.tokenRequests;
    expect(form?.get("client_id")).toBe(AUDIENCE);
    expect(form?.get("code")).toBe("auth-code");
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.has("redirect_uri")).toBe(false);
    await jwtVerify(form?.get("client_secret") ?? "", apple.farmPublicKey, { issuer: "TEAM123456" });
  });

  test("treats invalid_grant as the request's fault", async () => {
    apple.respondWith(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await rejection(exchange("used-code"))).toBeInstanceOf(InvalidTokenError);
  });

  test.each([
    ["answers 500", () => apple.respondWith(() => new Response("down", { status: 500 }))],
    ["times out", () => apple.respondWith(() => Bun.sleep(200).then(() => Response.json({})))],
  ])("reports Apple as unavailable when the token endpoint %s", async (_, arrange) => {
    arrange();
    const quick = createCodeExchanger({ credentials: apple.credentials, tokenUrl: apple.tokenUrl, timeoutMs: 50 });
    expect(await rejection(quick("auth-code"))).toBeInstanceOf(AppleUnavailableError);
  });

  test("reports Apple as unavailable when the token endpoint is unreachable", async () => {
    const down = Bun.serve({ port: 0, fetch: () => new Response() });
    down.stop(true);
    const unreachable = createCodeExchanger({ credentials: apple.credentials, tokenUrl: down.url });
    expect(await rejection(unreachable("auth-code"))).toBeInstanceOf(AppleUnavailableError);
  });

  test.each([
    ["invalid_client (farm misconfigured)", () => Response.json({ error: "invalid_client" }, { status: 400 })],
    ["a 200 without a refresh token", () => Response.json({ id_token: "x", access_token: "y" })],
  ])("fails as a server error on %s", async (_, respond) => {
    apple.respondWith(respond);
    const err = await rejection(exchange("auth-code"));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidTokenError);
    expect(err).not.toBeInstanceOf(AppleUnavailableError);
  });
});
