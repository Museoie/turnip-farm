// HTTP surface. Routing lives here, apart from src/index.ts, so tests can
// build the handler with stand-in dependencies, or start a real server on an
// ephemeral port, without loading config.

import { type SignInDeps, handleSignIn, handleSignOut } from "./auth/sessions";
import {
  handleDeleteSource,
  handleGetSource,
  handleGetSourcePose,
  handleRegisterSource,
} from "./contrib/sources";
import { handlePostClipLabels, handlePostClips } from "./contrib/clips";
import { errorResponse } from "./errors";
import type { R2Client } from "./r2/client";
import { TokenBucket } from "./ratelimit";

export interface RateLimits {
  /** Per-user token bucket for the contribution POSTs (§7.2). */
  user: TokenBucket;
  /** Per-IP token bucket for POST /api/auth/apple (§7.2). */
  ip: TokenBucket;
}

export type AppDeps = SignInDeps & {
  r2: R2Client;
  limits: RateLimits;
};

export function createHandler(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const seg = new URL(req.url).pathname.split("/").filter(Boolean);
    const method = req.method;

    if (method === "GET" && seg.length === 1 && seg[0] === "healthz") {
      return Response.json({ status: "ok" });
    }
    if (seg[0] === "api") {
      if (method === "POST" && seg.length === 3 && seg[1] === "auth") {
        if (seg[2] === "apple") return handleSignIn(req, deps);
        if (seg[2] === "signout") return handleSignOut(req, deps);
      }
      if (seg[1] === "sources") {
        if (method === "POST" && seg.length === 2) return handleRegisterSource(req, deps);
        if (seg.length === 3) {
          if (method === "GET") return handleGetSource(req, deps, seg[2]!);
          if (method === "DELETE") return handleDeleteSource(req, deps, seg[2]!);
        }
        if (method === "GET" && seg.length === 4 && seg[3] === "pose") {
          return handleGetSourcePose(req, deps, seg[2]!);
        }
      }
      if (seg[1] === "clips") {
        if (method === "POST" && seg.length === 2) return handlePostClips(req, deps);
        if (method === "POST" && seg.length === 4 && seg[3] === "labels") {
          return handlePostClipLabels(req, deps, seg[2]!);
        }
      }
    }
    return errorResponse(404, "NOT_FOUND", "Not found");
  };
}

export function startServer(port: number, deps: AppDeps) {
  const handle = createHandler(deps);
  return Bun.serve({
    port,
    fetch(req, server) {
      // Per-IP limit on sign-in attempts (§7.2); there is no user yet.
      if (req.method === "POST" && new URL(req.url).pathname === "/api/auth/apple") {
        const ip = server.requestIP(req)?.address ?? "unknown";
        if (!deps.limits.ip.take(ip)) {
          return errorResponse(429, "RATE_LIMITED", "Too many requests", {
            headers: { "Retry-After": String(deps.limits.ip.retryAfterSec(ip)) },
          });
        }
      }
      return handle(req);
    },
    error(err) {
      // Log the error, never the request: requests carry Apple tokens,
      // session tokens, and pose data (BACKEND_DESIGN.md §8).
      console.error(err);
      return errorResponse(500, "INTERNAL", "Internal server error");
    },
  });
}
