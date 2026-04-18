import { NextRequest, NextResponse } from "next/server";
import { getCloudEventLink, patchCloudEvent } from "@/lib/cloud-events";

export const dynamic = "force-dynamic";

/**
 * POST /api/cloud/events/rename
 *
 * Body: { tournamentId: string, name?: string, eventName?: string | null }
 *
 * Patches the cloud event linked to a given local tournament. The two
 * fields are independent so the dashboard can rename the filename and
 * the human event title separately:
 *   - `name`       → cloud filename (e.g. "0417-1", "regionals-2025")
 *   - `eventName`  → tournament display title ("My Regional 2026")
 *
 * At least one of `name` or `eventName` must be present. No-op
 * (returns `{ linked: false }`) when the tournament has no cloud
 * link yet — local-only events are renamed through the regular
 * /api/tournaments/[id] + /api/board PATCH calls alone.
 */
export async function POST(req: NextRequest) {
  let body: { tournamentId?: string; name?: string; eventName?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const tournamentId = body.tournamentId?.trim();
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const hasEventName = "eventName" in body;
  const rawEventName = body.eventName;
  if (!tournamentId) {
    return NextResponse.json(
      { error: "tournamentId required" },
      { status: 400 },
    );
  }
  if (!name && !hasEventName) {
    return NextResponse.json(
      { error: "name or eventName required" },
      { status: 400 },
    );
  }
  const link = await getCloudEventLink(tournamentId);
  if (!link) {
    return NextResponse.json({ ok: true, linked: false });
  }
  const patch: { name?: string; eventName?: string | null } = {};
  if (name) patch.name = name;
  if (hasEventName) {
    if (rawEventName == null) patch.eventName = null;
    else if (typeof rawEventName === "string") {
      const t = rawEventName.trim();
      patch.eventName = t.length > 0 ? t : null;
    }
  }
  const r = await patchCloudEvent(link.cloudEventId, patch);
  if (r.kind === "error") {
    const httpStatus = r.status === 409 ? 409 : 502;
    return NextResponse.json(
      {
        error: r.message,
        status: r.status,
        code: r.status === 409 ? "duplicate_filename" : undefined,
      },
      { status: httpStatus },
    );
  }
  return NextResponse.json({ ok: true, linked: true, event: r.event });
}
