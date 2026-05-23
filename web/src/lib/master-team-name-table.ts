import { prisma } from "./prisma";

let ensured = false;

async function readColumns(tableName: string): Promise<Set<string>> {
  const rows = (await prisma.$queryRawUnsafe(
    `PRAGMA table_info("${tableName}")`,
  )) as Array<{ name?: unknown }>;
  const cols = new Set<string>();
  for (const row of rows) {
    if (typeof row?.name === "string") cols.add(row.name);
  }
  return cols;
}

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
  const cols = await readColumns("MasterTeamName");
  if (!cols.has("cloudId")) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "MasterTeamName" ADD COLUMN "cloudId" TEXT;
    `);
  }
  ensured = true;
}
