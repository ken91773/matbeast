"use client";

import { useLiveEffectiveTimerSeconds } from "@/hooks/useLiveEffectiveTimerSeconds";
import type { BoardPayload } from "@/types/board";
import {
  scoreboardTimerLineFromBoard,
  scoreboardTimerLineFromRemaining,
} from "@/lib/scoreboard-timer-display";

/** Scoreboard clock string driven by wall clock when the timer is running. */
export function useLiveScoreboardTimerLine(
  board: BoardPayload | undefined,
): string {
  const liveSec = useLiveEffectiveTimerSeconds(
    board?.secondsRemaining,
    board?.timerRunning,
    board?.timerEndsAt ?? null,
  );
  if (!board) return "—:—";
  if (liveSec === undefined) return scoreboardTimerLineFromBoard(board);
  return scoreboardTimerLineFromRemaining(board, liveSec);
}
