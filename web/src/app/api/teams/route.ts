import type { EventKind } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import { getEventIdOrThrow, getPrimaryEventIdOrThrow } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import {
  upsertMasterTeamName,
  upsertTrainingMasterTeamName,
} from "@/lib/master-team-names";
import { tournamentUsesTrainingMasters } from "@/lib/masters-training-mode";
import {
  forbiddenUserChosenTeamNameMessage,
  isForbiddenUserChosenTeamName,
} from "@/lib/reserved-team-names";
import { ensureEightTeamSlots } from "@/lib/teams-bootstrap";
import { ensureDefaultTournament } from "@/lib/tournament";

function parseEventKind(v: string | null): EventKind | null {
  if (v === "BLUE_BELT" || v === "PURPLE_BROWN") return v;
  return null;
}

async function resolveTournamentId(req: Request): Promise<string> {
  const url = new URL(req.url);
  const qp = url.searchParams.get("tournamentId")?.trim();
  if (qp) return qp;
  return resolveTournamentIdFromRequest(req);
}

/** GET — primary event roster for tournament (header or ?tournamentId=). Legacy: ?eventKind= for default tournament only */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const legacyKind = parseEventKind(searchParams.get("eventKind"));
    let tournamentId: string;
    let eventId: string;
    let eventKind: EventKind;

    if (legacyKind) {
      const tournament = await ensureDefaultTournament();
      tournamentId = tournament.id;
      eventId = await getEventIdOrThrow(tournamentId, legacyKind);
      eventKind = legacyKind;
    } else {
      tournamentId = await resolveTournamentId(req);
      eventId = await getPrimaryEventIdOrThrow(tournamentId);
      const eventRow = await prisma.event.findUnique({
        where: { id: eventId },
        select: { kind: true },
      });
      eventKind = eventRow?.kind ?? "BLUE_BELT";
    }

    await ensureEightTeamSlots(eventId);

    const teams = await prisma.team.findMany({
      where: { eventId },
      orderBy: [{ seedOrder: "asc" }, { name: "asc" }],
      include: {
        players: { orderBy: { lineupOrder: "asc" } },
      },
    });
    return NextResponse.json({
      tournamentId,
      eventId,
      eventKind,
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
    const body = (await req.json()) as {
      name?: string;
      seedOrder?: number;
      eventKind?: EventKind;
      tournamentId?: string;
    };
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (isForbiddenUserChosenTeamName(name)) {
      return NextResponse.json(
        { error: forbiddenUserChosenTeamNameMessage() },
        { status: 400 },
      );
    }

    let tournamentId: string;
    let eventId: string;

    if (body.eventKind === "BLUE_BELT" || body.eventKind === "PURPLE_BROWN") {
      const tournament = await ensureDefaultTournament();
      tournamentId = tournament.id;
      eventId = await getEventIdOrThrow(tournamentId, body.eventKind);
    } else if (typeof body.tournamentId === "string" && body.tournamentId.trim()) {
      tournamentId = body.tournamentId.trim();
      eventId = await getPrimaryEventIdOrThrow(tournamentId);
    } else {
      tournamentId = await resolveTournamentIdFromRequest(req);
      eventId = await getPrimaryEventIdOrThrow(tournamentId);
    }

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
    const training = await tournamentUsesTrainingMasters(tournamentId);
    if (training) {
      await upsertTrainingMasterTeamName(name);
    } else {
      await upsertMasterTeamName(name);
    }
    return NextResponse.json(team);
  } catch (e) {
    console.error("[POST /api/teams]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 400 });
  }
}
