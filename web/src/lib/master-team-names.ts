import { prisma } from "./prisma";
import { ensureMasterTeamNameTable } from "./master-team-name-table";

export async function upsertMasterTeamName(
  rawName: string,
  opts?: { allowReservedTbd?: boolean },
): Promise<void> {
  const name = rawName.trim().toUpperCase();
  if (!name) return;
  if (name === "TBD" && !opts?.allowReservedTbd) return;
  await ensureMasterTeamNameTable();
  await prisma.masterTeamName.upsert({
    where: { name },
    create: { name },
    update: {},
  });
}
