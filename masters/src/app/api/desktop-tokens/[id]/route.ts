import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/desktop-tokens/:id
 *
 * Soft-revokes a token. We keep the row (with `revokedAt` set) instead
 * of deleting so that the admin UI can show "revoked by X on Y" history.
 * The auth middleware rejects any token whose row has `revokedAt != null`.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const row = await prisma.desktopToken.update({
      where: { id },
      data: {
        revokedAt: new Date(),
        revokedByUserId: a.userId,
      },
      select: {
        id: true,
        label: true,
        revokedAt: true,
        revokedByUserId: true,
      },
    });
    return NextResponse.json({ token: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Record to update not found")) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
