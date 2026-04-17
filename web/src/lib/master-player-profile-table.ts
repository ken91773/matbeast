import { prisma } from "@/lib/prisma";

let ensured = false;

/**
 * Backfill master profile table for legacy SQLite user DBs that predate this model.
 */
export async function ensureMasterPlayerProfileTable(): Promise<void> {
  if (ensured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MasterPlayerProfile" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "firstName" TEXT NOT NULL,
      "lastName" TEXT NOT NULL,
      "nickname" TEXT,
      "academyName" TEXT,
      "unofficialWeight" REAL,
      "heightFeet" INTEGER,
      "heightInches" INTEGER,
      "age" INTEGER,
      "beltRank" TEXT NOT NULL DEFAULT 'WHITE',
      "profilePhotoUrl" TEXT,
      "headShotUrl" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "MasterPlayerProfile_firstName_lastName_key"
    ON "MasterPlayerProfile"("firstName","lastName");
  `);
  ensured = true;
}
