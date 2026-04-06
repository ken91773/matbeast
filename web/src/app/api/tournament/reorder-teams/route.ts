import type { EventKind } from "@prisma/client";
import { NextResponse } from "next/server";
import { getEventIdOrThrow } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { ensureDefaultTournament } from "@/lib/tournament";

/** POST { teamIds: string[], eventKind: BLUE_BELT | PURPLE_BROWN } */
export async function POST(req: Request) {
  const tournament = await ensureDefaultTournament();
  const body = (await req.json()) as {
    teamIds?: string[];
    eventKind?: EventKind;
  };
  if (!Array.isArray(body.teamIds) || body.teamIds.length !== 8) {
    return NextResponse.json(
      { error: "teamIds must be an array of 8 team ids" },
      { status: 400 },
    );
  }
  if (body.eventKind !== "BLUE_BELT" && body.eventKind !== "PURPLE_BROWN") {
    return NextResponse.json(
      { error: "eventKind is required" },
      { status: 400 },
    );
  }

  const eventId = await getEventIdOrThrow(tournament.id, body.eventKind);

  const teams = await prisma.team.findMany({
    where: { eventId },
  });
  if (teams.length !== 8) {
    return NextResponse.json(
      { error: "Expected 8 teams for this event" },
      { status: 400 },
    );
  }
  const valid = new Set(teams.map((t) => t.id));
  for (const id of body.teamIds) {
    if (!valid.has(id)) {
      return NextResponse.json({ error: "Invalid team id for this event" }, { status: 400 });
    }
  }
  if (new Set(body.teamIds).size !== 8) {
    return NextResponse.json({ error: "Duplicate team id" }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < 8; i++) {
      await tx.team.update({
        where: { id: body.teamIds![i] },
        data: { seedOrder: 100 + i },
      });
    }
    for (let i = 0; i < 8; i++) {
      await tx.team.update({
        where: { id: body.teamIds![i] },
        data: { seedOrder: i + 1 },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
