import { describe, expect, test } from "bun:test";
import { authenticatePipeline } from "./pipeline";

const KEY = "pipeline-key-123";

function reqWith(auth: string | null): Request {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return new Request("http://localhost/api/models", { headers });
}

async function denied(res: Response | null) {
  expect(res).not.toBeNull();
  expect(res!.status).toBe(401);
  expect(res!.headers.get("WWW-Authenticate")).toBe("Bearer");
  const body = (await res!.json()) as { error: { code: string } };
  expect(body.error.code).toBe("UNAUTHENTICATED");
}

describe("authenticatePipeline", () => {
  test("valid key passes (null)", () => {
    expect(authenticatePipeline(reqWith(`Bearer ${KEY}`), KEY)).toBeNull();
  });

  test("missing header returns 401 with a Bearer challenge", async () => {
    await denied(authenticatePipeline(reqWith(null), KEY));
  });

  test("non-Bearer scheme returns 401", async () => {
    await denied(authenticatePipeline(reqWith(`Token ${KEY}`), KEY));
  });

  test("Bearer with no token returns 401", async () => {
    await denied(authenticatePipeline(reqWith("Bearer"), KEY));
    await denied(authenticatePipeline(reqWith("Bearer "), KEY));
  });

  test("wrong key of the same length returns 401", async () => {
    await denied(authenticatePipeline(reqWith("Bearer pipeline-key-124"), KEY));
  });

  test("wrong-length key returns 401 (no timingSafeEqual throw)", async () => {
    await denied(authenticatePipeline(reqWith("Bearer short"), KEY));
    await denied(authenticatePipeline(reqWith(`Bearer ${KEY}-extra`), KEY));
  });
});
