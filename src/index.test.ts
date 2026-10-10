import { expect, test } from "bun:test";
import { REQUIRED_ENV } from "./config";

test("exits non-zero and names every missing variable when config is absent", async () => {
  // --no-env-file keeps a developer's local .env from satisfying the config.
  const proc = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/index.ts`], {
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await proc.exited).toBe(1);
  const stderr = await new Response(proc.stderr).text();
  for (const name of REQUIRED_ENV) {
    expect(stderr).toContain(`${name} is required`);
  }
});
