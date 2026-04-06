import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = (await req.json()) as { name?: string; seedOrder?: number };

  try {
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (
      body.seedOrder !== undefined &&
      body.seedOrder !== existing.seedOrder &&
      body.seedOrder >= 1 &&
      body.seedOrder <= 8
    ) {
      const conflict = await prisma.team.findFirst({
        where: {
          eventId: existing.eventId,
          seedOrder: body.seedOrder,
          NOT: { id },
        },
      });
      if (conflict) {
        await prisma.$transaction([
          prisma.team.update({
            where: { id: conflict.id },
            data: { seedOrder: existing.seedOrder },
          }),
          prisma.team.update({
            where: { id },
            data: { seedOrder: body.seedOrder },
          }),
        ]);
      } else {
        await prisma.team.update({
          where: { id },
          data: { seedOrder: body.seedOrder },
        });
      }
    }

    const nameUpdate =
      body.name !== undefined
        ? body.name.trim().length > 0
          ? body.name.trim()
          : "TBD"
        : undefined;

    if (nameUpdate !== undefined) {
      await prisma.team.update({
        where: { id },
        data: { name: nameUpdate },
      });
    }

    const team = await prisma.team.findUnique({
      where: { id },
      include: {
        players: { orderBy: { lineupOrder: "asc" } },
      },
    });
    return NextResponse.json(team);
  } catch (e) {
    console.error("[PATCH team]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await prisma.team.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
