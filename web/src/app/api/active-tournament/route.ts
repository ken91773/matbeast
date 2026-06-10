import { NextResponse } from "next/server";
import {
  getActiveOverlayTournamentId,
  setActiveOverlayTournamentId,
} from "@/lib/active-overlay-tournament-store";

export const dynamic = "force-dynamic";

/**
 * GET  → `{ tournamentId }` — the event the operator is currently driving,
 *        used by a constant (id-less) overlay URL to follow the live event.
 * POST → `{ tournamentId }` — published by the dashboard whenever the focused
 *        event tab changes.
 */
export async function GET() {
  return NextResponse.json(
    { tournamentId: getActiveOverlayTournamentId() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { tournamentId?: string | null };
    setActiveOverlayTournamentId(
      typeof body?.tournamentId === "string" ? body.tournamentId : null,
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
