import { NextResponse } from "next/server";
import { copyCloudEvent } from "@/lib/cloud-events";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/cloud/events/:id/copy
 *
 * Asks the masters service to duplicate the cloud event (metadata +
 * latest blob) server-side. Keeps the bytes on the cloud — the
 * desktop only sees the new CloudEvent metadata in the response.
 *
 * The new event's `eventName` is prepended with "Copy of " so the
 * homepage catalog list clearly distinguishes the copy from the
 * original.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id: cloudEventId } = await ctx.params;
  if (!cloudEventId) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const r = await copyCloudEvent(cloudEventId);
  if (r.kind === "error") {
    return NextResponse.json(
      { error: r.message, status: r.status },
      { status: r.status === 404 ? 404 : 502 },
    );
  }
  return NextResponse.json({ ok: true, event: r.event });
}
