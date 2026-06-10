import type { BoardPayload } from "@/types/board";

/** Resolve the WARN threshold (seconds) from board settings. */
export function resolveWarningSeconds(board: BoardPayload | undefined): number {
  if (!board) return 30;
  if (board.timerOtRoundMode) return 10;
  const raw = board.soundWarningSeconds;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.min(99, Math.trunc(raw)));
  }
  return 30;
}

/**
 * Wall-clock seconds remaining when the timer is running; otherwise the
 * server-reported `secondsRemaining` (paused / armed states).
 */
export function effectiveTimerSecondsFromBoard(
  board: BoardPayload | undefined,
): number | undefined {
  if (!board) return undefined;
  if (board.timerRunning && board.timerEndsAt) {
    const endsAtMs = Date.parse(board.timerEndsAt);
    if (Number.isFinite(endsAtMs)) {
      return Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
    }
  }
  return board.secondsRemaining;
}

/**
 * Faster board polling near cue boundaries for non–wall-clock board fields.
 * The overlay match clock and timer cues use `timerEndsAt` on a 100 ms tick.
 */
export function boardRefetchIntervalMs(
  board: BoardPayload | undefined,
): number {
  if (!board?.timerRunning) return 1000;
  const sec = effectiveTimerSecondsFromBoard(board) ?? board.secondsRemaining;
  const warnAt = resolveWarningSeconds(board);
  if (sec <= 3 || sec <= warnAt + 1) return 100;
  if (sec <= 10 || sec <= warnAt + 3) return 250;
  return 1000;
}
