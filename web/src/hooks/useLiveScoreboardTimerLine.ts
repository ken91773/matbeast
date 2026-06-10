"use client";

import { useRef } from "react";
import { useLiveEffectiveTimerSeconds } from "@/hooks/useLiveEffectiveTimerSeconds";
import type { BoardPayload } from "@/types/board";
import {
  scoreboardTimerLineFromBoard,
  scoreboardTimerLineFromRemaining,
} from "@/lib/scoreboard-timer-display";

/**
 * Largest upward step (seconds) at the running→stopped edge that we treat as a
 * latency/clock-skew artifact to suppress, rather than a genuine reset or clock
 * edit (those jump by far more — e.g. resetting to 1:00 or 4:00).
 */
const MAX_STOP_BACKUP_SUPPRESS_SECONDS = 3;

/** Scoreboard clock string driven by wall clock when the timer is running. */
export function useLiveScoreboardTimerLine(
  board: BoardPayload | undefined,
): string {
  const liveSec = useLiveEffectiveTimerSeconds(
    board?.secondsRemaining,
    board?.timerRunning,
    board?.timerEndsAt ?? null,
  );

  /**
   * Suppress the clock visibly "backing up" when the timer stops.
   *
   * On a remote overlay (e.g. OBS Browser Source) the running clock is
   * extrapolated locally and may tick a second past the real stop before the
   * stopped state arrives (poll latency + any clock skew between machines).
   * The server's frozen `secondsRemaining` then lands slightly higher than the
   * number just shown, so the display hops upward. We hold the last running
   * value at that edge so the clock simply freezes in place instead.
   *
   * Refs are read/written during render purely as derived display memory (no
   * external side effects); the logic is idempotent across repeat renders.
   */
  const prevRunningRef = useRef(false);
  const lastRunningSecRef = useRef<number | undefined>(undefined);
  const holdSecRef = useRef<number | undefined>(undefined);
  const holdBaselineRef = useRef<number | undefined>(undefined);

  const running = !!board?.timerRunning;

  if (running) {
    if (liveSec !== undefined) lastRunningSecRef.current = liveSec;
    holdSecRef.current = undefined;
    holdBaselineRef.current = undefined;
  } else if (liveSec !== undefined) {
    if (prevRunningRef.current) {
      const lastRun = lastRunningSecRef.current;
      if (
        lastRun !== undefined &&
        liveSec > lastRun &&
        liveSec - lastRun <= MAX_STOP_BACKUP_SUPPRESS_SECONDS
      ) {
        holdSecRef.current = lastRun;
        holdBaselineRef.current = liveSec;
      } else {
        holdSecRef.current = undefined;
        holdBaselineRef.current = undefined;
      }
    } else if (
      holdSecRef.current !== undefined &&
      liveSec !== holdBaselineRef.current
    ) {
      /** A reset / clock edit changed the paused value — stop holding. */
      holdSecRef.current = undefined;
      holdBaselineRef.current = undefined;
    }
  }

  prevRunningRef.current = running;

  const displaySec =
    !running && holdSecRef.current !== undefined ? holdSecRef.current : liveSec;

  if (!board) return "—:—";
  if (displaySec === undefined) return scoreboardTimerLineFromBoard(board);
  return scoreboardTimerLineFromRemaining(board, displaySec);
}
