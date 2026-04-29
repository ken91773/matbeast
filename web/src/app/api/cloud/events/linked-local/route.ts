import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/cloud/events/linked-local?cloudEventId=…
 *
 * Returns `{ tournamentId: string | null }` when this install already has a
 * local tournament linked to the given cloud catalog id (via CloudEventLink).
 * Used to focus an existing tab instead of importing a duplicate.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cloudEventId = url.searchParams.get("cloudEventId")?.trim();
    if (!cloudEventId) {
      return NextResponse.json(
        { error: "cloudEventId required" },
        { status: 400 },
      );
    }
    const row = await prisma.cloudEventLink.findUnique({
      where: { cloudEventId },
      select: { tournamentId: true },
    });
    return NextResponse.json({ tournamentId: row?.tournamentId ?? null });
  } catch (e) {
    console.error("[GET /api/cloud/events/linked-local]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "lookup failed" },
      { status: 500 },
    );
  }
}
