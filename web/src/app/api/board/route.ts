import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ensureLiveScoreboardState,
  getBoardPayload,
  toBoardPayload,
} from "@/lib/board";

function effectiveSeconds(
  timerRunning: boolean,
  timerEndsAt: Date | null,
  timerSeconds: number,
): number {
  if (!timerRunning || !timerEndsAt) return Math.max(0, timerSeconds);
  const ms = timerEndsAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

export async function GET() {
  try {
    const payload = await getBoardPayload();
    return NextResponse.json(payload);
  } catch (e) {
    console.error("[api/board GET]", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      {
        error: message,
        hint:
          message.includes("no such table") || message.includes("no such column")
            ? "Run: npx prisma db push (from the web folder)"
            : undefined,
      },
      { status: 500 },
    );
  }
}

type Command =
  | { type: "timer_start" }
  | { type: "timer_pause" }
  | { type: "reset_match" }
  | { type: "reset_timer_regulation" }
  | { type: "reset_timer_overtime" }
  | { type: "adjust_timer_seconds"; deltaSeconds: number }
  | { type: "begin_overtime_period" }
  | { type: "advance_overtime_minute" }
  | { type: "eliminate_left" }
  | { type: "eliminate_right" }
  | { type: "undo_eliminate_left" }
  | { type: "undo_eliminate_right" }
  | { type: "ot_round_win_left" }
  | { type: "ot_round_win_right" }
  | { type: "final_save"; resultType: "LEFT" | "RIGHT" | "DRAW" | "NO_CONTEST" }
  | { type: "final_unsave" }
  | { type: "clear_fields" };

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      leftPlayerId?: string | null;
      rightPlayerId?: string | null;
      customLeftName?: string | null;
      customLeftTeamName?: string | null;
      customRightName?: string | null;
      customRightTeamName?: string | null;
      currentRosterFileName?: string | null;
      roundLabel?: string;
      command?: Command;
    };

    const state = await ensureLiveScoreboardState();

    const next = { ...state };

  if (body.leftPlayerId !== undefined) {
    next.leftPlayerId = body.leftPlayerId;
  }
  if (body.rightPlayerId !== undefined) {
    next.rightPlayerId = body.rightPlayerId;
  }
  if (body.customLeftName !== undefined) {
    next.customLeftName =
      typeof body.customLeftName === "string"
        ? body.customLeftName.trim().toUpperCase() || null
        : null;
  }
  if (body.customLeftTeamName !== undefined) {
    next.customLeftTeamName =
      typeof body.customLeftTeamName === "string"
        ? body.customLeftTeamName.trim().toUpperCase() || null
        : null;
  }
  if (body.customRightName !== undefined) {
    next.customRightName =
      typeof body.customRightName === "string"
        ? body.customRightName.trim().toUpperCase() || null
        : null;
  }
  if (body.customRightTeamName !== undefined) {
    next.customRightTeamName =
      typeof body.customRightTeamName === "string"
        ? body.customRightTeamName.trim().toUpperCase() || null
        : null;
  }
  if (typeof body.roundLabel === "string" && body.roundLabel.trim()) {
    next.roundLabel = body.roundLabel.trim();
  }
  if (body.currentRosterFileName !== undefined) {
    const rosterName =
      typeof body.currentRosterFileName === "string"
        ? body.currentRosterFileName.trim()
        : "";
    next.currentRosterFileName = rosterName || "UNTITLED";
  }

  const cmd = body.command;
  if (cmd) {
    const sec = effectiveSeconds(
      next.timerRunning,
      next.timerEndsAt,
      next.timerSeconds,
    );

    switch (cmd.type) {
      case "timer_start": {
        next.timerSeconds = sec;
        next.timerRunning = true;
        next.timerEndsAt = new Date(Date.now() + sec * 1000);
        break;
      }
      case "timer_pause": {
        next.timerSeconds = sec;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "reset_match": {
        next.timerSeconds = 240;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.timerPhase = "REGULATION";
        next.overtimeIndex = 0;
        next.overtimeWinsLeft = 0;
        next.overtimeWinsRight = 0;
        next.leftEliminatedCount = 0;
        next.rightEliminatedCount = 0;
        break;
      }
      case "reset_timer_regulation": {
        next.timerSeconds = 240;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.timerPhase = "REGULATION";
        next.overtimeIndex = 0;
        break;
      }
      case "reset_timer_overtime": {
        next.timerSeconds = 60;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "adjust_timer_seconds": {
        if (!Number.isFinite(cmd.deltaSeconds)) break;
        const delta = Math.trunc(cmd.deltaSeconds);
        const adjusted = Math.max(0, sec + delta);
        next.timerSeconds = adjusted;
        if (next.timerRunning) {
          next.timerEndsAt = new Date(Date.now() + adjusted * 1000);
        } else {
          next.timerEndsAt = null;
        }
        break;
      }
      case "begin_overtime_period": {
        next.timerPhase = "OVERTIME";
        next.overtimeIndex = next.overtimeIndex === 0 ? 1 : next.overtimeIndex;
        next.timerSeconds = 60;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "advance_overtime_minute": {
        if (next.timerPhase !== "OVERTIME") break;
        if (next.overtimeIndex >= 3) break;
        next.overtimeIndex = next.overtimeIndex + 1;
        next.timerSeconds = 60;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "eliminate_left": {
        next.leftEliminatedCount = Math.min(5, next.leftEliminatedCount + 1);
        break;
      }
      case "eliminate_right": {
        next.rightEliminatedCount = Math.min(5, next.rightEliminatedCount + 1);
        break;
      }
      case "undo_eliminate_left": {
        next.leftEliminatedCount = Math.max(0, next.leftEliminatedCount - 1);
        break;
      }
      case "undo_eliminate_right": {
        next.rightEliminatedCount = Math.max(0, next.rightEliminatedCount - 1);
        break;
      }
      case "ot_round_win_left": {
        if (next.overtimeWinsLeft < 2)
          next.overtimeWinsLeft = next.overtimeWinsLeft + 1;
        break;
      }
      case "ot_round_win_right": {
        if (next.overtimeWinsRight < 2)
          next.overtimeWinsRight = next.overtimeWinsRight + 1;
        break;
      }
      case "clear_fields": {
        next.leftPlayerId = null;
        next.rightPlayerId = null;
        next.customLeftName = null;
        next.customLeftTeamName = null;
        next.customRightName = null;
        next.customRightTeamName = null;
        next.roundLabel = "Quarter Finals";
        next.finalSaved = false;
        next.finalResultType = null;
        next.finalWinnerName = null;
        next.finalResultLogId = null;
        next.preFinalStateJson = null;
        break;
      }
      case "final_save": {
        const leftP = next.leftPlayerId
          ? await prisma.player.findUnique({
              where: { id: next.leftPlayerId },
              include: { team: true },
            })
          : null;
        const rightP = next.rightPlayerId
          ? await prisma.player.findUnique({
              where: { id: next.rightPlayerId },
              include: { team: true },
            })
          : null;
        const leftName =
          next.customLeftName?.trim() ||
          (leftP ? `${leftP.firstName} ${leftP.lastName}`.trim() : "");
        const rightName =
          next.customRightName?.trim() ||
          (rightP ? `${rightP.firstName} ${rightP.lastName}`.trim() : "");
        if (!leftName || !rightName) {
          return NextResponse.json(
            { error: "Set both fighters before saving FINAL result" },
            { status: 400 },
          );
        }

        let winnerName: string | null = null;
        if (cmd.resultType === "LEFT") winnerName = leftName;
        if (cmd.resultType === "RIGHT") winnerName = rightName;

        const snapshot = JSON.stringify({
          leftPlayerId: state.leftPlayerId,
          rightPlayerId: state.rightPlayerId,
          customLeftName: state.customLeftName,
          customLeftTeamName: state.customLeftTeamName,
          customRightName: state.customRightName,
          customRightTeamName: state.customRightTeamName,
          currentRosterFileName: state.currentRosterFileName,
          roundLabel: state.roundLabel,
          finalSaved: state.finalSaved,
          finalResultType: state.finalResultType,
          finalWinnerName: state.finalWinnerName,
          finalResultLogId: state.finalResultLogId,
        });

        const created = await prisma.resultLog.create({
          data: {
            rosterFileName: next.currentRosterFileName,
            roundLabel: next.roundLabel,
            leftName,
            rightName,
            resultType: cmd.resultType,
            winnerName,
          },
        });

        next.finalSaved = true;
        next.finalResultType = cmd.resultType;
        next.finalWinnerName = winnerName;
        next.finalResultLogId = created.id;
        next.preFinalStateJson = snapshot;
        break;
      }
      case "final_unsave": {
        if (!state.finalSaved) break;
        if (state.finalResultLogId) {
          await prisma.resultLog.deleteMany({ where: { id: state.finalResultLogId } });
        }
        // UNSAVE should only clear the final-result record/state, not fighter fields.
        next.finalSaved = false;
        next.finalResultType = null;
        next.finalWinnerName = null;
        next.finalResultLogId = null;
        next.preFinalStateJson = null;
        break;
      }
      default:
        break;
    }
  }

  const saved = await prisma.liveScoreboardState.update({
    where: { id: state.id },
    data: {
      leftPlayerId: next.leftPlayerId,
      rightPlayerId: next.rightPlayerId,
      customLeftName: next.customLeftName,
      customLeftTeamName: next.customLeftTeamName,
      customRightName: next.customRightName,
      customRightTeamName: next.customRightTeamName,
      roundLabel: next.roundLabel,
      currentRosterFileName: next.currentRosterFileName,
      finalSaved: next.finalSaved,
      finalResultType: next.finalResultType,
      finalWinnerName: next.finalWinnerName,
      finalResultLogId: next.finalResultLogId,
      preFinalStateJson: next.preFinalStateJson,
      timerSeconds: next.timerSeconds,
      timerRunning: next.timerRunning,
      timerEndsAt: next.timerEndsAt,
      timerPhase: next.timerPhase,
      overtimeIndex: next.overtimeIndex,
      overtimeWinsLeft: next.overtimeWinsLeft,
      overtimeWinsRight: next.overtimeWinsRight,
      leftEliminatedCount: next.leftEliminatedCount,
      rightEliminatedCount: next.rightEliminatedCount,
    },
  });

  const [leftP, rightP] = await Promise.all([
    saved.leftPlayerId
      ? prisma.player.findUnique({
          where: { id: saved.leftPlayerId },
          include: { team: true },
        })
      : null,
    saved.rightPlayerId
      ? prisma.player.findUnique({
          where: { id: saved.rightPlayerId },
          include: { team: true },
        })
      : null,
  ]);
  const logs = await prisma.resultLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
  });

    return NextResponse.json(toBoardPayload(saved, leftP, rightP, logs));
  } catch (e) {
    console.error("[api/board PATCH]", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      {
        error: message,
        hint:
          message.includes("no such table") || message.includes("no such column")
            ? "Run: npx prisma db push (from the web folder)"
            : undefined,
      },
      { status: 500 },
    );
  }
}
