// HTTP surface. Routing lives here, apart from src/index.ts, so tests can
// start a real server on an ephemeral port without loading config.

// BACKEND_DESIGN.md §7.2 error codes; extended as endpoints land.
export type ErrorCode = "NOT_FOUND" | "INTERNAL";

export function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return Response.json({ error: { code, message, details: {} } }, { status });
}

export function handleRequest(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (req.method === "GET" && pathname === "/healthz") {
    return Response.json({ status: "ok" });
  }
  return errorResponse(404, "NOT_FOUND", "Not found");
}

export function startServer(port: number) {
  return Bun.serve({
    port,
    fetch: handleRequest,
    error(err) {
      // Log the error, never the request: requests carry Apple identity
      // tokens and pose data (BACKEND_DESIGN.md §8).
      console.error(err);
      return errorResponse(500, "INTERNAL", "Internal server error");
    },
  });
}
