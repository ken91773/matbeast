import { NextResponse } from "next/server";
import { listCloudEvents } from "@/lib/cloud-events";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/cloud/events
 *
 * Proxies the masters `/api/events` list, then merges **trainingMode**
 * from this install's `CloudEventLink` → `Tournament` rows whenever a
 * catalog entry is linked locally. That way the home page shows Training
 * from the actual event file / local DB even if cloud metadata is stale.
 *
 * Returns `{ events: [...] }` on success, `{ error }` on failure.
 */
export async function GET() {
  try {
    const events = await listCloudEvents();
    const trainingByCloudId = new Map<string, boolean>();
    try {
      const links = await prisma.cloudEventLink.findMany({
        select: { cloudEventId: true, tournamentId: true },
      });
      if (links.length > 0) {
        const tRows = await prisma.tournament.findMany({
          where: { id: { in: links.map((l) => l.tournamentId) } },
          select: { id: true, trainingMode: true },
        });
        const tidToTm = new Map(
          tRows.map((t) => [t.id, Boolean(t.trainingMode)]),
        );
        for (const l of links) {
          trainingByCloudId.set(
            l.cloudEventId,
            tidToTm.get(l.tournamentId) ?? false,
          );
        }
      }
    } catch {
      /* local DB unavailable — fall back to cloud flags only */
    }
    const merged = events.map((e) => {
      const localTm = trainingByCloudId.get(e.id);
      const trainingMode =
        localTm !== undefined ? localTm : Boolean(e.trainingMode);
      return { ...e, trainingMode };
    });
    return NextResponse.json({ events: merged });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 502 },
    );
  }
}
