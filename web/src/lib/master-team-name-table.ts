import { prisma } from "./prisma";

let ensured = false;

/**
 * Backfill master team name table for legacy SQLite user DBs that predate this model.
 */
export async function ensureMasterTeamNameTable(): Promise<void> {
  if (ensured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MasterTeamName" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "MasterTeamName_name_key"
    ON "MasterTeamName"("name");
  `);
  ensured = true;
}
