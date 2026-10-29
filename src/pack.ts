import { readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

// Bundles the server entry point into build/server/bundle.js, mirroring
// the budget repo's src/server/pack.ts. The web client builds separately
// (vite build → build/client) and is served from there by the handler.
const root = resolve(import.meta.dir);

async function bundle() {
  const result = await Bun.build({
    entrypoints: [resolve(root, "index.ts")],
    outdir: resolve(root, "..", "build", "server"),
    target: "bun",
    minify: false,
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Rename output to bundle.js
  const outputPath = resolve(root, "..", "build", "server");
  const files = readdirSync(outputPath);
  const jsFile = files.find((f) => f.endsWith(".js") && f !== "bundle.js");
  if (jsFile) {
    renameSync(resolve(outputPath, jsFile), resolve(outputPath, "bundle.js"));
  }

  console.info("Bun build succeeded to compile server.");
}

bundle();
