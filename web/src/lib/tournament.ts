import { prisma } from "./prisma";
import {
  ensurePrimaryEventForTournament,
  getPrimaryEventIdOrThrow,
} from "./events";
import { ensureEightTeamSlots } from "./teams-bootstrap";
import { ensureLiveScoreboardState } from "./board";
import { Prisma } from "@prisma/client";

const DEFAULT_NAME = "Untitled event";

/** First tournament by creation time, or create one with primary event + teams + scoreboard row */
export async function ensureDefaultTournament() {
  const existing = await prisma.tournament.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    await ensurePrimaryEventForTournament(existing.id);
    const eventId = await getPrimaryEventIdOrThrow(existing.id);
    await ensureEightTeamSlots(eventId);
    await ensureLiveScoreboardState(existing.id);
    return existing;
  }

  const t = await prisma.tournament.create({
    data: {
      name: DEFAULT_NAME,
      maxTeams: 8,
    },
  });
  await ensurePrimaryEventForTournament(t.id);
  const eventId = await getPrimaryEventIdOrThrow(t.id);
  await ensureEightTeamSlots(eventId);
  await ensureLiveScoreboardState(t.id);
  return t;
}

export async function createTournamentWithName(name: string) {
  const trimmed = name.trim() || DEFAULT_NAME;
  const t = await prisma.tournament.create({
    data: { name: trimmed, maxTeams: 8 },
  });
  await ensurePrimaryEventForTournament(t.id);
  const eventId = await getPrimaryEventIdOrThrow(t.id);
  await ensureEightTeamSlots(eventId);
  await ensureLiveScoreboardState(t.id);
  try {
    await prisma.liveScoreboardState.update({
      where: { tournamentId: t.id },
      data: { currentRosterFileName: "UNTITLED" },
    });
  } catch (error) {
    // Legacy schema edge case; avoid breaking New Event flow.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
  }
  return t;
}

export async function listTournaments() {
  return prisma.tournament.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, updatedAt: true, createdAt: true },
  });
}

export async function duplicateTournament(sourceId: string, newName: string) {
  const trimmed = newName.trim() || "Copy";
  const src = await prisma.tournament.findUnique({
    where: { id: sourceId },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
        include: {
          teams: { include: { players: true }, orderBy: { seedOrder: "asc" } },
        },
      },
    },
  });
  if (!src) {
    throw new Error("Tournament not found");
  }
  const primary =
    src.events.find((e) => e.kind === "BLUE_BELT") ?? src.events[0];
  if (!primary) {
    throw new Error("Tournament has no event data to copy");
  }

  return prisma.$transaction(async (tx) => {
    const t = await tx.tournament.create({
      data: { name: trimmed, maxTeams: src.maxTeams, eliminationMode: src.eliminationMode },
    });
    const ev = await tx.event.create({
      data: { tournamentId: t.id, kind: primary.kind },
    });
    for (const team of primary.teams) {
      const newTeam = await tx.team.create({
        data: {
          eventId: ev.id,
          name: team.name,
          seedOrder: team.seedOrder,
        },
      });
      for (const p of team.players) {
        await tx.player.create({
          data: {
            teamId: newTeam.id,
            firstName: p.firstName,
            lastName: p.lastName,
            nickname: p.nickname,
            academyName: p.academyName,
            unofficialWeight: p.unofficialWeight,
            officialWeight: p.officialWeight,
            heightFeet: p.heightFeet,
            heightInches: p.heightInches,
            age: p.age,
            beltRank: p.beltRank,
            profilePhotoUrl: p.profilePhotoUrl,
            headShotUrl: p.headShotUrl,
            lineupOrder: p.lineupOrder,
            lineupConfirmed: p.lineupConfirmed,
            weighedConfirmed: p.weighedConfirmed,
          },
        });
      }
    }
    await tx.liveScoreboardState.create({
      data: {
        tournamentId: t.id,
        currentRosterFileName: trimmed,
        roundLabel: "Quarter Finals",
      },
    });
    return t;
  });
}
