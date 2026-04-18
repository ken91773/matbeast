import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { extractBearerToken, hashToken } from "@/lib/desktop-tokens";

export type AuthOk = {
  userId: string;
  /** "clerk" = browser session, "token" = desktop bearer token */
  via: "clerk" | "token";
  /** Present only when via === "token" - the DesktopToken row id */
  tokenId?: string;
};
export type AuthFail = { response: NextResponse };

/**
 * Single auth gate for protected API routes.
 *
 * Resolution order:
 *   1. Clerk session cookie (browser usage)
 *   2. `Authorization: Bearer mbk_...` header (desktop usage)
 *
 * On a successful Bearer match, `lastUsedAt` is bumped on the token row
 * (fire-and-forget, errors swallowed - we don't want the bump to break
 * the request). Revoked tokens are rejected.
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
    const row = await prisma.desktopToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, revokedAt: true },
    });
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
  }

  return {
    response: NextResponse.json({ error: "not signed in" }, { status: 401 }),
  };
}
