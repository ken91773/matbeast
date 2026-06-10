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
 *
 * `maxIntervalMs` caps the idle (away-from-boundary) interval. The dashboard
 * keeps the default 1000 ms — it is the source of truth and holds state
 * locally. A remote scoreboard Browser Source passes a tighter cap (e.g.
 * 250 ms) so discrete edges that have no local clock to extrapolate from —
 * start/stop, the manual 10s/horn cue nonces, name/score changes — surface
 * with at most ~¼ s of poll-phase lag instead of nearly a full second.
 */
export function boardRefetchIntervalMs(
  board: BoardPayload | undefined,
  maxIntervalMs: number = 1000,
): number {
  if (!board?.timerRunning) return maxIntervalMs;
  const sec = effectiveTimerSecondsFromBoard(board) ?? board.secondsRemaining;
  const warnAt = resolveWarningSeconds(board);
  if (sec <= 3 || sec <= warnAt + 1) return Math.min(100, maxIntervalMs);
  if (sec <= 10 || sec <= warnAt + 3) return Math.min(250, maxIntervalMs);
  return maxIntervalMs;
}
