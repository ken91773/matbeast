import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * All `currentRosterFileName` values across open tournaments — used by
 * "Restore copy from disk" in demo/local-only mode to pick a non-colliding
 * `<stem>(recovered)` name without calling the cloud catalog API.
 */
export async function GET() {
  try {
    const rows = await prisma.liveScoreboardState.findMany({
      select: { currentRosterFileName: true },
    });
    const names = rows
      .map((r) => (r.currentRosterFileName ?? "").trim())
      .filter(Boolean);
    return NextResponse.json({ names });
  } catch (e) {
    console.error("[GET /api/tournaments/roster-filenames]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "List failed" },
      { status: 500 },
    );
  }
}
