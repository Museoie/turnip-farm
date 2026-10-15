// Account deletion (BACKEND_DESIGN.md §7.3 `DELETE /api/account`).
//
// App Review guideline 5.1.1(v): the client first deletes every source it
// holds a key for (the farm cannot enforce that step), then calls this
// endpoint, which revokes Apple's refresh token, deletes the sources still
// attributed to the account, and deletes the user row. Steps run in order so
// a retry after a partial failure finishes the job.

import type { SQL } from "bun";
import { transaction } from "../db";
import { errorResponse } from "../errors";
import type { R2Client } from "../r2/client";
import { stagingKeyFor } from "../r2/keys";
import { AppleUnavailableError, type RevokeRefreshToken } from "./apple";
import { authenticateClient } from "./sessions";
import { decryptRefreshToken } from "./tokens";

export interface AccountDeps {
  sql: SQL;
  r2: R2Client;
  // AES-256-GCM key for users.apple_refresh_token.
  refreshTokenKey: CryptoKey;
  revokeRefreshToken: RevokeRefreshToken;
}

// DELETE /api/account: session required; allowed for blocked users (§1.2.16).
// 204 once deleted. A retry after success gets 401 — the session is gone.
export async function handleDeleteAccount(req: Request, deps: AccountDeps): Promise<Response> {
  const auth = await authenticateClient(req, deps, { allowBlocked: true });
  if (auth instanceof Response) return auth;
  const userId = auth.userId;

  // Step 1: revoke Apple's refresh token, if the farm holds one. Apple
  // answers 200 both when it revokes and when the token was already
  // invalid; anything else means the farm is misconfigured and must not
  // block the deletion.
  const [user] = await deps.sql`SELECT apple_refresh_token FROM users WHERE id = ${userId}`;
  const sealed = user?.apple_refresh_token as Uint8Array<ArrayBuffer> | null | undefined;
  if (sealed != null) {
    let refreshToken = "";
    try {
      refreshToken = await decryptRefreshToken(deps.refreshTokenKey, userId, sealed);
    } catch (err) {
      // Corrupt ciphertext: there is no usable token to revoke.
      console.error("decrypting the Apple refresh token failed; deleting the account anyway", err);
    }
    if (refreshToken !== "") {
      try {
        await deps.revokeRefreshToken(refreshToken);
      } catch (err) {
        if (err instanceof AppleUnavailableError) {
          // Apple unreachable: 503 with nothing deleted, so the retry
          // revokes before it deletes.
          return errorResponse(503, "APPLE_UNAVAILABLE", "Apple is unreachable; retry later");
        }
        console.error("revoking the Apple refresh token failed; deleting the account anyway", err);
      }
    }
  }

  try {
    await deleteAccountData(deps.sql, deps.r2, userId);
  } catch {
    return errorResponse(500, "INTERNAL", "Could not delete the stored blobs; retry later");
  }
  return new Response(null, { status: 204 });
}

// Steps 2–3 of `DELETE /api/account`, shared with the `account-deleted`
// server-to-server notification (which has no session and no token left to
// revoke): delete every source still attributed to the user, then the user
// row. R2 blobs go before the rows, mirroring `DELETE /api/sources/:id`:
// if a blob delete throws, the rows survive and the retry finishes the job.
// Sources past the 30-day attribution window are unlinked training data and
// stay (§1.2.17). Deleting the user row cascades sessions, reports, and any
// remaining attribution (§3).
export async function deleteAccountData(sql: SQL, r2: R2Client, userId: string): Promise<void> {
  const attributed = await sql`
    SELECT s.id, s.r2_key
    FROM source_attribution a
    JOIN sources s ON s.id = a.source_id
    WHERE a.user_id = ${userId} AND a.attributed_at >= now() - interval '30 days'`;
  for (const row of attributed as { id: string; r2_key: string }[]) {
    await r2.deleteObject(row.r2_key);
    await r2.deleteObject(stagingKeyFor(row.id));
  }
  await transaction(sql, async (tx) => {
    await tx`
      DELETE FROM sources
      WHERE id IN (
        SELECT source_id FROM source_attribution
        WHERE user_id = ${userId} AND attributed_at >= now() - interval '30 days'
      )`;
    await tx`DELETE FROM users WHERE id = ${userId}`;
  });
}
