import type { EventKind } from "@prisma/client";
import { prisma } from "./prisma";

/** One primary roster bucket per tournament (event file). Legacy DBs may still have PURPLE_BROWN rows. */
export async function ensurePrimaryEventForTournament(tournamentId: string) {
  await prisma.event.upsert({
    where: {
      tournamentId_kind: { tournamentId, kind: "BLUE_BELT" },
    },
    create: { tournamentId, kind: "BLUE_BELT" },
    update: {},
  });
}

/** @deprecated Use ensurePrimaryEventForTournament — keeps BLUE_BELT only for new installs */
export async function ensureEventsForTournament(tournamentId: string) {
  await ensurePrimaryEventForTournament(tournamentId);
}

export async function getPrimaryEventIdOrThrow(tournamentId: string): Promise<string> {
  let ev = await prisma.event.findUnique({
    where: { tournamentId_kind: { tournamentId, kind: "BLUE_BELT" } },
  });
  if (!ev) {
    ev = await prisma.event.findFirst({
      where: { tournamentId },
      orderBy: { createdAt: "asc" },
    });
  }
  if (!ev) {
    throw new Error("No event row for this tournament");
  }
  return ev.id;
}

export async function getEventIdOrThrow(
  tournamentId: string,
  kind: EventKind,
): Promise<string> {
  const ev = await prisma.event.findUnique({
    where: { tournamentId_kind: { tournamentId, kind } },
  });
  if (!ev) {
    throw new Error(`Event ${kind} not found for tournament`);
  }
  return ev.id;
}
