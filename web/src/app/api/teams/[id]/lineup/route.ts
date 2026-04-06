import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyTeamSlots } from "@/lib/team-lineup";

type Params = { params: Promise<{ id: string }> };

/** POST { slots: (string | null)[] } — length 7; each entry is a player id or null; must list every player on the team exactly once */
export async function POST(req: Request, { params }: Params) {
  const teamId = (await params).id;
  const body = (await req.json()) as { slots?: (string | null)[] };
  const slots = body.slots;
  if (!Array.isArray(slots) || slots.length !== 7) {
    return NextResponse.json(
      { error: "slots must be an array of length 7" },
      { status: 400 },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await applyTeamSlots(tx, teamId, slots);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Lineup update failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const players = await prisma.player.findMany({
    where: { teamId },
    orderBy: { lineupOrder: "asc" },
    include: { team: true },
  });
  return NextResponse.json({ players });
}
