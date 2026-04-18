import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/events/:id
 *
 * Metadata only — quick enough to poll for SYNCED/NOT SYNCED detection.
 * Compare `currentVersion` and `currentBlobSha` against the desktop's
 * `CloudEventLink.baseVersion` / `lastSyncedSha` to decide badge state.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  const ev = await prisma.cloudEvent.findFirst({
    where: { id, deletedAt: null },
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
  if (!ev) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ event: ev });
}

/**
 * PATCH /api/events/:id  body: { name?: string; eventName?: string | null; trainingMode?: boolean }
 *
 * Renames an event's filename (`name`) and/or human event title
 * (`eventName`). Does NOT upload a new blob (use PUT /blob for that).
 * Send `eventName: null` to explicitly clear it; omit the key to leave
 * it unchanged. At least one of `name` or `eventName` must be present.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const rawName = (body as { name?: unknown })?.name;
  const hasName = typeof rawName === "string" && rawName.trim().length > 0;
  const rawEventName = (body as { eventName?: unknown })?.eventName;
  const hasEventName = "eventName" in (body as Record<string, unknown>);
  const hasTrainingMode = "trainingMode" in (body as Record<string, unknown>);
  const rawTrainingMode = (body as { trainingMode?: unknown })?.trainingMode;
  if (!hasName && !hasEventName && !hasTrainingMode) {
    return NextResponse.json(
      { error: "name, eventName, or trainingMode required" },
      { status: 400 },
    );
  }

  const data: {
    name?: string;
    eventName?: string | null;
    trainingMode?: boolean;
    updatedByUserId: string;
    updatedByTokenId: string | null;
  } = {
    updatedByUserId: a.userId,
    updatedByTokenId: a.via === "token" ? (a.tokenId ?? null) : null,
  };
  if (hasName) data.name = (rawName as string).trim().slice(0, 200);

  /**
   * Reject filename collisions with other non-deleted events. We
   * exclude the current row so renaming an event to its existing
   * name is a no-op, and we include a soft-delete guard so a slot
   * that was freed via DELETE can be reused. See the POST route for
   * why this is application-level rather than a DB unique index.
   */
  if (data.name) {
    const collision = await prisma.cloudEvent.findFirst({
      where: {
        name: data.name,
        deletedAt: null,
        NOT: { id },
      },
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
  }

  if (hasEventName) {
    if (rawEventName == null) data.eventName = null;
    else if (typeof rawEventName === "string") {
      const trimmed = rawEventName.trim();
      data.eventName = trimmed.length > 0 ? trimmed.slice(0, 200) : null;
    } else {
      return NextResponse.json(
        { error: "eventName must be string or null" },
        { status: 400 },
      );
    }
  }

  if (hasTrainingMode) {
    if (typeof rawTrainingMode !== "boolean") {
      return NextResponse.json(
        { error: "trainingMode must be boolean" },
        { status: 400 },
      );
    }
    data.trainingMode = rawTrainingMode;
  }

  try {
    const ev = await prisma.cloudEvent.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        eventName: true,
        trainingMode: true,
        currentVersion: true,
        currentBlobSha: true,
        sizeBytes: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ event: ev });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Record to update not found")) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/events/:id
 *
 * Soft-delete. The row and its blobs stay in the DB; GET routes filter
 * by `deletedAt IS NULL`. Useful for undo / audit, and keeps foreign
 * keys simple.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const a = await requireUserId();
  if ("response" in a) return a.response;

  const { id } = await ctx.params;
  try {
    await prisma.cloudEvent.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedByUserId: a.userId,
        updatedByTokenId: a.via === "token" ? a.tokenId : null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg.includes("Record to update not found")) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
