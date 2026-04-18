import { NextResponse } from "next/server";
import { deleteCloudEvent } from "@/lib/cloud-events";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/cloud/events/:id
 *
 * Soft-deletes the cloud event on the masters service AND drops any
 * local `CloudEventLink` pointing at it so the desktop never tries to
 * push/pull against a tombstoned row again. Local tournament bytes
 * are untouched — the user can still work offline from the local
 * .matb they already have.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id: cloudEventId } = await ctx.params;
  if (!cloudEventId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const r = await deleteCloudEvent(cloudEventId);
  if (r.kind === "error") {
    return NextResponse.json(
      { error: r.message, status: r.status },
      { status: r.status === 404 ? 404 : 502 },
    );
  }
  // Drop any links that referenced this cloud row. deleteMany is a no-op
  // if nothing was linked on this install.
  try {
    await prisma.cloudEventLink.deleteMany({ where: { cloudEventId } });
  } catch {
    /* link table may not exist yet on fresh DBs; ignore. */
  }
  return NextResponse.json({ ok: true });
}
