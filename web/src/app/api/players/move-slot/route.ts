import type { EventKind } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import { getEventIdOrThrow, getPrimaryEventIdOrThrow } from "@/lib/events";
import { prisma } from "@/lib/prisma";
import { applyTeamSlots, slotsIdsFromPlayers } from "@/lib/team-lineup";
import { ensureDefaultTournament } from "@/lib/tournament";

/**
 * POST { tournamentId?, eventKind?, playerId, fromTeamId, fromSlot, toTeamId, toSlot }
 * Slots are 0–6 (maps to lineup 1–7).
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    eventKind?: EventKind;
    tournamentId?: string;
    playerId?: string;
    fromTeamId?: string;
    fromSlot?: number;
    toTeamId?: string;
    toSlot?: number;
  };

  const {
    playerId,
    fromTeamId,
    toTeamId,
    fromSlot,
    toSlot,
  } = body;
  if (
    typeof playerId !== "string" ||
    typeof fromTeamId !== "string" ||
    typeof toTeamId !== "string" ||
    typeof fromSlot !== "number" ||
    typeof toSlot !== "number"
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (
    fromSlot < 0 ||
    fromSlot > 6 ||
    toSlot < 0 ||
    toSlot > 6 ||
    !Number.isInteger(fromSlot) ||
    !Number.isInteger(toSlot)
  ) {
    return NextResponse.json({ error: "Slots must be 0–6" }, { status: 400 });
  }

  let eventId: string;
  if (body.eventKind === "BLUE_BELT" || body.eventKind === "PURPLE_BROWN") {
    const tournament = await ensureDefaultTournament();
    eventId = await getEventIdOrThrow(tournament.id, body.eventKind);
  } else {
    const tid =
      typeof body.tournamentId === "string" && body.tournamentId.trim()
        ? body.tournamentId.trim()
        : await resolveTournamentIdFromRequest(req);
    eventId = await getPrimaryEventIdOrThrow(tid);
  }

  const [teamFrom, teamTo] = await Promise.all([
    prisma.team.findFirst({
      where: { id: fromTeamId, eventId },
      include: { players: true },
    }),
    prisma.team.findFirst({
      where: { id: toTeamId, eventId },
      include: { players: true },
    }),
  ]);
  if (!teamFrom || !teamTo) {
    return NextResponse.json(
      { error: "Team not found in this event" },
      { status: 400 },
    );
  }

  const rowFrom = slotsIdsFromPlayers(teamFrom.players);
  const rowTo = slotsIdsFromPlayers(teamTo.players);

  if (rowFrom[fromSlot] !== playerId) {
    return NextResponse.json(
      { error: "Player is not in that source slot" },
      { status: 400 },
    );
  }

  if (fromTeamId === toTeamId) {
    if (fromSlot === toSlot) {
      return NextResponse.json({ ok: true });
    }
    const row = [...rowFrom];
    const a = row[fromSlot];
    const b = row[toSlot];
    row[fromSlot] = b;
    row[toSlot] = a;
    try {
      await prisma.$transaction(async (tx) => {
        await applyTeamSlots(tx, fromTeamId, row);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lineup update failed";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  const P = playerId;
  const Q = rowTo[toSlot];

  const newFrom = [...rowFrom];
  const newTo = [...rowTo];

  newFrom[fromSlot] = Q ?? null;
  newTo[toSlot] = P;

  try {
    await prisma.$transaction(async (tx) => {
      await applyTeamSlots(tx, fromTeamId, newFrom);
      await applyTeamSlots(tx, toTeamId, newTo);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Lineup update failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
