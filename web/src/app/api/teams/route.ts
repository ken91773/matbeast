import type { EventKind } from "@prisma/client";
import { NextResponse } from "next/server";
import { getEventIdOrThrow } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { ensureEightTeamSlots } from "@/lib/teams-bootstrap";
import { ensureDefaultTournament } from "@/lib/tournament";

function parseEventKind(v: string | null): EventKind | null {
  if (v === "BLUE_BELT" || v === "PURPLE_BROWN") return v;
  return null;
}

/** GET ?eventKind=BLUE_BELT|PURPLE_BROWN (required) */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const kind = parseEventKind(searchParams.get("eventKind"));
    if (!kind) {
      return NextResponse.json(
        { error: "Query eventKind=BLUE_BELT or PURPLE_BROWN is required" },
        { status: 400 },
      );
    }

    const tournament = await ensureDefaultTournament();
    const eventId = await getEventIdOrThrow(tournament.id, kind);
    await ensureEightTeamSlots(eventId);

    const teams = await prisma.team.findMany({
      where: { eventId },
      orderBy: [{ seedOrder: "asc" }, { name: "asc" }],
      include: {
        players: { orderBy: { lineupOrder: "asc" } },
      },
    });
    return NextResponse.json({
      tournamentId: tournament.id,
      eventId,
      eventKind: kind,
      teams,
    });
  } catch (e) {
    console.error("[GET /api/teams]", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      {
        error: message,
        hint: "Run: npx prisma generate && npx prisma db push",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const tournament = await ensureDefaultTournament();
    const body = (await req.json()) as {
      name?: string;
      seedOrder?: number;
      eventKind?: EventKind;
    };
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const kind = body.eventKind;
    if (kind !== "BLUE_BELT" && kind !== "PURPLE_BROWN") {
      return NextResponse.json(
        { error: "eventKind BLUE_BELT or PURPLE_BROWN is required" },
        { status: 400 },
      );
    }
    const eventId = await getEventIdOrThrow(tournament.id, kind);
    const count = await prisma.team.count({ where: { eventId } });
    if (count >= 8) {
      return NextResponse.json(
        { error: "Maximum 8 teams per event" },
        { status: 400 },
      );
    }
    const team = await prisma.team.create({
      data: {
        eventId,
        name,
        seedOrder: body.seedOrder ?? count + 1,
      },
    });
    return NextResponse.json(team);
  } catch (e) {
    console.error("[POST /api/teams]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 400 });
  }
}
