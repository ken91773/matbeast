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

  const teamPlayers = await db.player.findMany({ where: { teamId } });
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
  for (const p of teamPlayers) {
    if (!seen.has(p.id)) {
      throw new Error("Every roster player must appear in slots");
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
}

export function slotsIdsFromPlayers(
  players: { id: string; lineupOrder: number }[],
): (string | null)[] {
  const row: (string | null)[] = Array(7).fill(null);
  for (const p of players) {
    if (p.lineupOrder >= 1 && p.lineupOrder <= 7) {
      row[p.lineupOrder - 1] = p.id;
    }
  }
  return row;
}
