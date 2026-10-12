// The API error shape: {"error": {"code", "message", "details"}}.

// BACKEND_DESIGN.md §7.2 error codes; extended as endpoints land.
export type ErrorCode = "UNAUTHENTICATED" | "ACCOUNT_BLOCKED" | "NOT_FOUND" | "INTERNAL";

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  { details = {}, headers }: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Response {
  return Response.json({ error: { code, message, details } }, { status, headers });
}
