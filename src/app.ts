// HTTP surface. Routing lives here, apart from src/index.ts, so tests can
// build the handler with stand-in dependencies, or start a real server on an
// ephemeral port, without loading config.

import { type SignInDeps, handleSignIn, handleSignOut } from "./auth/sessions";
import { errorResponse } from "./errors";

export type AppDeps = SignInDeps;

export function createHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const { pathname } = new URL(req.url);
    const route = `${req.method} ${pathname}`;
    switch (route) {
      case "GET /healthz":
        return Response.json({ status: "ok" });
      case "POST /api/auth/apple":
        return handleSignIn(req, deps);
      case "POST /api/auth/signout":
        return handleSignOut(req, deps);
      default:
        return errorResponse(404, "NOT_FOUND", "Not found");
    }
  };
}

export function startServer(port: number, deps: AppDeps) {
  return Bun.serve({
    port,
    fetch: createHandler(deps),
    error(err) {
      // Log the error, never the request: requests carry Apple tokens,
      // session tokens, and pose data (BACKEND_DESIGN.md §8).
      console.error(err);
      return errorResponse(500, "INTERNAL", "Internal server error");
    },
  });
}
