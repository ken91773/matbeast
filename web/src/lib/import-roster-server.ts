import type { EventKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureEightTeamSlots } from "@/lib/teams-bootstrap";
import type { RosterFileDocument } from "@/lib/roster-file-types";

function validateImportDocument(doc: RosterFileDocument) {
  for (const team of doc.teams) {
    if (team.seedOrder < 1 || team.seedOrder > 8) {
      throw new Error("Team seeds must be between 1 and 8");
    }
    const seenSlots = new Set<number>();
    for (const player of team.players) {
      if (!player.firstName.trim() || !player.lastName.trim()) {
        throw new Error(`Seed ${team.seedOrder} has player missing names`);
      }
      if (seenSlots.has(player.lineupOrder)) {
        throw new Error(`Seed ${team.seedOrder} has duplicate lineup slots`);
      }
      seenSlots.add(player.lineupOrder);
    }
    if (team.players.length > 7) {
      throw new Error(`Seed ${team.seedOrder} has more than 7 players`);
    }
  }
}

/** Apply roster JSON to tournament’s primary event (replaces players, updates team names, syncs event kind). */
export async function importRosterDocumentForTournament(
  tournamentId: string,
  document: RosterFileDocument,
  bracket?: {
    version: 1;
    matches: Array<{
      round: "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL";
      bracketIndex: number;
      homeSeedOrder: number;
      awaySeedOrder: number;
      winnerSeedOrder: number | null;
    }>;
  },
) {
  validateImportDocument(document);

  const targetKind = document.eventKind as EventKind;
  let ev = await prisma.event.findFirst({
    where: { tournamentId },
    orderBy: { createdAt: "asc" },
  });
  if (!ev) {
    throw new Error("No event row for this tournament");
  }
  if (ev.kind !== targetKind) {
    await prisma.event.update({
      where: { id: ev.id },
      data: { kind: targetKind },
    });
    ev = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  }

  await ensureEightTeamSlots(ev.id);
  const teams = await prisma.team.findMany({
    where: { eventId: ev.id },
    orderBy: { seedOrder: "asc" },
  });
  const bySeed = new Map(teams.map((t) => [t.seedOrder, t]));

  await prisma.$transaction(async (tx) => {
    for (const t of teams) {
      await tx.player.deleteMany({ where: { teamId: t.id } });
    }
    for (const docTeam of document.teams) {
      const team = bySeed.get(docTeam.seedOrder);
      if (!team) continue;
      await tx.team.update({
        where: { id: team.id },
        data: {
          name: docTeam.name,
          // Only touch overlayColor when the file explicitly declared it
          // (parser preserves `undefined` for pre-color save files so we
          // don't wipe colors that already exist in the DB).
          ...(Object.prototype.hasOwnProperty.call(docTeam, "overlayColor")
            ? { overlayColor: docTeam.overlayColor ?? null }
            : {}),
        },
      });
      for (const p of docTeam.players) {
        await tx.player.create({
          data: {
            teamId: team.id,
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
  });

  if (bracket?.version === 1) {
    const teamsNow = await prisma.team.findMany({
      where: { eventId: ev.id },
      select: { id: true, seedOrder: true },
    });
    const bySeed = new Map(teamsNow.map((t) => [t.seedOrder, t.id]));
    await prisma.$transaction(async (tx) => {
      await tx.bracketMatch.deleteMany({ where: { eventId: ev.id } });
      const rows = [...bracket.matches]
        .filter(
          (m) =>
            m.round === "QUARTER_FINAL" ||
            m.round === "SEMI_FINAL" ||
            m.round === "GRAND_FINAL",
        )
        .sort((a, b) => {
          const rank = (r: string) =>
            r === "QUARTER_FINAL" ? 0 : r === "SEMI_FINAL" ? 1 : 2;
          const rr = rank(a.round) - rank(b.round);
          return rr !== 0 ? rr : a.bracketIndex - b.bracketIndex;
        });
      for (const m of rows) {
        const homeTeamId = bySeed.get(m.homeSeedOrder);
        const awayTeamId = bySeed.get(m.awaySeedOrder);
        if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) continue;
        const winnerTeamId =
          m.winnerSeedOrder === null ? null : bySeed.get(m.winnerSeedOrder) ?? null;
        const safeWinnerId =
          winnerTeamId === homeTeamId || winnerTeamId === awayTeamId
            ? winnerTeamId
            : null;
        await tx.bracketMatch.create({
          data: {
            eventId: ev.id,
            round: m.round,
            bracketIndex: m.bracketIndex,
            homeTeamId,
            awayTeamId,
            winnerTeamId: safeWinnerId,
          },
        });
      }
    });
  }
}
