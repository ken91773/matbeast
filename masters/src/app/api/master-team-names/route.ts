import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const teams = await prisma.masterTeamName.findMany({
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ teams });
}

export async function POST(req: NextRequest) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

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
  if (name.length > 200) {
    return NextResponse.json({ error: "name too long (max 200)" }, { status: 400 });
  }

  try {
    const team = await prisma.masterTeamName.create({
      data: {
        name,
        createdByUserId: a.userId,
        updatedByUserId: a.userId,
      },
    });
    return NextResponse.json({ team }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Unique constraint")) {
      const existing = await prisma.masterTeamName.findUnique({ where: { name } });
      return NextResponse.json(
        { team: existing, alreadyExisted: true },
        { status: 200 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
