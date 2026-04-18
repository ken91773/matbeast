import { prisma } from "@/lib/prisma";

const HEADER = "x-matbeast-tournament-id";

/**
 * When the active tournament (header) is a training-mode event, master list
 * APIs use TrainingMaster* tables instead of live Master* (cloud-synced).
 */
export async function resolveUseTrainingMasters(req: Request): Promise<boolean> {
  const raw = req.headers.get(HEADER)?.trim();
  if (!raw) return false;
  const t = await prisma.tournament.findUnique({
    where: { id: raw },
    select: { trainingMode: true },
  });
  return Boolean(t?.trainingMode);
}

export async function tournamentUsesTrainingMasters(
  tournamentId: string,
): Promise<boolean> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { trainingMode: true },
  });
  return Boolean(t?.trainingMode);
}
