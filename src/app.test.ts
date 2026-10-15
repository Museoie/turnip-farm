import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { type AppDeps, createHandler, startServer } from "./app";
import { noDatabase } from "./auth/testing";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

const noR2: R2Client = {
  presignPut: () => {
    throw new Error("r2 unavailable in this test");
  },
  presignGet: () => {
    throw new Error("r2 unavailable in this test");
  },
  getBytes: () => {
    throw new Error("r2 unavailable in this test");
  },
  deleteObject: () => {
    throw new Error("r2 unavailable in this test");
  },
};

// Stand-ins that fail loudly if a route reaches them unexpectedly.
const deps: AppDeps = {
  sql: noDatabase,
  verifyIdentityToken: () => Promise.reject(new Error("verifier unavailable in this test")),
  exchangeCode: () => Promise.reject(new Error("Apple unavailable in this test")),
  refreshTokenKey: {} as CryptoKey,
  r2: noR2,
  limits: { user: new TokenBucket(1000, 60000), ip: new TokenBucket(1000, 60000) },
};

const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Not found", details: {} } };

describe("createHandler routing", () => {
  const handle = createHandler(deps);
  const request = (method: string, path: string) => new Request(`http://farm.test${path}`, { method });

  test("GET /healthz returns 200", async () => {
    const res = await handle(request("GET", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test.each([
    ["GET", "/nope"],
    ["POST", "/healthz"],
    ["GET", "/api/auth/apple"],
    ["GET", "/api/auth/signout"],
  ])("%s %s returns 404 in the API error shape", async (method, path) => {
    const res = await handle(request(method, path));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  test("POST /api/auth/apple reaches the sign-in handler", async () => {
    const res = await handle(new Request("http://farm.test/api/auth/apple", { method: "POST", body: "{}" }));
    expect(res.status).toBe(422);
  });

  test("POST /api/auth/signout reaches the sign-out handler", async () => {
    expect((await handle(request("POST", "/api/auth/signout"))).status).toBe(204);
  });

  test("contribution routes reach their handlers (401 before any DB touch)", async () => {
    // noDatabase throws if a handler reaches the database; 401 proves the
    // route dispatched to a session-guarded handler.
    for (const [method, path] of [
      ["POST", "/api/sources"],
      ["GET", "/api/sources/abc"],
      ["GET", "/api/sources/abc/pose"],
      ["DELETE", "/api/sources/abc"],
      ["POST", "/api/clips"],
      ["POST", "/api/clips/abc/labels"],
    ] as const) {
      const res = await handle(request(method, path));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    }
  });

  test("wrong-method contribution routes are 404", async () => {
    for (const [method, path] of [
      ["GET", "/api/sources"],
      ["PUT", "/api/sources/abc"],
      ["GET", "/api/clips"],
      ["GET", "/api/clips/abc/labels"],
      ["DELETE", "/api/clips/abc/labels"],
    ] as const) {
      const res = await handle(request(method, path));
      expect(res.status).toBe(404);
    }
  });
});

describe("startServer", () => {
  const server = startServer(0, deps);
  afterAll(() => server.stop(true));

  test("serves the routes over HTTP", async () => {
    const res = await fetch(new URL("/healthz", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("turns an unexpected error into 500 INTERNAL, logging the error but not the request", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = JSON.stringify({ identity_token: "secret-identity-token", authorization_code: "y", nonce: "z" });
      const res = await fetch(new URL("/api/auth/apple", server.url), { method: "POST", body });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: "INTERNAL", message: "Internal server error", details: {} },
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-identity-token");
    } finally {
      logged.mockRestore();
    }
  });
});
