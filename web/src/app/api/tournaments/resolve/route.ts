import { NextResponse } from "next/server";
import { ensureDefaultTournament } from "@/lib/tournament";

/** Bootstrap: returns default tournament id for clients with empty localStorage */
export async function GET() {
  try {
    const t = await ensureDefaultTournament();
    return NextResponse.json({ id: t.id, name: t.name });
  } catch (e) {
    console.error("[GET /api/tournaments/resolve]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Resolve failed" },
      { status: 500 },
    );
  }
}
