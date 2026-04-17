import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type TeamLineupDb = Prisma.TransactionClient | typeof prisma;

/**
 * Persist a 7-slot lineup for one team. Each roster player must appear exactly
 * once in `slots` (nulls allowed for open slots).
 */
export async function applyTeamSlots(
  db: TeamLineupDb,
  teamId: string,
  slots: (string | null)[],
): Promise<void> {
  if (!Array.isArray(slots) || slots.length !== 7) {
    throw new Error("slots must be an array of length 7");
  }

  const teamPlayers = await db.player.findMany({
    where: { teamId },
    orderBy: [{ lineupOrder: "asc" }, { createdAt: "asc" }],
  });
  const idSet = new Set(teamPlayers.map((p) => p.id));
  const seen = new Set<string>();
  for (const s of slots) {
    if (s !== null && s !== undefined) {
      if (typeof s !== "string" || !idSet.has(s)) {
        throw new Error("Invalid player id in slots");
      }
      if (seen.has(s)) {
        throw new Error("Duplicate player in slots");
      }
      seen.add(s);
    }
  }
  for (let i = 0; i < teamPlayers.length; i++) {
    await db.player.update({
      where: { id: teamPlayers[i].id },
      data: { lineupOrder: 50 + i },
    });
  }
  for (let i = 0; i < 7; i++) {
    const pid = slots[i];
    if (pid) {
      await db.player.update({
        where: { id: pid },
        data: { lineupOrder: i + 1 },
      });
    }
  }
  let overflowLineupOrder = 8;
  for (const p of teamPlayers) {
    if (!seen.has(p.id)) {
      await db.player.update({
        where: { id: p.id },
        data: { lineupOrder: overflowLineupOrder++ },
      });
    }
  }
}

export function slotsIdsFromPlayers(
  players: { id: string; lineupOrder: number | null }[],
): (string | null)[] {
  const row: (string | null)[] = Array(7).fill(null);
  for (const p of players) {
    if (typeof p.lineupOrder === "number" && p.lineupOrder >= 1 && p.lineupOrder <= 7) {
      row[p.lineupOrder - 1] = p.id;
    }
  }
  return row;
}

/**
 * Ensure team lineup order is contiguous and always numbered: 1..N.
 */
export async function normalizeTeamLineup(db: TeamLineupDb, teamId: string): Promise<void> {
  const players = await db.player.findMany({
    where: { teamId },
    orderBy: [{ lineupOrder: "asc" }, { createdAt: "asc" }],
  });
  for (let i = 0; i < players.length; i++) {
    await db.player.update({
      where: { id: players[i].id },
      data: { lineupOrder: 100 + i },
    });
  }
  for (let i = 0; i < players.length; i++) {
    await db.player.update({
      where: { id: players[i].id },
      data: { lineupOrder: i + 1 },
    });
  }
}

/**
 * Insert/move one player into a numbered lineup slot (1..7), pushing subsequent
 * players down while preserving sequential lineupOrder for all team players.
 */
export async function insertPlayerIntoTeamLineup(
  db: TeamLineupDb,
  teamId: string,
  playerId: string,
  toLineupOrder: number,
): Promise<void> {
  if (!Number.isInteger(toLineupOrder) || toLineupOrder < 1) {
    throw new Error("lineup slot must be >= 1");
  }
  const players = await db.player.findMany({
    where: { teamId },
    orderBy: [{ lineupOrder: "asc" }, { createdAt: "asc" }],
  });
  const existing = players.find((p) => p.id === playerId);
  if (!existing) throw new Error("Player not found on team");

  const ordered = players
    .slice()
    .sort((a, b) => {
      const aRank =
        typeof a.lineupOrder === "number" && a.lineupOrder >= 1
          ? a.lineupOrder
          : 1000;
      const bRank =
        typeof b.lineupOrder === "number" && b.lineupOrder >= 1
          ? b.lineupOrder
          : 1000;
      return aRank - bRank || a.createdAt.getTime() - b.createdAt.getTime();
    })
    .filter((p) => p.id !== playerId);
  const boundedInsertIndex = Math.max(0, Math.min(toLineupOrder - 1, ordered.length));
  ordered.splice(boundedInsertIndex, 0, existing);

  for (let i = 0; i < ordered.length; i++) {
    await db.player.update({
      where: { id: ordered[i].id },
      data: { lineupOrder: 200 + i },
    });
  }
  for (let i = 0; i < ordered.length; i++) {
    await db.player.update({
      where: { id: ordered[i].id },
      data: { lineupOrder: i + 1 },
    });
  }
}
