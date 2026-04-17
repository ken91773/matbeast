import { NextResponse } from "next/server";
import {
  groupMatchesByRound,
  setBracketMatchTeams,
  setBracketMatchWinner,
} from "@/lib/bracket-engine";

export const dynamic = "force-dynamic";

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

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      winnerTeamId?: string | null;
      homeTeamId?: string;
      awayTeamId?: string;
    };
    if (!("winnerTeamId" in body) && !("homeTeamId" in body && "awayTeamId" in body)) {
      return NextResponse.json(
        { error: "winnerTeamId or (homeTeamId + awayTeamId) required" },
        { status: 400 },
      );
    }
    if (
      typeof body.homeTeamId === "string" &&
      typeof body.awayTeamId === "string" &&
      body.homeTeamId &&
      body.awayTeamId
    ) {
      const { matches } = await setBracketMatchTeams(id, body.homeTeamId, body.awayTeamId);
      const g = groupMatchesByRound(matches);
      return NextResponse.json({
        quarterFinals: g.quarterFinals.map(serialize),
        semiFinals: g.semiFinals.map(serialize),
        grandFinal: g.grandFinal ? serialize(g.grandFinal) : null,
      });
    }
    const winnerTeamId: string | null =
      body.winnerTeamId === null ||
      body.winnerTeamId === undefined ||
      body.winnerTeamId === ""
        ? null
        : body.winnerTeamId;

    const { matches } = await setBracketMatchWinner(id, winnerTeamId);
    const g = groupMatchesByRound(matches);
    return NextResponse.json({
      quarterFinals: g.quarterFinals.map(serialize),
      semiFinals: g.semiFinals.map(serialize),
      grandFinal: g.grandFinal ? serialize(g.grandFinal) : null,
    });
  } catch (e) {
    console.error("[PATCH /api/bracket/matches/[id]]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Update failed" },
      { status: 400 },
    );
  }
}
