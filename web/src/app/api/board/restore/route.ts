import { NextResponse } from "next/server";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";
import { prisma } from "@/lib/prisma";
import type { FinalResultType } from "@prisma/client";

export async function POST(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const body = (await req.json()) as {
      leftPlayerId?: string | null;
      rightPlayerId?: string | null;
      customLeftName?: string | null;
      customLeftTeamName?: string | null;
      customRightName?: string | null;
      customRightTeamName?: string | null;
      currentRosterFileName?: string;
      roundLabel?: string;
      finalSaved?: boolean;
      finalResultType?: string | null;
      finalWinnerName?: string | null;
      secondsRemaining?: number;
      timerRunning?: boolean;
      timerPhase?: "REGULATION" | "OVERTIME";
      overtimeIndex?: number;
      overtimeWinsLeft?: number;
      overtimeWinsRight?: number;
      leftEliminatedCount?: number;
      rightEliminatedCount?: number;
    };

    const seconds = Number.isFinite(body.secondsRemaining)
      ? Math.max(0, Math.trunc(body.secondsRemaining as number))
      : 240;
    const timerRunning = Boolean(body.timerRunning);

    await prisma.liveScoreboardState.update({
      where: { tournamentId },
      data: {
        leftPlayerId: body.leftPlayerId ?? null,
        rightPlayerId: body.rightPlayerId ?? null,
        customLeftName: body.customLeftName?.trim() || null,
        customLeftTeamName: body.customLeftTeamName?.trim() || null,
        customRightName: body.customRightName?.trim() || null,
        customRightTeamName: body.customRightTeamName?.trim() || null,
        currentRosterFileName:
          body.currentRosterFileName?.trim() || "UNTITLED",
        roundLabel: body.roundLabel?.trim() || "Quarter Finals",
        finalSaved: Boolean(body.finalSaved),
        finalResultType: (body.finalResultType ?? null) as FinalResultType | null,
        finalWinnerName: body.finalWinnerName?.trim() || null,
        timerSeconds: seconds,
        timerRunning,
        timerEndsAt: timerRunning ? new Date(Date.now() + seconds * 1000) : null,
        timerPhase: body.timerPhase === "OVERTIME" ? "OVERTIME" : "REGULATION",
        overtimeIndex: Number.isFinite(body.overtimeIndex)
          ? Math.max(0, Math.trunc(body.overtimeIndex as number))
          : 0,
        overtimeWinsLeft: Number.isFinite(body.overtimeWinsLeft)
          ? Math.max(0, Math.trunc(body.overtimeWinsLeft as number))
          : 0,
        overtimeWinsRight: Number.isFinite(body.overtimeWinsRight)
          ? Math.max(0, Math.trunc(body.overtimeWinsRight as number))
          : 0,
        leftEliminatedCount: Number.isFinite(body.leftEliminatedCount)
          ? Math.max(0, Math.min(5, Math.trunc(body.leftEliminatedCount as number)))
          : 0,
        rightEliminatedCount: Number.isFinite(body.rightEliminatedCount)
          ? Math.max(0, Math.min(5, Math.trunc(body.rightEliminatedCount as number)))
          : 0,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/board/restore]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Restore failed" },
      { status: 400 },
    );
  }
}
