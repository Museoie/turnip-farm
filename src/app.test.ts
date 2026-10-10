import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "./app";

const server = startServer(0);
afterAll(() => server.stop(true));

describe("GET /healthz", () => {
  test("returns 200", async () => {
    const res = await fetch(new URL("/healthz", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("unknown routes", () => {
  test.each([
    ["GET", "/nope"],
    ["POST", "/healthz"],
  ])("%s %s returns 404 in the API error shape", async (method, path) => {
    const res = await fetch(new URL(path, server.url), { method });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found", details: {} },
    });
  });
});
