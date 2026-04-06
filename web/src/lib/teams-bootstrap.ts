import { prisma } from "./prisma";

const MAX_TEAMS = 8;

/** Ensure exactly 8 team rows exist for this event (names default to TBD). */
export async function ensureEightTeamSlots(eventId: string) {
  for (;;) {
    const count = await prisma.team.count({ where: { eventId } });
    if (count >= MAX_TEAMS) break;
    await prisma.team.create({
      data: {
        eventId,
        name: "TBD",
        seedOrder: count + 1,
      },
    });
  }
}
