import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_PORT, REQUIRED_ENV, loadConfig } from "./config";

const FULL_ENV = {
  DATABASE_URL: "postgres://turnip:turnip@localhost:5432/turnip",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET: "turnip",
  APP_BUNDLE_ID: "kim.hoie.turnip",
  TURNIP_PIPELINE_KEY: "pipeline-key",
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("maps a complete environment", () => {
    expect(loadConfig(FULL_ENV)).toEqual({
      port: DEFAULT_PORT,
      databaseUrl: FULL_ENV.DATABASE_URL,
      r2: {
        accountId: "account",
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        bucket: "turnip",
      },
      appBundleId: "kim.hoie.turnip",
      pipelineKey: "pipeline-key",
    });
  });

  test("reports every missing variable at once", () => {
    expect(problemsFor({})).toEqual(REQUIRED_ENV.map((name) => `${name} is required`));
  });

  test("reports only the variables that are missing", () => {
    const { R2_BUCKET, APP_BUNDLE_ID, ...partial } = FULL_ENV;
    expect(problemsFor(partial)).toEqual(["R2_BUCKET is required", "APP_BUNDLE_ID is required"]);
  });

  test("treats blank values as missing", () => {
    expect(problemsFor({ ...FULL_ENV, DATABASE_URL: "  " })).toEqual([
      "DATABASE_URL is required",
    ]);
  });

  test("reads PORT", () => {
    expect(loadConfig({ ...FULL_ENV, PORT: "8080" }).port).toBe(8080);
  });

  test.each(["abc", "0", "65536", "80.5", "-1"])("rejects PORT=%p", (port) => {
    expect(problemsFor({ ...FULL_ENV, PORT: port })).toEqual([
      `PORT must be an integer between 1 and 65535 (got "${port}")`,
    ]);
  });

  test("message lists every problem", () => {
    expect(() => loadConfig({ PORT: "x" })).toThrow(/DATABASE_URL is required[\s\S]*PORT must be/);
  });
});
