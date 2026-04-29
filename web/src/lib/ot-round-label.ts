/** Round labels that enable OT round mode (dual timer, elapsed on final save). */
export const OT_ROUND_DROPDOWN_LABELS = [
  "OT ROUND1",
  "OT ROUND 2",
  "OT ROUND 3",
] as const;

export type OtRoundDropdownLabel = (typeof OT_ROUND_DROPDOWN_LABELS)[number];

export function isOtRoundLabelFromDropdown(label: string | null | undefined): boolean {
  if (!label) return false;
  const t = label.trim();
  return (OT_ROUND_DROPDOWN_LABELS as readonly string[]).includes(t);
}

/** Map applied round label to positive overtimeIndex (1–3) for legacy fields / payloads. */
export function otRoundIndexFromLabel(label: string | null | undefined): 1 | 2 | 3 | null {
  if (!label) return null;
  const t = label.trim();
  if (t === "OT ROUND1") return 1;
  if (t === "OT ROUND 2") return 2;
  if (t === "OT ROUND 3") return 3;
  return null;
}

/** Elapsed secondary clock for OT round mode (synced with main timer running/paused). */
export function effectiveOtRoundElapsedSeconds(params: {
  otRoundElapsedBaseSeconds: number;
  otRoundElapsedRunStartedAt: Date | null;
  timerRunning: boolean;
}): number {
  const base = Math.max(0, Math.trunc(params.otRoundElapsedBaseSeconds));
  if (!params.timerRunning || !params.otRoundElapsedRunStartedAt) {
    return base;
  }
  const delta = Math.floor(
    (Date.now() - params.otRoundElapsedRunStartedAt.getTime()) / 1000,
  );
  return Math.max(0, base + delta);
}

/**
 * If the main timer is paused but `otRoundElapsedRunStartedAt` is still set,
 * fold that wall segment into `otRoundElapsedBaseSeconds` and clear the anchor.
 * Keeps persisted state aligned with what operators see for ELAPSED and prevents
 * fighter-only PATCH responses from looking like a reset (base-only seconds).
 */
export function foldOtRoundElapsedOrphanAnchorWhenPaused<
  T extends {
    roundLabel: string;
    timerRunning: boolean;
    otRoundElapsedBaseSeconds: number;
    otRoundElapsedRunStartedAt: Date | null;
  },
>(next: T): boolean {
  if (!isOtRoundLabelFromDropdown(next.roundLabel)) return false;
  if (next.timerRunning || !next.otRoundElapsedRunStartedAt) return false;
  const delta = Math.floor(
    (Date.now() - next.otRoundElapsedRunStartedAt.getTime()) / 1000,
  );
  next.otRoundElapsedBaseSeconds = Math.max(
    0,
    next.otRoundElapsedBaseSeconds + delta,
  );
  next.otRoundElapsedRunStartedAt = null;
  return true;
}

/**
 * Total OT-round elapsed used for **Apply** / undo (and any path that must match
 * that command). Folds `otRoundElapsedRunStartedAt` whenever it is set, even if
 * `timerRunning` is false (orphan anchor after a missed pause fold — avoids
 * transferring 0 while the operator still sees a non-zero ELAPSED).
 */
export function otRoundElapsedTotalFromAnchoredBase(params: {
  otRoundElapsedBaseSeconds: number;
  otRoundElapsedRunStartedAt: Date | null;
}): number {
  let el = Math.max(0, Math.trunc(params.otRoundElapsedBaseSeconds));
  if (params.otRoundElapsedRunStartedAt) {
    const delta = Math.floor(
      (Date.now() - params.otRoundElapsedRunStartedAt.getTime()) / 1000,
    );
    el = Math.max(0, el + delta);
  }
  return el;
}

/** Mutates board draft when PATCH applies a new `roundLabel`. */
export function reconcileBoardStateForRoundLabelChange<
  T extends {
    roundLabel: string;
    timerPhase: string;
    overtimeIndex: number;
    otPlayDirection: number;
    otRoundElapsedBaseSeconds: number;
    otRoundElapsedRunStartedAt: Date | null;
    otRoundTransferConsumed?: boolean;
    otRoundTransferUndoMainSeconds?: number | null;
    otRoundTransferUndoElapsedTotal?: number | null;
  },
>(prevRoundLabel: string, next: T): void {
  const wasOt = isOtRoundLabelFromDropdown(prevRoundLabel);
  const nowOt = isOtRoundLabelFromDropdown(next.roundLabel);
  const idx = otRoundIndexFromLabel(next.roundLabel);

  if (nowOt) {
    next.timerPhase = "OVERTIME";
    next.overtimeIndex = idx ?? 1;
    next.otPlayDirection = 1;
    /**
     * Only zero the secondary ELAPSED clock when **entering** OT round mode
     * from non-OT (e.g. Quarter Finals → OT ROUND1). Moving between OT rounds
     * (OT ROUND1 → OT ROUND 2 → OT ROUND 3) preserves ELAPSED so the operator
     * can carry the accumulated match clock forward across rounds. The transfer
     * undo state is always cleared on any round label change because it is
     * tied to the previous round's specific transfer action.
     */
    if (!wasOt) {
      next.otRoundElapsedBaseSeconds = 0;
      next.otRoundElapsedRunStartedAt = null;
    }
    next.otRoundTransferConsumed = false;
    next.otRoundTransferUndoMainSeconds = null;
    next.otRoundTransferUndoElapsedTotal = null;
  } else if (wasOt) {
    next.otRoundElapsedBaseSeconds = 0;
    next.otRoundElapsedRunStartedAt = null;
    next.otRoundTransferConsumed = false;
    next.otRoundTransferUndoMainSeconds = null;
    next.otRoundTransferUndoElapsedTotal = null;
    if (next.timerPhase === "OVERTIME") {
      const oi = next.overtimeIndex;
      if (oi >= 1 && oi <= 3) {
        next.timerPhase = "REGULATION";
        next.overtimeIndex = 0;
      }
    }
  }
}
