import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/events/:id/copy
 *
 * Body (optional): { name?: string; eventName?: string | null }
 *
 * Server-side duplication of a cloud event: clones the source row's
 * latest blob into a brand-new CloudEvent at version 1. No bytes
 * travel back to the desktop, which keeps "Copy" cheap even for
 * multi-MB events.
 *
 * Defaults when name / eventName aren't provided:
 *   - name      -> "Copy of <source.name>"
 *   - eventName -> "Copy of <source.eventName ?? source.name>"
 *
 * (Per product spec, the "Copy of " prefix goes on the *event name*
 * rather than the filename, but we also prefix the filename so both
 * the homepage label and the filename column are obviously distinct
 * from the original in the catalog list.)
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;

  let body: { name?: unknown; eventName?: unknown } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = (await req.json()) as typeof body;
    }
  } catch {
    // Allow empty body.
  }

  const src = await prisma.cloudEvent.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      eventName: true,
      currentVersion: true,
      currentBlobSha: true,
      sizeBytes: true,
    },
  });
  if (!src) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Pull the latest blob bytes.
  const latestBlob = await prisma.cloudEventBlob.findUnique({
    where: { eventId_version: { eventId: id, version: src.currentVersion } },
    select: { blob: true, sha256: true, sizeBytes: true },
  });
  if (!latestBlob) {
    return NextResponse.json(
      { error: "source blob missing" },
      { status: 500 },
    );
  }

  const incomingName = typeof body.name === "string" ? body.name.trim() : "";
  const incomingEventName =
    typeof body.eventName === "string" ? body.eventName.trim() : "";
  const baseName =
    incomingName.length > 0 ? incomingName : `Copy of ${src.name}`;
  const eventNameBase =
    src.eventName && src.eventName.length > 0 ? src.eventName : src.name;
  const effectiveEventName =
    incomingEventName.length > 0 ? incomingEventName : `Copy of ${eventNameBase}`;

  /**
   * Pick a free filename for the copy. Pressing "Copy" twice on the
   * same source would otherwise produce two events named
   * "Copy of X" — the homepage would still show them as distinct
   * rows (they have different cloud ids) but the shared filename is
   * confusing and now rejected by POST/PATCH anyway. Append `(2)`,
   * `(3)`, … until we find a slot not taken by any other non-
   * deleted event.
   */
  async function pickFreeName(candidate: string): Promise<string> {
    const trimmed = candidate.slice(0, 200);
    const existing = await prisma.cloudEvent.findFirst({
      where: { name: trimmed, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return trimmed;
    for (let i = 2; i < 1000; i += 1) {
      const suffix = ` (${i})`;
      const next = `${trimmed.slice(0, 200 - suffix.length)}${suffix}`;
      const clash = await prisma.cloudEvent.findFirst({
        where: { name: next, deletedAt: null },
        select: { id: true },
      });
      if (!clash) return next;
    }
    // Fall back to a timestamped suffix so the create never fails.
    return `${trimmed.slice(0, 180)} (${Date.now()})`.slice(0, 200);
  }
  const effectiveName = await pickFreeName(baseName);

  const created = await prisma.$transaction(async (tx) => {
    const ev = await tx.cloudEvent.create({
      data: {
        name: effectiveName.slice(0, 200),
        eventName: effectiveEventName.slice(0, 200),
        ownerUserId: a.userId,
        currentVersion: 1,
        currentBlobSha: latestBlob.sha256,
        sizeBytes: latestBlob.sizeBytes,
        createdByUserId: a.userId,
        updatedByUserId: a.userId,
        updatedByTokenId: a.via === "token" ? a.tokenId : null,
      },
    });
    await tx.cloudEventBlob.create({
      data: {
        eventId: ev.id,
        version: 1,
        blob: latestBlob.blob,
        sha256: latestBlob.sha256,
        sizeBytes: latestBlob.sizeBytes,
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
