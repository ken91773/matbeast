import { prisma } from "./prisma";
import { ensureEventsForTournament } from "./events";

const DEFAULT_NAME = "Main tournament";

/** One default tournament + both event rows (blue belt & purple/brown rosters) */
export async function ensureDefaultTournament() {
  const existing = await prisma.tournament.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    await ensureEventsForTournament(existing.id);
    return existing;
  }

  const t = await prisma.tournament.create({
    data: {
      name: DEFAULT_NAME,
      maxTeams: 8,
    },
  });
  await ensureEventsForTournament(t.id);
  return t;
}
