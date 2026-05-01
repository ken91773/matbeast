import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { extractBearerToken, hashToken } from "@/lib/desktop-tokens";

export type AuthOk = {
  userId: string;
  /**
   * "clerk"  = browser session,
   * "token"  = legacy desktop bearer token,
   * "shared" = no authentication present, request attributed to the
   *            shared workspace user (Mat Beast Masters v0.5.0+).
   */
  via: "clerk" | "token" | "shared";
  /** Present only when via === "token" - the DesktopToken row id */
  tokenId?: string;
};
export type AuthFail = { response: NextResponse };

/**
 * Stable userId attributed to all writes from un-authenticated callers.
 *
 * Mat Beast Masters has always served a single shared workspace where
 * every signed-in user can see every event (see comments in
 * `events/route.ts`). Starting in v0.5.0 we drop the auth barrier
 * entirely so the desktop app no longer needs a token to read or write.
 *
 * The userId columns in the schema are plain strings, not foreign
 * keys, so this constant slots in cleanly with no migration. Audit
 * trails for events created before this change still show the
 * original Clerk user id; new rows show this sentinel.
 */
const SHARED_WORKSPACE_USER_ID = "shared-workspace";

/**
 * Resolve the caller's identity for a protected API route.
 *
 * v0.5.0 (Mat Beast Masters): this function NEVER fails. Resolution
 * order is:
 *
 *   1. Clerk session cookie (browser usage of the masters/ web UI)
 *   2. `Authorization: Bearer mbk_...` header (legacy desktop usage —
 *      kept working so v1.1.x and earlier desktop installs that still
 *      have a saved token continue to function during the rollout)
 *   3. No credentials → attributed to `SHARED_WORKSPACE_USER_ID`
 *
 * On a successful Bearer match, `lastUsedAt` is bumped on the token
 * row (fire-and-forget). Revoked tokens are NOT rejected anymore — we
 * simply ignore the bearer header and fall through to the shared
 * workspace user, so the desktop request still succeeds.
 *
 * The `AuthFail` arm of the return union is kept for API back-compat
 * with existing route handlers (`if ("response" in a) return a.response;`).
 * It is no longer reachable from this function.
 */
export async function requireUserId(): Promise<AuthOk | AuthFail> {
  const { userId } = await auth();
  if (userId) {
    return { userId, via: "clerk" };
  }

  const hdrs = await headers();
  const plaintext = extractBearerToken(hdrs);
  if (plaintext) {
    const tokenHash = hashToken(plaintext);
    const row = await prisma.desktopToken
      .findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, revokedAt: true },
      })
      .catch(() => null);
    if (row && row.revokedAt === null) {
      void prisma.desktopToken
        .update({
          where: { id: row.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => {
          /* best-effort timestamp bump */
        });
      return { userId: row.userId, via: "token", tokenId: row.id };
    }
    /**
     * Bearer header was present but invalid / revoked. Fall through
     * to the shared user rather than rejecting — matches the v0.5.0
     * "no auth required" promise. Old installs whose token has been
     * deleted in the dashboard still get to keep syncing.
     */
  }

  return { userId: SHARED_WORKSPACE_USER_ID, via: "shared" };
}
