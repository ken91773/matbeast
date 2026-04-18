import { NextResponse } from "next/server";
import {
  getCloudEventMeta,
  pullCloudEventBlob,
  upsertCloudEventLink,
} from "@/lib/cloud-events";

export const dynamic = "force-dynamic";

/**
 * POST /api/cloud/events/pull
 *
 * Downloads a cloud event's current blob. Used by:
 *   - "Open from cloud" (tournamentId omitted; the renderer imports the
 *     envelope into a new local tournament, then calls /link to bind).
 *   - "Resolve conflict -> keep cloud" (tournamentId provided; updates
 *     the existing link's baseVersion + lastSyncedSha after the renderer
 *     re-imports).
 *
 * Body: { cloudEventId, tournamentId? }
 *
 * Returns `{ envelope: string (utf-8), version, sha256, sizeBytes, meta }`.
 */
export async function POST(req: Request) {
  let body: {
    cloudEventId?: string;
    tournamentId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const cloudEventId = body.cloudEventId?.trim();
  if (!cloudEventId) {
    return NextResponse.json(
      { error: "cloudEventId required" },
      { status: 400 },
    );
  }

  const meta = await getCloudEventMeta(cloudEventId).catch(() => null);
  if (!meta) {
    return NextResponse.json({ error: "event not found" }, { status: 404 });
  }

  const pulled = await pullCloudEventBlob(cloudEventId);
  if (pulled.kind !== "ok") {
    return NextResponse.json(
      { error: pulled.message, status: pulled.status },
      { status: 502 },
    );
  }

  if (body.tournamentId?.trim()) {
    await upsertCloudEventLink(body.tournamentId.trim(), {
      cloudEventId,
      baseVersion: pulled.version,
      lastSyncedSha: pulled.sha256,
      currentLocalSha: pulled.sha256,
      lastSyncedBytes: pulled.bytes.length,
      lastPulledAt: new Date(),
      pendingPushAt: null,
      lastError: null,
    });
  }

  return NextResponse.json({
    envelope: pulled.bytes.toString("utf8"),
    version: pulled.version,
    sha256: pulled.sha256,
    sizeBytes: pulled.bytes.length,
    meta,
  });
}
