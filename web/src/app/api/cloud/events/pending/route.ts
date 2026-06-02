import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureCloudTables } from "@/lib/cloud-config-table";
import { getCloudConfig, isCloudConfigured } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/cloud/events/pending
 *
 * Lists every cloud-linked tournament whose local bytes have NOT been
 * confirmed on the cloud yet — i.e. the durable "needs sync" queue that
 * the renderer's sync coordinator drains on startup, on reconnect, and
 * on a backoff timer.
 *
 * A link is pending when either:
 *   - `pendingPushAt` is set (a push is queued / retrying / last failed), OR
 *   - `currentLocalSha` differs from `lastSyncedSha` (local edits made
 *     since the last successful push).
 *
 * After a successful push the push route clears `pendingPushAt` and sets
 * `lastSyncedSha === currentLocalSha`, so synced events drop out here.
 *
 * Response: {
 *   configured: boolean,
 *   pending: Array<{
 *     tournamentId, cloudEventId, name, lastError, pendingSince
 *   }>
 * }
 */
export async function GET() {
  const cfg = await getCloudConfig();
  if (!isCloudConfigured(cfg)) {
    return NextResponse.json({ configured: false, pending: [] });
  }

  await ensureCloudTables();
  const links = await prisma.cloudEventLink.findMany();
  const needsSync = links.filter(
    (l) =>
      l.pendingPushAt != null ||
      (l.currentLocalSha != null && l.currentLocalSha !== l.lastSyncedSha),
  );

  if (needsSync.length === 0) {
    return NextResponse.json({ configured: true, pending: [] });
  }

  // Join tournament display names so the coordinator can rebuild the
  // envelope with the right eventTitle and the UI can show what's queued.
  const tournaments = await prisma.tournament.findMany({
    where: { id: { in: needsSync.map((l) => l.tournamentId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(tournaments.map((t) => [t.id, t.name]));

  const pending = needsSync.map((l) => ({
    tournamentId: l.tournamentId,
    cloudEventId: l.cloudEventId,
    name: nameById.get(l.tournamentId) ?? "Untitled event",
    lastError: l.lastError ?? null,
    pendingSince: l.pendingPushAt ? l.pendingPushAt.toISOString() : null,
  }));

  return NextResponse.json({ configured: true, pending });
}
