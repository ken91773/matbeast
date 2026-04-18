import { NextRequest, NextResponse } from "next/server";
import { deleteCloudEventLink } from "@/lib/cloud-events";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/cloud/events/link?tournamentId=X
 *
 * Removes the local CloudEventLink for the given tournament without
 * touching the cloud event itself. The local tournament reverts to
 * LOCAL ONLY status. Use cases:
 *   - Converting a cloud event into a local-only one.
 *   - Abandoning a conflicted cloud event (pair with "Save as local
 *     copy" in the conflict prompt).
 */
export async function DELETE(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get("tournamentId")?.trim();
  if (!tournamentId) {
    return NextResponse.json(
      { error: "tournamentId required" },
      { status: 400 },
    );
  }
  await deleteCloudEventLink(tournamentId);
  return NextResponse.json({ ok: true });
}
