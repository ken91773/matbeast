import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  try {
    await prisma.masterTeamName.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Record to delete does not exist")) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const rawName = (body as { name?: unknown })?.name;
  if (typeof rawName !== "string") {
    return NextResponse.json({ error: "name (string) required" }, { status: 400 });
  }
  const name = rawName.trim().toUpperCase();
  if (name.length === 0) {
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  }

  try {
    const team = await prisma.masterTeamName.update({
      where: { id },
      data: { name, updatedByUserId: a.userId },
    });
    return NextResponse.json({ team });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
