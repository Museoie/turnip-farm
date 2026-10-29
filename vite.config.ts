import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web client lives in src/client and builds into build/client, next to
// the server bundle in build/server (see src/pack.ts) — the same split the
// budget repo uses. In development Vite serves the client on :5173 and
// proxies /api to the farm API on its default port, 3000.
export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../build/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
