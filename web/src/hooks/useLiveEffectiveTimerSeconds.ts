"use client";

import { useEffect, useState } from "react";

/** 100 ms wall-clock tick while the match timer is running (overlay + cues). */
export function useLiveEffectiveTimerSeconds(
  secondsRemaining: number | undefined,
  timerRunning: boolean | undefined,
  timerEndsAt: string | null | undefined,
): number | undefined {
  const [liveSec, setLiveSec] = useState(secondsRemaining);

  useEffect(() => {
    if (secondsRemaining === undefined) {
      setLiveSec(undefined);
      return;
    }
    if (!timerRunning || !timerEndsAt) {
      setLiveSec(secondsRemaining);
      return;
    }
    const endsAtMs = Date.parse(timerEndsAt);
    if (!Number.isFinite(endsAtMs)) {
      setLiveSec(secondsRemaining);
      return;
    }
    const tick = () => {
      setLiveSec(Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [secondsRemaining, timerRunning, timerEndsAt]);

  /**
   * When the timer is NOT counting down, return the prop directly instead of
   * the internal `liveSec` state. `liveSec` only catches up to a new
   * `secondsRemaining` one render later (via the effect above), which means a
   * paused clock jump (e.g. an OT SUB transfer setting the clock to 5s) lands
   * in a different render than its `resetKey` change — so the warning-cue
   * edge detector sees prev>warn → curr<=warn and fires a false alarm.
   * Returning the prop here keeps the value change and the reset key in lockstep.
   */
  if (secondsRemaining === undefined) return undefined;
  if (!timerRunning || !timerEndsAt) return secondsRemaining;
  return liveSec;
}
