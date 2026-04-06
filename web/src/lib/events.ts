import type { EventKind } from "@prisma/client";
import { prisma } from "./prisma";

const KINDS: EventKind[] = ["BLUE_BELT", "PURPLE_BROWN"];

export async function ensureEventsForTournament(tournamentId: string) {
  for (const kind of KINDS) {
    await prisma.event.upsert({
      where: {
        tournamentId_kind: { tournamentId, kind },
      },
      create: { tournamentId, kind },
      update: {},
    });
  }
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
