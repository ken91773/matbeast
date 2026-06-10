/**
 * OT intermediate (advancing) result log. These per-half results live only on
 * the control card (NOT the Results card) until an OT-ender flushes them into
 * the Results log. Stored on the board as a JSON string in
 * `otIntermediateLogJson`.
 */

export type OtIntermediateKind = "SUB" | "ESC" | "DRAW";

/** Board values captured before a save so an "unsave" can restore them. */
export type OtIntermediateRestore = {
  roundLabel: string;
  timerSeconds: number;
  otElapsedSeconds: number;
};

export type OtIntermediateEntry = {
  /** Round label at the time the half was recorded (e.g. "OT ROUND1 ↑"). */
  roundLabel: string;
  /** Winning/acting corner; null for a draw. */
  side: "left" | "right" | null;
  /** Display name of the acting fighter at record time; "" for a draw. */
  playerName: string;
  kind: OtIntermediateKind;
  /** Elapsed seconds captured (and possibly edited) by the operator; null for a draw. */
  elapsedSeconds: number | null;
  /** ISO timestamp when the half was committed. */
  createdAt: string;
  /** Pre-save board values, used by unsave to revert this entry's advance. */
  restore?: OtIntermediateRestore;
};

/** mm:ss for a non-negative seconds count. */
export function formatOtElapsedMmss(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** ":ss" display for the editable elapsed box (e.g. 26 → ":26", 5 → ":05"). */
export function formatOtElapsedColonSeconds(
  seconds: number | null | undefined,
): string {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0));
  return `:${String(s).padStart(2, "0")}`;
}

/** Parse ":ss" / "m:ss" / bare seconds into seconds, or null when blank/invalid. */
export function parseOtElapsedMmss(value: string | null | undefined): number | null {
  const t = (value ?? "").trim();
  if (!t) return null;
  /** Leading-colon form (":26", ":120") → bare seconds. */
  const leadingColon = t.match(/^:(\d{1,5})$/);
  if (leadingColon) {
    return Number(leadingColon[1]);
  }
  const colon = t.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (colon) {
    return Number(colon[1]) * 60 + Number(colon[2]);
  }
  if (/^\d{1,5}$/.test(t)) {
    return Number(t);
  }
  return null;
}

/** One human-readable line for the in-card log and the Results-log flush. */
export function formatOtIntermediateLine(entry: OtIntermediateEntry): string {
  const round = entry.roundLabel.trim();
  if (entry.kind === "DRAW") {
    return `${round}: Draw`;
  }
  const name = entry.playerName.trim() || "—";
  const elapsed = formatOtElapsedColonSeconds(entry.elapsedSeconds);
  return `${round}: ${name} by ${entry.kind} elapsed time: ${elapsed}`;
}

/** Tolerant parse of the stored JSON array. */
export function parseOtIntermediateLog(
  json: string | null | undefined,
): OtIntermediateEntry[] {
  if (!json || !json.trim()) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => {
        const r = e.restore as Record<string, unknown> | undefined;
        const restore: OtIntermediateRestore | undefined =
          r && typeof r === "object" && typeof r.roundLabel === "string"
            ? {
                roundLabel: r.roundLabel,
                timerSeconds:
                  typeof r.timerSeconds === "number" && Number.isFinite(r.timerSeconds)
                    ? Math.max(0, Math.trunc(r.timerSeconds))
                    : 0,
                otElapsedSeconds:
                  typeof r.otElapsedSeconds === "number" &&
                  Number.isFinite(r.otElapsedSeconds)
                    ? Math.max(0, Math.trunc(r.otElapsedSeconds))
                    : 0,
              }
            : undefined;
        return {
          roundLabel: typeof e.roundLabel === "string" ? e.roundLabel : "",
          side:
            e.side === "left" || e.side === "right"
              ? (e.side as "left" | "right")
              : null,
          playerName: typeof e.playerName === "string" ? e.playerName : "",
          kind:
            e.kind === "SUB" || e.kind === "ESC" || e.kind === "DRAW"
              ? (e.kind as OtIntermediateKind)
              : "DRAW",
          elapsedSeconds:
            typeof e.elapsedSeconds === "number" && Number.isFinite(e.elapsedSeconds)
              ? Math.max(0, Math.trunc(e.elapsedSeconds))
              : null,
          createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
          ...(restore ? { restore } : {}),
        };
      });
  } catch {
    return [];
  }
}

/** Total ESC elapsed seconds for one corner across all recorded halves. */
export function totalEscapeSecondsForSide(
  entries: readonly OtIntermediateEntry[],
  side: "left" | "right",
): number {
  return entries.reduce(
    (sum, e) =>
      e.kind === "ESC" && e.side === side && e.elapsedSeconds != null
        ? sum + e.elapsedSeconds
        : sum,
    0,
  );
}
