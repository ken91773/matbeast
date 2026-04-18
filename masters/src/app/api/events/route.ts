import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/events
 *
 * Lists all non-deleted cloud events visible to the signed-in user.
 * With our 5-user/shared-workspace model, every signed-in user sees
 * every event; tighten later if we add per-event ACLs.
 *
 * Only metadata is returned here — never blobs. The desktop then
 * calls GET /api/events/:id/blob on demand.
 */
export async function GET() {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const events = await prisma.cloudEvent.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      eventName: true,
      trainingMode: true,
      ownerUserId: true,
      currentVersion: true,
      currentBlobSha: true,
      sizeBytes: true,
      createdAt: true,
      updatedAt: true,
      createdByUserId: true,
      updatedByUserId: true,
    },
  });
  return NextResponse.json({ events });
}

/**
 * POST /api/events
 *
 * Creates a new cloud event with an initial blob (version 1).
 *
 * Wire format:
 *   Content-Type: application/octet-stream
 *   Query:        ?name=<display name>
 *   Body:         raw .matb JSON bytes
 *
 * Returns the new event's metadata. The desktop then stores the id in
 * its CloudEventLink row so future saves know where to PUT.
 */
export async function POST(req: NextRequest) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const name = req.nextUrl.searchParams.get("name")?.trim() || "Untitled event";
  // Optional display title for the tournament inside the envelope.
  // Safe to leave null; the catalog UI falls back to `name`.
  const rawEventName = req.nextUrl.searchParams.get("eventName");
  const eventName =
    rawEventName && rawEventName.trim().length > 0
      ? rawEventName.trim().slice(0, 200)
      : null;

  const rawTm = req.nextUrl.searchParams.get("trainingMode");
  const trainingMode =
    rawTm === "1" || rawTm?.toLowerCase() === "true";

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }

  /**
   * Enforce unique filenames across non-deleted events. The Postgres
   * schema intentionally does NOT have a unique constraint on `name`
   * because soft-deletes would block legitimate reuse of a freed
   * slot, and adding a partial unique index would need a migration
   * against live data that may already hold duplicates. Application-
   * level checks are good enough for our small user base and give
   * us a clean 409 response the client can display.
   */
  const collision = await prisma.cloudEvent.findFirst({
    where: { name, deletedAt: null },
    select: { id: true, eventName: true, name: true },
  });
  if (collision) {
    return NextResponse.json(
      {
        error: "duplicate filename",
        code: "duplicate_filename",
        conflictingId: collision.id,
      },
      { status: 409 },
    );
  }

  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(bytes).digest("hex");

  const created = await prisma.$transaction(async (tx) => {
    const ev = await tx.cloudEvent.create({
      data: {
        name,
        eventName,
        trainingMode,
        ownerUserId: a.userId,
        currentVersion: 1,
        currentBlobSha: sha,
        sizeBytes: bytes.length,
        createdByUserId: a.userId,
        updatedByUserId: a.userId,
        updatedByTokenId: a.via === "token" ? a.tokenId : null,
      },
    });
    await tx.cloudEventBlob.create({
      data: {
        eventId: ev.id,
        version: 1,
        blob: bytes,
        sha256: sha,
        sizeBytes: bytes.length,
        createdByUserId: a.userId,
        createdByTokenId: a.via === "token" ? a.tokenId : null,
      },
    });
    return ev;
  });

  return NextResponse.json(
    {
      event: {
        id: created.id,
        name: created.name,
        eventName: created.eventName,
        trainingMode: created.trainingMode,
        currentVersion: created.currentVersion,
        currentBlobSha: created.currentBlobSha,
        sizeBytes: created.sizeBytes,
        ownerUserId: created.ownerUserId,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    },
    { status: 201 },
  );
}
