import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/desktop-tokens/:id
 *
 * Soft-revokes a token owned by the signed-in user. Other users' tokens
 * return 404 so ids are not enumerable across accounts.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const existing = await prisma.desktopToken.findFirst({
    where: { id, userId: a.userId },
    select: { id: true, revokedAt: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (existing.revokedAt !== null) {
    return NextResponse.json({ error: "already revoked" }, { status: 400 });
  }

  try {
    const row = await prisma.desktopToken.update({
      where: { id: existing.id },
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
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
