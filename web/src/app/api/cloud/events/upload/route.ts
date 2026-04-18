import { NextResponse } from "next/server";
import {
  createCloudEvent,
  sha256Hex,
  upsertCloudEventLink,
} from "@/lib/cloud-events";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/cloud/events/upload
 *
 * Creates a brand-new cloud event from the local tournament's current
 * envelope text and binds the two via CloudEventLink.
 *
 * Distinct from /push: /push assumes the cloud event already exists
 * and updates it; /upload creates. Called by "File -> Upload to cloud".
 *
 * Body: { tournamentId, envelope, name }
 */
export async function POST(req: Request) {
  let body: {
    tournamentId?: string;
    envelope?: string;
    name?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const tournamentId = body.tournamentId?.trim();
  const envelope = body.envelope;
  const name = body.name?.trim();
  if (!tournamentId || typeof envelope !== "string" || !name) {
    return NextResponse.json(
      { error: "tournamentId, envelope, name required" },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(envelope, "utf8");
  // Pair the filename with the tournament's display title so the
  // homepage catalog can render a "<filename> / <event name>" row
  // without re-downloading the envelope. Best-effort: missing or
  // stale tournament is treated as "no eventName".
  let eventName: string | null = null;
  try {
    const t = await prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { name: true },
    });
    eventName = t?.name?.trim() || null;
  } catch {
    eventName = null;
  }
  const result = await createCloudEvent(name, bytes, { eventName });
  if (result.kind !== "ok") {
    // eslint-disable-next-line no-console
    console.warn(
      "[cloud-upload] create event failed",
      JSON.stringify({
        tournamentId,
        name,
        status: result.status,
        message: result.message,
        conflictingId: result.conflictingId ?? null,
      }),
    );
    // Preserve 409 (duplicate filename) from the masters service so
    // the renderer can distinguish it from generic upstream errors
    // and show a specific "that filename is taken" message.
    // IMPORTANT: hoist `conflictingId` to the top-level JSON so the
    // auto-link adopt path can read it directly instead of having to
    // parse the nested masters body out of `error`.
    const httpStatus = result.status === 409 ? 409 : 502;
    return NextResponse.json(
      {
        error: result.message,
        status: result.status,
        code: result.status === 409 ? "duplicate_filename" : undefined,
        conflictingId:
          result.status === 409 ? (result.conflictingId ?? null) : undefined,
      },
      { status: httpStatus },
    );
  }

  const sha = sha256Hex(bytes);
  await upsertCloudEventLink(tournamentId, {
    cloudEventId: result.event.id,
    baseVersion: result.event.currentVersion,
    lastSyncedSha: sha,
    currentLocalSha: sha,
    lastSyncedBytes: bytes.length,
    lastPushedAt: new Date(),
    pendingPushAt: null,
    lastError: null,
  });

  return NextResponse.json({ event: result.event });
}
