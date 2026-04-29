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
      otPlayDirection?: number;
      otRoundElapsedBaseSeconds?: number;
      otRoundElapsedRunStartedAt?: string | null;
      showFinalWinnerHighlight?: boolean;
      timerCuesResetNonce?: number;
      otRoundTransferConsumed?: boolean;
      otRoundTransferUndoMainSeconds?: number | null;
      otRoundTransferUndoElapsedTotal?: number | null;
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
          ? (() => {
              const v = Math.trunc(body.overtimeIndex as number);
              if (v === -1 || v === -2 || v === -3 || v === -4) return v;
              return Math.max(0, Math.min(10, v));
            })()
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
        otPlayDirection: Number.isFinite(body.otPlayDirection)
          ? (Math.trunc(body.otPlayDirection as number) === -1 ? -1 : 1)
          : 1,
        otRoundElapsedBaseSeconds: Number.isFinite(body.otRoundElapsedBaseSeconds)
          ? Math.max(0, Math.trunc(body.otRoundElapsedBaseSeconds as number))
          : 0,
        otRoundElapsedRunStartedAt:
          typeof body.otRoundElapsedRunStartedAt === "string" &&
          body.otRoundElapsedRunStartedAt.trim()
            ? new Date(body.otRoundElapsedRunStartedAt)
            : null,
        showFinalWinnerHighlight:
          body.showFinalWinnerHighlight === undefined
            ? true
            : Boolean(body.showFinalWinnerHighlight),
        timerCuesResetNonce: Number.isFinite(body.timerCuesResetNonce)
          ? Math.max(0, Math.trunc(body.timerCuesResetNonce as number))
          : undefined,
        otRoundTransferConsumed:
          body.otRoundTransferConsumed === undefined
            ? undefined
            : Boolean(body.otRoundTransferConsumed),
        otRoundTransferUndoMainSeconds:
          body.otRoundTransferUndoMainSeconds === undefined
            ? undefined
            : body.otRoundTransferUndoMainSeconds == null
              ? null
              : Math.max(
                  0,
                  Math.min(24 * 3600, Math.trunc(body.otRoundTransferUndoMainSeconds)),
                ),
        otRoundTransferUndoElapsedTotal:
          body.otRoundTransferUndoElapsedTotal === undefined
            ? undefined
            : body.otRoundTransferUndoElapsedTotal == null
              ? null
              : Math.max(
                  0,
                  Math.trunc(body.otRoundTransferUndoElapsedTotal),
                ),
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
