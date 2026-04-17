import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import {
  generateBracketFromSeeds,
  groupMatchesByRound,
} from "@/lib/bracket-engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const { eventId, matches } = await generateBracketFromSeeds(tournamentId);
    const g = groupMatchesByRound(matches);
    return NextResponse.json({
      tournamentId,
      eventId,
      quarterFinals: g.quarterFinals.map(serialize),
      semiFinals: g.semiFinals.map(serialize),
      grandFinal: g.grandFinal ? serialize(g.grandFinal) : null,
    });
  } catch (e) {
    console.error("[POST /api/bracket/generate]", e);
    const msg = e instanceof Error ? e.message : "Generate failed";
    const status = msg.includes("Need exactly") || msg.includes("seeds") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

function serialize(m: {
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
