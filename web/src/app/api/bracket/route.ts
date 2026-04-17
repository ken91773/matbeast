import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import {
  groupMatchesByRound,
  loadBracketForTournament,
} from "@/lib/bracket-engine";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const { eventId, matches } = await loadBracketForTournament(tournamentId);
    const g = groupMatchesByRound(matches);
    return NextResponse.json({
      tournamentId,
      eventId,
      quarterFinals: g.quarterFinals.map(serializeMatch),
      semiFinals: g.semiFinals.map(serializeMatch),
      grandFinal: g.grandFinal ? serializeMatch(g.grandFinal) : null,
    });
  } catch (e) {
    console.error("[GET /api/bracket]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Bracket load failed" },
      { status: 500 },
    );
  }
}

function serializeMatch(m: {
  id: string;
  round: string;
  bracketIndex: number;
  winnerTeamId: string | null;
  homeTeam: { id: string; name: string; seedOrder: number };
  awayTeam: { id: string; name: string; seedOrder: number };
  winnerTeam: { id: string; name: string; seedOrder: number } | null;
}) {
  return {
    id: m.id,
    round: m.round,
    bracketIndex: m.bracketIndex,
    winnerTeamId: m.winnerTeamId,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    winnerTeam: m.winnerTeam,
  };
}
