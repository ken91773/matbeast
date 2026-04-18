import { prisma } from "@/lib/prisma";

let ensured = false;

/**
 * Backfill CloudConfig + MasterCloudOutbox tables for legacy SQLite user
 * DBs that predate the cloud-sync feature.
 *
 * Same lazy-create pattern as ensureMasterPlayerProfileTable() — invoked
 * by every API route that reads or writes cloud sync state. Cheap after
 * the first call thanks to the `ensured` flag.
 */
export async function ensureCloudTables(): Promise<void> {
  if (ensured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CloudConfig" (
      "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
      "desktopToken" TEXT NOT NULL DEFAULT '',
      "cloudBaseUrl" TEXT NOT NULL DEFAULT 'https://matbeast-masters.vercel.app',
      "syncEnabled" INTEGER NOT NULL DEFAULT 1,
      "lastProfilesPullAt" DATETIME,
      "lastTeamNamesPullAt" DATETIME,
      "lastSyncError" TEXT,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MasterCloudOutbox" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "kind" TEXT NOT NULL,
      "payloadJson" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "lastAttemptAt" DATETIME
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "MasterCloudOutbox_createdAt_idx"
    ON "MasterCloudOutbox"("createdAt");
  `);
  // Cloud event link table — added in v0.7.0 -> v0.8.0 for per-tournament
  // cloud sync state. Note: cloudEventId UNIQUE so a given cloud event
  // is bound to at most one local tournament at a time.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CloudEventLink" (
      "tournamentId" TEXT NOT NULL PRIMARY KEY,
      "cloudEventId" TEXT NOT NULL UNIQUE,
      "baseVersion" INTEGER NOT NULL DEFAULT 0,
      "lastSyncedSha" TEXT,
      "currentLocalSha" TEXT,
      "lastSyncedBytes" INTEGER NOT NULL DEFAULT 0,
      "lastPulledAt" DATETIME,
      "lastPushedAt" DATETIME,
      "pendingPushAt" DATETIME,
      "lastError" TEXT,
      "localMirrorPath" TEXT
    );
  `);
  ensured = true;
}
