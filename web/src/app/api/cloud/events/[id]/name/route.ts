import { NextResponse } from "next/server";
import { patchCloudEvent } from "@/lib/cloud-events";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/cloud/events/:id/name
 *
 * Body: { name?: string; eventName?: string | null }
 *
 * Rename a cloud event directly by its cloud id (as opposed to via a
 * linked local tournament, which is what /api/cloud/events/rename
 * does). Used by the homepage catalog's in-place filename edit: the
 * homepage renders cloud rows that may or may not be linked locally,
 * so we can't route through /rename there.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  let body: { name?: string; eventName?: string | null } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const hasEventName = "eventName" in body;
  const patch: { name?: string; eventName?: string | null } = {};
  if (name && name.length > 0) patch.name = name;
  if (hasEventName) {
    if (body.eventName == null) patch.eventName = null;
    else if (typeof body.eventName === "string") {
      const t = body.eventName.trim();
      patch.eventName = t.length > 0 ? t : null;
    }
  }
  if (!patch.name && !("eventName" in patch)) {
    return NextResponse.json(
      { error: "name or eventName required" },
      { status: 400 },
    );
  }
  const r = await patchCloudEvent(id, patch);
  if (r.kind === "error") {
    const httpStatus =
      r.status === 404 ? 404 : r.status === 409 ? 409 : 502;
    return NextResponse.json(
      {
        error: r.message,
        status: r.status,
        code: r.status === 409 ? "duplicate_filename" : undefined,
      },
      { status: httpStatus },
    );
  }
  return NextResponse.json({ ok: true, event: r.event });
}
