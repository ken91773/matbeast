import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveTournamentIdFromRequest } from "@/lib/active-tournament-server";

export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import {
  ensureLiveScoreboardState,
  getBoardPayload,
} from "@/lib/board";
import {
  buildFinalSummaryLine,
  fighterSummaryFromPlayerOrCustom,
  formatMatchClockForResultSummary,
  formatTime12h,
  resultRoundLabelForResultLog,
} from "@/lib/result-log-summary";
import { setBracketMatchWinner } from "@/lib/bracket-engine";
import {
  effectiveOtRoundElapsedSeconds,
  foldOtRoundElapsedOrphanAnchorWhenPaused,
  isOtRoundLabelFromDropdown,
  otRoundElapsedTotalFromAnchoredBase,
  otRoundIndexFromLabel,
  reconcileBoardStateForRoundLabelChange,
} from "@/lib/ot-round-label";
import {
  formatOtIntermediateLine,
  parseOtIntermediateLog,
  type OtIntermediateEntry,
} from "@/lib/ot-intermediate-log";
import { FinalResultType, Prisma } from "@prisma/client";

const FINAL_SAVE_TYPES = new Set<string>([
  "LEFT",
  "RIGHT",
  "DRAW",
  "NO_CONTEST",
  "SUBMISSION_LEFT",
  "SUBMISSION_RIGHT",
  "ESCAPE_LEFT",
  "ESCAPE_RIGHT",
  "DQ_LEFT",
  "DQ_RIGHT",
]);

function winnerNameForFinal(
  resultType: FinalResultType,
  leftName: string,
  rightName: string,
): string | null {
  switch (resultType) {
    case "LEFT":
    case "SUBMISSION_LEFT":
    case "ESCAPE_LEFT":
      return leftName;
    case "RIGHT":
    case "SUBMISSION_RIGHT":
    case "ESCAPE_RIGHT":
      return rightName;
    case "DQ_LEFT":
      return rightName;
    case "DQ_RIGHT":
      return leftName;
    case "DRAW":
    case "NO_CONTEST":
    case "MANUAL":
      return null;
    default:
      return null;
  }
}

/** Winning corner for a decisive result type (null for DRAW / NO_CONTEST / MANUAL). */
function winnerSideForResult(
  resultType: FinalResultType,
): "left" | "right" | null {
  switch (resultType) {
    case "LEFT":
    case "SUBMISSION_LEFT":
    case "ESCAPE_LEFT":
    case "DQ_RIGHT":
      return "left";
    case "RIGHT":
    case "SUBMISSION_RIGHT":
    case "ESCAPE_RIGHT":
    case "DQ_LEFT":
      return "right";
    default:
      return null;
  }
}

function isMissingResultLogColumn(error: unknown, part: string) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2022") return false;
  const column =
    typeof error.meta?.column === "string" ? error.meta.column.toLowerCase() : "";
  return column.includes(part.toLowerCase());
}

/** Board state immediately before applying final_save (same PATCH body merge). */
type PreFinalSnapshot = {
  leftPlayerId?: string | null;
  rightPlayerId?: string | null;
  customLeftName?: string | null;
  customLeftTeamName?: string | null;
  customRightName?: string | null;
  customRightTeamName?: string | null;
  currentRosterFileName?: string | null;
  roundLabel?: string | null;
  leftEliminatedCount?: number;
  rightEliminatedCount?: number;
  matchSummaryResultLogId?: string | null;
  bracketMatchId?: string | null;
  bracketWinnerTeamIdBefore?: string | null;
  showFinalWinnerHighlight?: boolean;
  /** OT-ender flush: Results-log row ids inserted from the in-card OT log (for unsave cleanup). */
  otFlushResultLogIds?: string[];
  /** OT-ender flush: the in-card OT log JSON before it was flushed/cleared (restored on unsave). */
  otIntermediateLogJsonBefore?: string | null;
};

function prismaErrorMessage(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function withOtPlayDirectionDefaults(
  state: Awaited<ReturnType<typeof ensureLiveScoreboardState>>,
) {
  const next = { ...state };
  next.otPlayDirection = next.otPlayDirection === -1 ? -1 : 1;
  next.timerCuesResetNonce = Number.isFinite(next.timerCuesResetNonce)
    ? next.timerCuesResetNonce
    : 0;
  next.otRoundTransferConsumed = Boolean(next.otRoundTransferConsumed);
  if (typeof (next as { otIntermediateLogJson?: unknown }).otIntermediateLogJson !== "string") {
    (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson = null;
  }
  return next;
}

function isMissingTournamentIdColumnMessage(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("no column named tournamentid") || m.includes("resultlog.tournamentid");
}

async function readResultLogColumns(): Promise<Set<string>> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `PRAGMA table_info("ResultLog")`,
    )) as Array<{ name?: unknown }>;
    const cols = new Set<string>();
    for (const row of rows) {
      if (typeof row?.name === "string") cols.add(row.name);
    }
    return cols;
  } catch {
    return new Set<string>();
  }
}

async function insertResultLogByAvailableColumns(params: {
  id: string;
  tournamentId: string;
  rosterFileName: string;
  roundLabel: string;
  leftName: string;
  rightName: string;
  leftTeamName: string | null;
  rightTeamName: string | null;
  resultType: FinalResultType;
  winnerName: string | null;
  finalSummaryLine: string | null;
  createdAt: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const cols = await readResultLogColumns();
  if (cols.size === 0) return { ok: false, error: "ResultLog schema unavailable" };

  const valuesByColumn = new Map<string, unknown>([
    ["id", params.id],
    ["tournamentId", params.tournamentId],
    ["rosterFileName", params.rosterFileName],
    ["roundLabel", params.roundLabel],
    ["leftName", params.leftName],
    ["rightName", params.rightName],
    ["leftTeamName", params.leftTeamName],
    ["rightTeamName", params.rightTeamName],
    ["resultType", params.resultType],
    ["winnerName", params.winnerName],
    ["isManual", 0],
    ["manualDate", null],
    ["manualTime", null],
    ["finalSummaryLine", params.finalSummaryLine],
    ["createdAt", params.createdAt],
  ]);
  const preferredOrder = [
    "id",
    "tournamentId",
    "rosterFileName",
    "roundLabel",
    "leftName",
    "rightName",
    "leftTeamName",
    "rightTeamName",
    "resultType",
    "winnerName",
    "isManual",
    "manualDate",
    "manualTime",
    "finalSummaryLine",
    "createdAt",
  ] as const;
  const insertCols = preferredOrder.filter((c) => cols.has(c));
  const required = ["id", "roundLabel", "leftName", "rightName", "resultType", "createdAt"];
  if (!required.every((c) => insertCols.includes(c as (typeof preferredOrder)[number]))) {
    return { ok: false, error: "ResultLog missing required columns for final save" };
  }

  const placeholders = insertCols.map(() => "?").join(", ");
  const sql = `INSERT INTO "ResultLog" (${insertCols
    .map((c) => `"${c}"`)
    .join(", ")}) VALUES (${placeholders})`;
  const args = insertCols.map((c) => valuesByColumn.get(c));
  try {
    await prisma.$executeRawUnsafe(sql, ...args);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: prismaErrorMessage(error) };
  }
}

/**
 * Persist a finals row; Prisma create first, then raw SQL fallbacks for older SQLite schemas.
 */
async function insertResultLogForFinal(params: {
  tournamentId: string;
  rosterFileName: string;
  roundLabel: string;
  leftName: string;
  rightName: string;
  leftTeamName: string | null;
  rightTeamName: string | null;
  resultType: FinalResultType;
  winnerName: string | null;
  finalSummaryLine: string | null;
}): Promise<{ id: string } | { error: string }> {
  const {
    tournamentId,
    rosterFileName,
    roundLabel,
    leftName,
    rightName,
    leftTeamName,
    rightTeamName,
    resultType,
    winnerName,
    finalSummaryLine,
  } = params;

  const baseData = {
    tournamentId,
    rosterFileName,
    roundLabel,
    leftName,
    rightName,
    leftTeamName,
    rightTeamName,
    resultType,
    winnerName,
    isManual: false as const,
    manualDate: null as null,
    manualTime: null as null,
  };

  try {
    const row = await prisma.resultLog.create({
      data: {
        ...baseData,
        finalSummaryLine: finalSummaryLine ?? null,
      },
    });
    return { id: row.id };
  } catch (error) {
    if (isMissingResultLogColumn(error, "finalsummaryline")) {
      try {
        const row = await prisma.resultLog.create({ data: baseData });
        return { id: row.id };
      } catch (e2) {
        console.error("[api/board final_save] ResultLog create (no summary col):", e2);
      }
    } else {
      console.error("[api/board final_save] ResultLog create:", error);
    }
  }

  const id = randomUUID();
  const createdAt = new Date();
  try {
    await prisma.$executeRaw`
      INSERT INTO "ResultLog" (
        "id", "tournamentId", "rosterFileName", "roundLabel",
        "leftName", "rightName", "leftTeamName", "rightTeamName",
        "resultType", "winnerName", "isManual", "manualDate", "manualTime",
        "finalSummaryLine", "createdAt"
      ) VALUES (
        ${id}, ${tournamentId}, ${rosterFileName}, ${roundLabel},
        ${leftName}, ${rightName}, ${leftTeamName}, ${rightTeamName},
        ${resultType}, ${winnerName}, ${0}, ${null}, ${null},
        ${finalSummaryLine}, ${createdAt}
      )
    `;
    return { id };
  } catch (error) {
    console.warn("[api/board final_save] ResultLog raw insert (full):", error);
  }

  try {
    await prisma.$executeRaw`
      INSERT INTO "ResultLog" (
        "id", "tournamentId", "rosterFileName", "roundLabel",
        "leftName", "rightName", "leftTeamName", "rightTeamName",
        "resultType", "winnerName", "isManual", "manualDate", "manualTime",
        "createdAt"
      ) VALUES (
        ${id}, ${tournamentId}, ${rosterFileName}, ${roundLabel},
        ${leftName}, ${rightName}, ${leftTeamName}, ${rightTeamName},
        ${resultType}, ${winnerName}, ${0}, ${null}, ${null},
        ${createdAt}
      )
    `;
    return { id };
  } catch (error) {
    const msg = prismaErrorMessage(error);
    if (!isMissingTournamentIdColumnMessage(msg)) {
      console.error("[api/board final_save] ResultLog raw insert (minimal):", error);
      return { error: msg };
    }
  }

  // Legacy SQLite builds may not have ResultLog.tournamentId yet.
  try {
    await prisma.$executeRaw`
      INSERT INTO "ResultLog" (
        "id", "rosterFileName", "roundLabel",
        "leftName", "rightName", "leftTeamName", "rightTeamName",
        "resultType", "winnerName", "isManual", "manualDate", "manualTime",
        "finalSummaryLine", "createdAt"
      ) VALUES (
        ${id}, ${rosterFileName}, ${roundLabel},
        ${leftName}, ${rightName}, ${leftTeamName}, ${rightTeamName},
        ${resultType}, ${winnerName}, ${0}, ${null}, ${null},
        ${finalSummaryLine}, ${createdAt}
      )
    `;
    return { id };
  } catch (error) {
    console.warn(
      "[api/board final_save] ResultLog raw insert (no tournamentId, full):",
      error,
    );
  }

  try {
    await prisma.$executeRaw`
      INSERT INTO "ResultLog" (
        "id", "rosterFileName", "roundLabel",
        "leftName", "rightName", "leftTeamName", "rightTeamName",
        "resultType", "winnerName", "isManual", "manualDate", "manualTime",
        "createdAt"
      ) VALUES (
        ${id}, ${rosterFileName}, ${roundLabel},
        ${leftName}, ${rightName}, ${leftTeamName}, ${rightTeamName},
        ${resultType}, ${winnerName}, ${0}, ${null}, ${null},
        ${createdAt}
      )
    `;
    return { id };
  } catch (error) {
    const msg = prismaErrorMessage(error);
    const compat = await insertResultLogByAvailableColumns({
      id,
      tournamentId,
      rosterFileName,
      roundLabel,
      leftName,
      rightName,
      leftTeamName,
      rightTeamName,
      resultType,
      winnerName,
      finalSummaryLine,
      createdAt,
    });
    if (compat.ok) return { id };
    console.error(
      "[api/board final_save] ResultLog raw insert (no tournamentId, minimal):",
      error,
    );
    return { error: compat.error || msg };
  }
}

async function insertResultLogForMatchSummary(params: {
  tournamentId: string;
  rosterFileName: string;
  roundLabel: string;
  line: string;
}): Promise<string | null> {
  const id = randomUUID();
  const data = {
    id,
    tournamentId: params.tournamentId,
    rosterFileName: params.rosterFileName,
    roundLabel: params.roundLabel,
    leftName: params.line,
    rightName: "",
    leftTeamName: null as string | null,
    rightTeamName: null as string | null,
    resultType: "MANUAL" as FinalResultType,
    winnerName: null as string | null,
    isManual: true as const,
    manualDate: null as string | null,
    manualTime: null as string | null,
    finalSummaryLine: null as string | null,
  };
  try {
    await prisma.resultLog.create({ data });
    return id;
  } catch (error) {
    console.warn("[api/board final_save] match summary line insert failed:", error);
    return null;
  }
}

/**
 * Insert a manual one-line Results-log row with an explicit `createdAt` (used to
 * flush OT intermediate entries while preserving their original record time, so
 * the Results log shows them most-recent-first). Round label is left blank so
 * the line (which already names the OT round) renders verbatim.
 */
async function insertResultLogManualLineAt(params: {
  tournamentId: string;
  rosterFileName: string;
  line: string;
  createdAt: Date;
}): Promise<string | null> {
  const id = randomUUID();
  try {
    await prisma.resultLog.create({
      data: {
        id,
        tournamentId: params.tournamentId,
        rosterFileName: params.rosterFileName,
        roundLabel: "",
        leftName: params.line,
        rightName: "",
        leftTeamName: null,
        rightTeamName: null,
        resultType: "MANUAL" as FinalResultType,
        winnerName: null,
        isManual: true,
        manualDate: null,
        manualTime: null,
        finalSummaryLine: null,
        createdAt: params.createdAt,
      },
    });
    return id;
  } catch (error) {
    console.warn("[api/board final_save] OT intermediate flush insert failed:", error);
    return null;
  }
}

async function deleteResultLogByIdForTournament(
  resultLogId: string,
  tournamentId: string,
): Promise<void> {
  try {
    await prisma.resultLog.deleteMany({
      where: { id: resultLogId, tournamentId },
    });
  } catch (error) {
    const msg = prismaErrorMessage(error);
    if (!isMissingTournamentIdColumnMessage(msg)) throw error;
    await prisma.resultLog.deleteMany({ where: { id: resultLogId } });
  }
}

function normalizeTeamNameForCompare(name: string | null | undefined) {
  return (name ?? "").trim().toUpperCase();
}

/** Losing corner for quintet remaining (not recorded for draw / no contest). */
function losingSideForFinal(rt: FinalResultType): "left" | "right" | null {
  switch (rt) {
    case "LEFT":
    case "SUBMISSION_LEFT":
    case "ESCAPE_LEFT":
    case "DQ_RIGHT":
      return "right";
    case "RIGHT":
    case "SUBMISSION_RIGHT":
    case "ESCAPE_RIGHT":
    case "DQ_LEFT":
      return "left";
    default:
      return null;
  }
}

/** Board UI line after save: corner, team, fighter. */
function finalWinnerDisplay(
  rt: FinalResultType,
  leftTeam: string,
  leftName: string,
  rightTeam: string,
  rightName: string,
): string | null {
  switch (rt) {
    case "LEFT":
    case "SUBMISSION_LEFT":
    case "ESCAPE_LEFT":
    case "DQ_RIGHT":
      return `LEFT CORNER — ${leftTeam || "—"} — ${leftName}`;
    case "RIGHT":
    case "SUBMISSION_RIGHT":
    case "ESCAPE_RIGHT":
    case "DQ_LEFT":
      return `RIGHT CORNER — ${rightTeam || "—"} — ${rightName}`;
    default:
      return null;
  }
}

function effectiveSeconds(
  timerRunning: boolean,
  timerEndsAt: Date | null,
  timerSeconds: number,
): number {
  if (!timerRunning || !timerEndsAt) return Math.max(0, timerSeconds);
  const ms = timerEndsAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

/** JSON may deliver direction as a string; mis-parsed +/− must not flip OT mode. */
function otPlayDirectionFromUnknown(direction: unknown): 1 | -1 {
  if (direction === -1 || direction === "-1") return -1;
  const n = Number(direction);
  return n === -1 ? -1 : 1;
}

export async function GET(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const payload = await getBoardPayload(tournamentId);
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
  | { type: "set_timer_seconds"; seconds: number }
  | { type: "adjust_timer_seconds"; deltaSeconds: number }
  | { type: "begin_overtime_period" }
  | { type: "advance_overtime_minute" }
  | { type: "eliminate_left" }
  | { type: "eliminate_right" }
  | { type: "undo_eliminate_left" }
  | { type: "undo_eliminate_right" }
  | { type: "ot_round_win_left" }
  | { type: "ot_round_win_right" }
  | { type: "set_sound_10_enabled"; enabled: boolean }
  | { type: "set_sound_warning"; enabled: boolean; seconds?: number }
  | { type: "set_sound_0_enabled"; enabled: boolean }
  | { type: "play_sound_10_now" }
  | { type: "play_sound_0_now" }
  | { type: "set_timer_rest_period" }
  | { type: "set_timer_ot_countup" }
  | { type: "set_ot_play_direction"; direction: 1 | -1 }
  | { type: "ot_round_transfer_elapsed_to_main" }
  | { type: "swap_mat_corners" }
  | {
      type: "final_save";
      resultType: string;
      selectedBracketMatchId?: string | null;
    }
  | {
      /**
       * OT-round intermediate (advancing) result. Recorded ONLY to the in-card
       * OT log (not the Results log), then the clock/label advance per the OT
       * rules. `record_only` (final OT ROUND 3 ↓) logs without advancing.
       */
      type: "ot_intermediate_result";
      outcome: "SUB" | "ESC" | "DRAW";
      side?: "left" | "right" | null;
      elapsedSeconds?: number | null;
      mode: "advance" | "record_only";
      clock?: "transfer" | "oneMinute" | "none";
      nextRoundLabel?: string | null;
    }
  | { type: "ot_intermediate_unsave" }
  | { type: "final_unsave" }
  | { type: "clear_fields"; roundLabel?: string | null }
  | { type: "result_log_delete"; resultLogId: string }
  | {
      type: "result_log_manual_add";
      manualDate: string;
      manualTime: string;
      teamName: string;
      firstName: string;
      lastName: string;
    };

export async function PATCH(req: Request) {
  try {
    const tournamentId = await resolveTournamentIdFromRequest(req);
    const body = (await req.json()) as {
      leftPlayerId?: string | null;
      rightPlayerId?: string | null;
      customLeftName?: string | null;
      customLeftTeamName?: string | null;
      customRightName?: string | null;
      customRightTeamName?: string | null;
      currentRosterFileName?: string | null;
      roundLabel?: string;
      clearFinalResult?: boolean;
      resetTimerForApply?: boolean;
      command?: Command;
    };

    const state = await ensureLiveScoreboardState(tournamentId);

    const next = withOtPlayDirectionDefaults(state);
    /**
     * When false, OT secondary clock + transfer columns are omitted from the
     * Prisma update so concurrent timer/OT writes are not clobbered by stale
     * values from this request's initial read (e.g. amber APPLY with fighters).
     */
    let persistOtRoundSecondaryClock = false;
    const markPersistOtRoundSecondaryClock = () => {
      persistOtRoundSecondaryClock = true;
    };
    const bumpTimerCueNonce = () => {
      next.timerCuesResetNonce = (next.timerCuesResetNonce ?? 0) + 1;
    };
    const resetOtRoundSecondary = () => {
      markPersistOtRoundSecondaryClock();
      next.otRoundElapsedBaseSeconds = 0;
      next.otRoundElapsedRunStartedAt = null;
      next.otRoundTransferConsumed = false;
      next.otRoundTransferUndoMainSeconds = null;
      next.otRoundTransferUndoElapsedTotal = null;
    };
    const dimWinnerGlowIfFinalSaved = () => {
      if (next.finalSaved) next.showFinalWinnerHighlight = false;
    };
    /**
     * Drop a previously-captured match-end snapshot (see
     * `set_timer_rest_period`). Called whenever a fresh clock / new match
     * context is established so a stale snapshot can't attach to a later,
     * unrelated final.
     */
    const clearRecordedMatchClock = () => {
      next.recordedMatchClock = null;
      next.recordedMatchRound = null;
    };
    /** Drop the in-card OT intermediate log (new match / reset / new OT period). */
    const clearOtIntermediateLog = () => {
      (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson = null;
    };

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
    const trimmed = body.roundLabel.trim();
    const prev = next.roundLabel;
    /** Same label (e.g. fighter-only APPLY echoing the board) must not re-run OT reconcile. */
    if (prev.trim() !== trimmed) {
      const prevRoundLabelForOt = prev;
      next.roundLabel = trimmed;
      reconcileBoardStateForRoundLabelChange(prevRoundLabelForOt, next);
      markPersistOtRoundSecondaryClock();
      next.recordedMatchClock = null;
      /**
       * Entering OT from a non-OT label starts a fresh OT period: drop the
       * in-card log and reset the clock to 1:00 / ELAPSED 0 (reconcile already
       * zeroed elapsed; set the main clock + pause here).
       */
      if (
        !isOtRoundLabelFromDropdown(prevRoundLabelForOt) &&
        isOtRoundLabelFromDropdown(trimmed)
      ) {
        clearOtIntermediateLog();
        next.timerSeconds = 60;
        next.timerRunning = false;
        next.timerEndsAt = null;
        bumpTimerCueNonce();
      }
    } else if (prev !== trimmed) {
      next.roundLabel = trimmed;
    }
  }
  if (body.currentRosterFileName !== undefined) {
    const rosterName =
      typeof body.currentRosterFileName === "string"
        ? body.currentRosterFileName.trim()
        : "";
    next.currentRosterFileName = rosterName || "UNTITLED";
  }

  /**
   * APPLY clears any recorded final result so both fighter names go back to
   * white. Once the operator commits a new matchup, the previous match's
   * winner highlight (and its now-stale undo snapshot) should no longer
   * apply. The recorded results-log entry is untouched — this only resets
   * the live "this match is finalized / winner is green" state. Runs before
   * command handling so a `final_save` in the same request can re-set it.
   */
  if (body.clearFinalResult === true) {
    next.finalSaved = false;
    next.finalResultType = null;
    next.finalWinnerName = null;
    next.finalResultLogId = null;
    next.preFinalStateJson = null;
    next.showFinalWinnerHighlight = true;
  }

  /**
   * Control-card APPLY resets the live clock to 4:00 (paused) for regulation
   * rounds — finalizing a result no longer touches the clock, so this is where
   * the operator gets a fresh regulation timer for the next match. OT rounds
   * keep their own clock (the non-OT→OT entry above already sets 1:00, and
   * staying in OT must not snap to 4:00). Cue nonce bumped so the jump never
   * trips the warning / air-horn edge detector.
   */
  if (
    body.resetTimerForApply === true &&
    !isOtRoundLabelFromDropdown(next.roundLabel)
  ) {
    next.timerSeconds = 240;
    next.timerRunning = false;
    next.timerEndsAt = null;
    next.timerPhase = "REGULATION";
    next.overtimeIndex = 0;
    next.otPlayDirection = 1;
    bumpTimerCueNonce();
    clearRecordedMatchClock();
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
        if (next.overtimeIndex === -3) {
          const dir = next.otPlayDirection === -1 ? -1 : 1;
          if (dir === 1) {
            next.overtimeIndex = -2;
            next.timerSeconds = 60;
            next.timerRunning = true;
            next.timerEndsAt = new Date(Date.now() + 60 * 1000);
          } else {
            const downSec = Math.min(
              60,
              Math.max(0, sec),
            );
            if (downSec <= 0) {
              break;
            }
            next.overtimeIndex = -4;
            next.timerSeconds = downSec;
            next.timerRunning = true;
            next.timerEndsAt = new Date(Date.now() + downSec * 1000);
          }
          break;
        }
        next.timerSeconds = sec;
        next.timerRunning = true;
        next.timerEndsAt = new Date(Date.now() + Math.max(0, sec) * 1000);
        if (isOtRoundLabelFromDropdown(next.roundLabel)) {
          markPersistOtRoundSecondaryClock();
          next.otRoundElapsedRunStartedAt = new Date();
        }
        break;
      }
      case "timer_pause": {
        if (isOtRoundLabelFromDropdown(next.roundLabel)) {
          markPersistOtRoundSecondaryClock();
          if (next.timerRunning && next.otRoundElapsedRunStartedAt) {
            const delta = Math.floor(
              (Date.now() - next.otRoundElapsedRunStartedAt.getTime()) / 1000,
            );
            next.otRoundElapsedBaseSeconds = Math.max(
              0,
              next.otRoundElapsedBaseSeconds + delta,
            );
          }
          next.otRoundElapsedRunStartedAt = null;
        }
        next.timerSeconds = sec;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "reset_match": {
        bumpTimerCueNonce();
        next.timerSeconds = 240;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.timerPhase = "REGULATION";
        next.overtimeIndex = 0;
        next.otPlayDirection = 1;
        next.overtimeWinsLeft = 0;
        next.overtimeWinsRight = 0;
        next.leftEliminatedCount = 0;
        next.rightEliminatedCount = 0;
        next.leftPlayerId = null;
        next.rightPlayerId = null;
        next.customLeftName = null;
        next.customLeftTeamName = null;
        next.customRightName = null;
        next.customRightTeamName = null;
        resetOtRoundSecondary();
        clearRecordedMatchClock();
        clearOtIntermediateLog();
        next.showFinalWinnerHighlight = true;
        break;
      }
      case "reset_timer_regulation": {
        bumpTimerCueNonce();
        resetOtRoundSecondary();
        clearRecordedMatchClock();
        dimWinnerGlowIfFinalSaved();
        next.timerSeconds = 240;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.otPlayDirection = 1;
        if (isOtRoundLabelFromDropdown(next.roundLabel)) {
          next.timerPhase = "OVERTIME";
          next.overtimeIndex = otRoundIndexFromLabel(next.roundLabel) ?? 1;
        } else {
          next.timerPhase = "REGULATION";
          next.overtimeIndex = 0;
        }
        break;
      }
      case "reset_timer_overtime": {
        bumpTimerCueNonce();
        resetOtRoundSecondary();
        clearRecordedMatchClock();
        dimWinnerGlowIfFinalSaved();
        next.timerSeconds = 60;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.otPlayDirection = 1;
        if (isOtRoundLabelFromDropdown(next.roundLabel)) {
          next.timerPhase = "OVERTIME";
          next.overtimeIndex = otRoundIndexFromLabel(next.roundLabel) ?? 1;
        } else {
          next.timerPhase = "REGULATION";
          next.overtimeIndex = 0;
        }
        break;
      }
      case "set_timer_seconds": {
        if (!Number.isFinite(cmd.seconds)) break;
        const clamped = Math.max(
          0,
          Math.min(24 * 3600, Math.trunc(cmd.seconds)),
        );
        bumpTimerCueNonce();
        resetOtRoundSecondary();
        clearRecordedMatchClock();
        if (clamped === 300 || clamped === 240 || clamped === 60) {
          dimWinnerGlowIfFinalSaved();
        }
        next.timerSeconds = clamped;
        next.timerRunning = false;
        next.timerEndsAt = null;
        if (isOtRoundLabelFromDropdown(next.roundLabel)) {
          next.timerPhase = "OVERTIME";
          next.overtimeIndex = otRoundIndexFromLabel(next.roundLabel) ?? 1;
        } else {
          next.timerPhase = "REGULATION";
          next.overtimeIndex = 0;
        }
        next.otPlayDirection = 1;
        break;
      }
      case "set_timer_rest_period": {
        /**
         * Preserve the match-end clock. The operator starts this 0:30 rest
         * timer (to sync with the live event) *before* saving the final, which
         * would otherwise overwrite the match clock with the rest countdown —
         * and `resetOtRoundSecondary()` below wipes any OT-round elapsed time.
         * Snapshot the current match clock/elapsed now (only when entering rest
         * from a non-rest state) so `final_save` can reuse it. Cleared on save,
         * reset, and whenever a fresh clock is set.
         */
        if (next.overtimeIndex !== -1) {
          const otRoundNow = isOtRoundLabelFromDropdown(next.roundLabel);
          const otElapsedNow = otRoundNow
            ? effectiveOtRoundElapsedSeconds({
                otRoundElapsedBaseSeconds: next.otRoundElapsedBaseSeconds,
                otRoundElapsedRunStartedAt: next.otRoundElapsedRunStartedAt,
                timerRunning: next.timerRunning,
              })
            : null;
          next.recordedMatchClock = formatMatchClockForResultSummary(
            next.overtimeIndex,
            next.timerRunning,
            next.timerEndsAt,
            next.timerSeconds,
            otElapsedNow != null
              ? { otRoundElapsedSeconds: otElapsedNow }
              : undefined,
          );
          // Capture the real round now, before overtimeIndex becomes -1 (which
          // would otherwise make the final read "REST PERIOD").
          next.recordedMatchRound = resultRoundLabelForResultLog({
            overtimeIndex: next.overtimeIndex,
            roundLabel: next.roundLabel,
          });
        }
        bumpTimerCueNonce();
        resetOtRoundSecondary();
        next.timerSeconds = 30;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.timerPhase = "REGULATION";
        next.overtimeIndex = -1;
        next.otPlayDirection = 1;
        break;
      }
      case "adjust_timer_seconds": {
        if (!Number.isFinite(cmd.deltaSeconds)) break;
        const delta = Math.trunc(cmd.deltaSeconds);
        let adjusted = Math.max(0, sec + delta);
        if (
          next.overtimeIndex === -2 ||
          next.overtimeIndex === -3 ||
          next.overtimeIndex === -4
        ) {
          adjusted = Math.min(60, adjusted);
        }
        bumpTimerCueNonce();
        next.timerSeconds = adjusted;
        if (next.timerRunning) {
          next.timerEndsAt = new Date(Date.now() + adjusted * 1000);
        } else {
          next.timerEndsAt = null;
        }
        break;
      }
      case "set_timer_ot_countup": {
        bumpTimerCueNonce();
        resetOtRoundSecondary();
        clearRecordedMatchClock();
        next.timerSeconds = 0;
        next.timerRunning = false;
        next.timerEndsAt = null;
        next.timerPhase = "REGULATION";
        next.overtimeIndex = -3;
        next.otPlayDirection = 1;
        break;
      }
      case "set_ot_play_direction": {
        bumpTimerCueNonce();
        const dir = otPlayDirectionFromUnknown(cmd.direction);
        const oi = next.overtimeIndex;
        const secSnap = effectiveSeconds(
          next.timerRunning,
          next.timerEndsAt,
          next.timerSeconds,
        );
        const paused = !next.timerRunning;

        if (oi === -3) {
          const wallSec = Math.min(60, Math.max(0, secSnap));
          next.otPlayDirection = dir;
          // +/− only switch count-up vs count-down arm; preserve wall time.
          // `set_timer_ot_countup` (OT button) is the path that resets to +0:00.
          next.timerSeconds = wallSec;
          next.timerRunning = false;
          next.timerEndsAt = null;
          break;
        }

        // Paused OT minute (−2 count-up / −4 count-down): +/− re-arms so the
        // control reacts instead of no-op while otMode is still true.
        if (paused && (oi === -2 || oi === -4)) {
          const wallSec =
            oi === -2
              ? Math.min(60, Math.max(0, 60 - secSnap))
              : Math.min(60, Math.max(0, secSnap));
          next.overtimeIndex = -3;
          next.otPlayDirection = dir;
          next.timerSeconds = wallSec;
          next.timerRunning = false;
          next.timerEndsAt = null;
          break;
        }

        break;
      }
      case "begin_overtime_period": {
        bumpTimerCueNonce();
        clearRecordedMatchClock();
        next.timerPhase = "OVERTIME";
        next.overtimeIndex = next.overtimeIndex <= 0 ? 1 : next.overtimeIndex;
        next.timerSeconds = 60;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "advance_overtime_minute": {
        bumpTimerCueNonce();
        if (next.timerPhase !== "OVERTIME") break;
        if (next.overtimeIndex >= 3) break;
        clearRecordedMatchClock();
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
      case "set_sound_10_enabled": {
        next.sound10Enabled = Boolean(cmd.enabled);
        break;
      }
      case "set_sound_warning": {
        next.sound10Enabled = Boolean(cmd.enabled);
        if (typeof cmd.seconds === "number" && Number.isFinite(cmd.seconds)) {
          next.soundWarningSeconds = Math.max(1, Math.min(99, Math.trunc(cmd.seconds)));
        }
        break;
      }
      case "set_sound_0_enabled": {
        next.sound0Enabled = Boolean(cmd.enabled);
        break;
      }
      case "play_sound_10_now": {
        next.sound10PlayNonce = (next.sound10PlayNonce ?? 0) + 1;
        break;
      }
      case "play_sound_0_now": {
        next.sound0PlayNonce = (next.sound0PlayNonce ?? 0) + 1;
        break;
      }
      case "ot_round_transfer_elapsed_to_main": {
        if (!isOtRoundLabelFromDropdown(next.roundLabel)) break;
        if (next.timerRunning) break;
        markPersistOtRoundSecondaryClock();
        /**
         * v1.2.6: the OT "transfer ELAPSED → main clock" left-arrow
         * button is functionally a "start the next OT sub-round" so
         * we treat it the same as `reset_timer_regulation` for the
         * winner-name green highlight: dim the highlight if a final
         * is saved, so the overlay stops painting the previous round's
         * winner once the operator advances to the next sub-round.
         */
        dimWinnerGlowIfFinalSaved();
        if (next.otRoundTransferConsumed) {
          const backMain = next.otRoundTransferUndoMainSeconds;
          const backElapsed = next.otRoundTransferUndoElapsedTotal;
          bumpTimerCueNonce();
          if (
            backMain != null &&
            Number.isFinite(backMain) &&
            backElapsed != null &&
            Number.isFinite(backElapsed)
          ) {
            next.timerSeconds = Math.max(
              0,
              Math.min(24 * 3600, Math.trunc(backMain)),
            );
            next.otRoundElapsedBaseSeconds = Math.max(
              0,
              Math.trunc(backElapsed),
            );
          }
          next.otRoundElapsedRunStartedAt = null;
          next.otRoundTransferConsumed = false;
          next.otRoundTransferUndoMainSeconds = null;
          next.otRoundTransferUndoElapsedTotal = null;
          next.timerRunning = false;
          next.timerEndsAt = null;
          break;
        }
        const el = otRoundElapsedTotalFromAnchoredBase({
          otRoundElapsedBaseSeconds: next.otRoundElapsedBaseSeconds,
          otRoundElapsedRunStartedAt: next.otRoundElapsedRunStartedAt,
        });
        bumpTimerCueNonce();
        next.otRoundTransferUndoMainSeconds = Math.max(
          0,
          Math.min(24 * 3600, sec),
        );
        next.otRoundTransferUndoElapsedTotal = Math.max(0, el);
        next.timerSeconds = Math.max(0, Math.min(24 * 3600, el));
        next.otRoundElapsedBaseSeconds = 0;
        next.otRoundElapsedRunStartedAt = null;
        next.otRoundTransferConsumed = true;
        next.timerRunning = false;
        next.timerEndsAt = null;
        break;
      }
      case "swap_mat_corners": {
        if (next.finalSaved) {
          return NextResponse.json(
            {
              error:
                "Unsave the recorded final before swapping corners, or clear the board.",
            },
            { status: 400 },
          );
        }
        const lp = next.leftPlayerId;
        next.leftPlayerId = next.rightPlayerId;
        next.rightPlayerId = lp;
        const cln = next.customLeftName;
        next.customLeftName = next.customRightName;
        next.customRightName = cln;
        const clt = next.customLeftTeamName;
        next.customLeftTeamName = next.customRightTeamName;
        next.customRightTeamName = clt;
        const le = next.leftEliminatedCount;
        next.leftEliminatedCount = next.rightEliminatedCount;
        next.rightEliminatedCount = le;
        const owl = next.overtimeWinsLeft;
        next.overtimeWinsLeft = next.overtimeWinsRight;
        next.overtimeWinsRight = owl;
        break;
      }
      case "clear_fields": {
        next.leftPlayerId = null;
        next.rightPlayerId = null;
        next.customLeftName = null;
        next.customLeftTeamName = null;
        next.customRightName = null;
        next.customRightTeamName = null;
        clearRecordedMatchClock();
        clearOtIntermediateLog();
        const prevRlClear = next.roundLabel;
        next.roundLabel =
          typeof cmd.roundLabel === "string" && cmd.roundLabel.trim()
            ? cmd.roundLabel.trim()
            : "Quarter Finals";
        reconcileBoardStateForRoundLabelChange(prevRlClear, next);
        next.leftEliminatedCount = 0;
        next.rightEliminatedCount = 0;
        next.finalSaved = false;
        next.finalResultType = null;
        next.finalWinnerName = null;
        next.finalResultLogId = null;
        next.preFinalStateJson = null;
        resetOtRoundSecondary();
        next.showFinalWinnerHighlight = true;
        break;
      }
      case "final_save": {
        if (!FINAL_SAVE_TYPES.has(cmd.resultType)) {
          return NextResponse.json(
            { error: "Invalid final result type" },
            { status: 400 },
          );
        }
        const rt = cmd.resultType as FinalResultType;
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

        const leftTeamName =
          next.customLeftTeamName?.trim() || leftP?.team.name || "";
        const rightTeamName =
          next.customRightTeamName?.trim() || rightP?.team.name || "";
        const winnerName = winnerNameForFinal(rt, leftName, rightName);

        const savedAt = new Date();
        const leftFighter = fighterSummaryFromPlayerOrCustom(
          next.customLeftName,
          next.customLeftTeamName,
          leftP,
        );
        const rightFighter = fighterSummaryFromPlayerOrCustom(
          next.customRightName,
          next.customRightTeamName,
          rightP,
        );
        const otRoundForSave = isOtRoundLabelFromDropdown(next.roundLabel);
        const otElapsedSnap = otRoundForSave
          ? effectiveOtRoundElapsedSeconds({
              otRoundElapsedBaseSeconds: next.otRoundElapsedBaseSeconds,
              otRoundElapsedRunStartedAt: next.otRoundElapsedRunStartedAt,
              timerRunning: next.timerRunning,
            })
          : null;
        const liveClockSnap = formatMatchClockForResultSummary(
          next.overtimeIndex,
          next.timerRunning,
          next.timerEndsAt,
          next.timerSeconds,
          otElapsedSnap != null
            ? { otRoundElapsedSeconds: otElapsedSnap }
            : undefined,
        );
        /**
         * Prefer the clock captured when the operator started the rest timer
         * (the true match-end time) over the live clock, which by now reflects
         * the 0:30 rest countdown. Consumed below so it can't leak to the next
         * match. The verb stays correct because `roundLabel` is unchanged by
         * the rest transition (OT-round labels still resolve to "elapsed").
         */
        const recordedClock =
          typeof next.recordedMatchClock === "string" &&
          next.recordedMatchClock.trim()
            ? next.recordedMatchClock.trim()
            : null;
        const clockSnap = recordedClock ?? liveClockSnap;
        next.recordedMatchClock = null;
        /**
         * Same rationale as the clock: if the operator started the rest timer
         * before saving, overtimeIndex is now -1 and would label the result
         * "REST PERIOD". Prefer the round captured at rest-start.
         */
        const recordedRound =
          typeof next.recordedMatchRound === "string" &&
          next.recordedMatchRound.trim()
            ? next.recordedMatchRound.trim()
            : null;
        next.recordedMatchRound = null;
        const resultRound =
          recordedRound ??
          resultRoundLabelForResultLog({
            overtimeIndex: next.overtimeIndex,
            roundLabel: next.roundLabel,
          });
        const finalSummaryLine = buildFinalSummaryLine(
          savedAt,
          rt,
          leftFighter,
          rightFighter,
          resultRound,
          clockSnap,
          otRoundForSave ? "elapsed" : "clock",
        );

        // Capture merged board state *before* final bump (same request body as fighters).
        const snapshot: PreFinalSnapshot = {
          leftPlayerId: next.leftPlayerId,
          rightPlayerId: next.rightPlayerId,
          customLeftName: next.customLeftName,
          customLeftTeamName: next.customLeftTeamName,
          customRightName: next.customRightName,
          customRightTeamName: next.customRightTeamName,
          currentRosterFileName: next.currentRosterFileName,
          roundLabel: next.roundLabel,
          leftEliminatedCount: next.leftEliminatedCount,
          rightEliminatedCount: next.rightEliminatedCount,
          matchSummaryResultLogId: null,
          bracketMatchId: null,
          bracketWinnerTeamIdBefore: null,
          showFinalWinnerHighlight: next.showFinalWinnerHighlight,
        };

        const lose = losingSideForFinal(rt);
        let newLeftElim = next.leftEliminatedCount;
        let newRightElim = next.rightEliminatedCount;
        /** OT round finals are not quintet elimination — do not advance body X marks. */
        if (!otRoundForSave) {
          if (lose === "left") {
            newLeftElim = Math.min(5, newLeftElim + 1);
          } else if (lose === "right") {
            newRightElim = Math.min(5, newRightElim + 1);
          } else if (rt === "DRAW") {
            /**
             * v1.2.6: regulation-round draw eliminates a player from
             * BOTH teams (each side fields a fresh fighter for the
             * next round), so paint a red X on both health bars.
             * Skipped during OT (matches the existing OT exemption
             * above) because OT is sudden-death — a draw there does
             * not consume bodies from the quintet.
             */
            newLeftElim = Math.min(5, newLeftElim + 1);
            newRightElim = Math.min(5, newRightElim + 1);
          }
        }

        const insertResult = await insertResultLogForFinal({
          tournamentId,
          rosterFileName: next.currentRosterFileName,
          roundLabel: resultRound,
          leftName,
          rightName,
          leftTeamName: leftTeamName || null,
          rightTeamName: rightTeamName || null,
          resultType: rt,
          winnerName,
          finalSummaryLine,
        });

        if ("error" in insertResult) {
          return NextResponse.json(
            {
              error:
                "Could not save the result to the event log (database write failed).",
              detail: insertResult.error,
            },
            { status: 500 },
          );
        }

        const created = insertResult;
        /**
         * An OT-round ender (OT-SUB / OT-ESC / OT-WinByDQ) decides the whole
         * team match by corner, not by quintet eliminations (OT does not paint
         * body X's). For regulation results the team match is over once a side
         * reaches 5 eliminations.
         */
        const otEnderWinnerSide = otRoundForSave
          ? winnerSideForResult(rt)
          : null;
        const isMatchComplete = otRoundForSave
          ? otEnderWinnerSide !== null
          : newLeftElim >= 5 || newRightElim >= 5;
        /**
         * v1.2.6: a regulation draw that takes BOTH teams to 5 elims
         * at the same time leaves the bracket winner ambiguous; do not
         * auto-pick a side (it now advances to OT — see below). The
         * "first to 5 alone" logic still drives normal auto-advance; an OT
         * ender supplies the winner side directly.
         */
        const matchWinnerSide = otRoundForSave
          ? otEnderWinnerSide
          : newLeftElim >= 5 && newRightElim >= 5
            ? null
            : newLeftElim >= 5
              ? "right"
              : newRightElim >= 5
                ? "left"
                : null;
        const matchWinnerTeam =
          matchWinnerSide === "left"
            ? leftTeamName.trim()
            : matchWinnerSide === "right"
              ? rightTeamName.trim()
              : "";
        const matchLoserTeam =
          matchWinnerSide === "left"
            ? rightTeamName.trim()
            : matchWinnerSide === "right"
              ? leftTeamName.trim()
              : "";

        if (isMatchComplete && matchWinnerTeam && matchLoserTeam) {
          const round = resultRound.trim().toUpperCase();
          const roundSuffix = round ? ` — ${round}` : "";
          const summaryLine = `${formatTime12h(savedAt)} ${matchWinnerTeam.toUpperCase()} def. ${matchLoserTeam.toUpperCase()}${roundSuffix}`;
          const matchSummaryId = await insertResultLogForMatchSummary({
            tournamentId,
            rosterFileName: next.currentRosterFileName,
            roundLabel: resultRound,
            line: summaryLine,
          });
          snapshot.matchSummaryResultLogId = matchSummaryId;
        }

        const selectedBracketMatchId =
          typeof cmd.selectedBracketMatchId === "string"
            ? cmd.selectedBracketMatchId.trim()
            : "";
        if (isMatchComplete && selectedBracketMatchId && matchWinnerTeam) {
          try {
            const m = await prisma.bracketMatch.findUnique({
              where: { id: selectedBracketMatchId },
              include: {
                event: { select: { tournamentId: true } },
                homeTeam: { select: { id: true, name: true } },
                awayTeam: { select: { id: true, name: true } },
              },
            });
            if (m && m.event.tournamentId === tournamentId) {
              snapshot.bracketMatchId = m.id;
              snapshot.bracketWinnerTeamIdBefore = m.winnerTeamId ?? null;
              const target = normalizeTeamNameForCompare(matchWinnerTeam);
              const homeNorm = normalizeTeamNameForCompare(m.homeTeam.name);
              const awayNorm = normalizeTeamNameForCompare(m.awayTeam.name);
              const winnerTeamId =
                homeNorm === target ? m.homeTeam.id : awayNorm === target ? m.awayTeam.id : null;
              if (winnerTeamId) {
                await setBracketMatchWinner(selectedBracketMatchId, winnerTeamId);
              }
            }
          } catch (error) {
            console.warn("[api/board final_save] bracket winner sync failed:", error);
          }
        }

        next.leftEliminatedCount = newLeftElim;
        next.rightEliminatedCount = newRightElim;

        /**
         * Dual-sweep draw → overtime. A regulation DRAW at 4-4 takes BOTH teams
         * to 5 eliminations, so there is no quintet winner: the team match is
         * decided in overtime. Advance the round label to OT ROUND 1 (top),
         * reset into a fresh OT period (1:00 clock, paused, ELAPSED 0, in-card
         * OT log cleared), and let the operator pick OT representatives. The
         * draw itself is still recorded above; the operator's next APPLY clears
         * the finalized state. (The control card clears its fighter dropdowns.)
         */
        const triggeredOtFromDraw =
          !otRoundForSave &&
          rt === "DRAW" &&
          newLeftElim >= 5 &&
          newRightElim >= 5;
        if (triggeredOtFromDraw) {
          const prevRoundLabelForOt = next.roundLabel;
          next.roundLabel = "OT ROUND1 ↑";
          reconcileBoardStateForRoundLabelChange(prevRoundLabelForOt, next);
          markPersistOtRoundSecondaryClock();
          clearOtIntermediateLog();
          next.timerSeconds = 60;
          next.timerRunning = false;
          next.timerEndsAt = null;
          next.recordedMatchClock = null;
          next.recordedMatchRound = null;
          bumpTimerCueNonce();
        }

        next.finalSaved = true;
        next.showFinalWinnerHighlight = true;
        next.finalResultType = rt;
        next.finalWinnerName =
          finalWinnerDisplay(
            rt,
            leftTeamName,
            leftName,
            rightTeamName,
            rightName,
          ) ?? winnerName;
        next.finalResultLogId = created.id;

        /**
         * OT-ender flush: when the final winner is recorded during an OT round,
         * move the in-card intermediate log into the Results log (most-recent
         * first — the log is read DESC by createdAt) and clear it. We record the
         * inserted row ids and the pre-flush log JSON into the snapshot so
         * `final_unsave` can delete those rows and restore the in-card log.
         */
        if (otRoundForSave) {
          const logJsonBefore =
            (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson ??
            null;
          const entries = parseOtIntermediateLog(logJsonBefore);
          const flushedIds: string[] = [];
          if (entries.length > 0) {
            for (const entry of entries) {
              const entryCreatedAt = entry.createdAt
                ? new Date(entry.createdAt)
                : new Date();
              const insertedId = await insertResultLogManualLineAt({
                tournamentId,
                rosterFileName: next.currentRosterFileName,
                line: formatOtIntermediateLine(entry),
                createdAt: Number.isNaN(entryCreatedAt.getTime())
                  ? new Date()
                  : entryCreatedAt,
              });
              if (insertedId) flushedIds.push(insertedId);
            }
          }
          snapshot.otFlushResultLogIds = flushedIds;
          snapshot.otIntermediateLogJsonBefore = logJsonBefore;
          (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson =
            null;
        }
        /**
         * Finalizing no longer touches the live clock — the operator resets it
         * to 4:00 explicitly via the control-card APPLY (see the `applyFighters`
         * path / `reset_timer_regulation`). This keeps the match-end clock
         * visible after a final result instead of snapping to 4:00.
         */

        const snapshotJson = JSON.stringify(snapshot);
        next.preFinalStateJson = snapshotJson;
        break;
      }
      case "ot_intermediate_result": {
        if (!isOtRoundLabelFromDropdown(next.roundLabel)) {
          return NextResponse.json(
            { error: "Not in an OT round" },
            { status: 400 },
          );
        }
        const outcome = cmd.outcome;
        if (outcome !== "SUB" && outcome !== "ESC" && outcome !== "DRAW") {
          return NextResponse.json(
            { error: "Invalid OT intermediate result" },
            { status: 400 },
          );
        }
        const side =
          cmd.side === "left" || cmd.side === "right" ? cmd.side : null;
        const elapsedSeconds =
          typeof cmd.elapsedSeconds === "number" &&
          Number.isFinite(cmd.elapsedSeconds)
            ? Math.max(0, Math.trunc(cmd.elapsedSeconds))
            : null;

        /** Resolve the acting fighter's display name (for the log line). */
        let playerName = "";
        if (side === "left") {
          const lp = next.leftPlayerId
            ? await prisma.player.findUnique({ where: { id: next.leftPlayerId } })
            : null;
          playerName =
            next.customLeftName?.trim() ||
            (lp ? `${lp.firstName} ${lp.lastName}`.trim() : "");
        } else if (side === "right") {
          const rp = next.rightPlayerId
            ? await prisma.player.findUnique({ where: { id: next.rightPlayerId } })
            : null;
          playerName =
            next.customRightName?.trim() ||
            (rp ? `${rp.firstName} ${rp.lastName}`.trim() : "");
        }

        /** Snapshot pre-save board values so an unsave can revert this advance. */
        const otElapsedBeforeSave = effectiveOtRoundElapsedSeconds({
          otRoundElapsedBaseSeconds: next.otRoundElapsedBaseSeconds,
          otRoundElapsedRunStartedAt: next.otRoundElapsedRunStartedAt,
          timerRunning: next.timerRunning,
        });
        const entry: OtIntermediateEntry = {
          roundLabel: next.roundLabel.trim(),
          side: outcome === "DRAW" ? null : side,
          playerName: outcome === "DRAW" ? "" : playerName,
          kind: outcome,
          elapsedSeconds: outcome === "DRAW" ? null : elapsedSeconds,
          createdAt: new Date().toISOString(),
          restore: {
            roundLabel: next.roundLabel,
            timerSeconds: next.timerSeconds,
            otElapsedSeconds: otElapsedBeforeSave,
          },
        };
        const log = parseOtIntermediateLog(
          (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson,
        );
        log.push(entry);
        (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson =
          JSON.stringify(log);

        if (cmd.mode === "advance") {
          const clockMode = cmd.clock ?? "oneMinute";
          if (clockMode === "transfer") {
            next.timerSeconds = Math.min(
              24 * 3600,
              Math.max(0, elapsedSeconds ?? 0),
            );
          } else if (clockMode === "oneMinute") {
            next.timerSeconds = 60;
          }
          next.timerRunning = false;
          next.timerEndsAt = null;
          next.otRoundElapsedBaseSeconds = 0;
          next.otRoundElapsedRunStartedAt = null;
          next.otRoundTransferConsumed = false;
          next.otRoundTransferUndoMainSeconds = null;
          next.otRoundTransferUndoElapsedTotal = null;
          markPersistOtRoundSecondaryClock();
          const nextLabel =
            typeof cmd.nextRoundLabel === "string" && cmd.nextRoundLabel.trim()
              ? cmd.nextRoundLabel.trim()
              : null;
          if (nextLabel && nextLabel !== next.roundLabel.trim()) {
            const prevLabel = next.roundLabel;
            next.roundLabel = nextLabel;
            reconcileBoardStateForRoundLabelChange(prevLabel, next);
            /** A fresh OT half always starts at ELAPSED 0 (reconcile keeps it for OT→OT). */
            next.otRoundElapsedBaseSeconds = 0;
            next.otRoundElapsedRunStartedAt = null;
          }
          bumpTimerCueNonce();
        }
        /** mode === "record_only": log only (OT ROUND 3 ↓ unexpected). */
        break;
      }
      case "ot_intermediate_unsave": {
        const log = parseOtIntermediateLog(
          (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson,
        );
        const last = log.pop();
        if (!last) break;
        (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson =
          log.length > 0 ? JSON.stringify(log) : null;
        /** Revert this entry's advance: restore clock, ELAPSED, and round label. */
        if (last.restore) {
          const prevLabel = next.roundLabel;
          const targetLabel = last.restore.roundLabel.trim();
          if (targetLabel && targetLabel !== prevLabel.trim()) {
            next.roundLabel = targetLabel;
            reconcileBoardStateForRoundLabelChange(prevLabel, next);
          }
          next.timerSeconds = Math.max(
            0,
            Math.min(24 * 3600, Math.trunc(last.restore.timerSeconds)),
          );
          next.timerRunning = false;
          next.timerEndsAt = null;
          next.otRoundElapsedBaseSeconds = Math.max(
            0,
            Math.trunc(last.restore.otElapsedSeconds),
          );
          next.otRoundElapsedRunStartedAt = null;
          next.otRoundTransferConsumed = false;
          next.otRoundTransferUndoMainSeconds = null;
          next.otRoundTransferUndoElapsedTotal = null;
          markPersistOtRoundSecondaryClock();
          bumpTimerCueNonce();
        }
        break;
      }
      case "final_unsave": {
        if (!state.finalSaved) break;
        if (state.finalResultLogId) {
          await deleteResultLogByIdForTournament(state.finalResultLogId, tournamentId);
        }
        try {
          const snap = state.preFinalStateJson
            ? (JSON.parse(state.preFinalStateJson) as PreFinalSnapshot)
            : null;
          if (snap) {
            if (snap.matchSummaryResultLogId) {
              await deleteResultLogByIdForTournament(
                snap.matchSummaryResultLogId,
                tournamentId,
              );
            }
            if (snap.bracketMatchId) {
              try {
                await setBracketMatchWinner(
                  snap.bracketMatchId,
                  snap.bracketWinnerTeamIdBefore ?? null,
                );
              } catch (error) {
                console.warn(
                  "[api/board final_unsave] bracket winner restore failed:",
                  error,
                );
              }
            }
            if (snap.leftPlayerId !== undefined) {
              next.leftPlayerId = snap.leftPlayerId;
            }
            if (snap.rightPlayerId !== undefined) {
              next.rightPlayerId = snap.rightPlayerId;
            }
            if (snap.customLeftName !== undefined) {
              next.customLeftName = snap.customLeftName;
            }
            if (snap.customLeftTeamName !== undefined) {
              next.customLeftTeamName = snap.customLeftTeamName;
            }
            if (snap.customRightName !== undefined) {
              next.customRightName = snap.customRightName;
            }
            if (snap.customRightTeamName !== undefined) {
              next.customRightTeamName = snap.customRightTeamName;
            }
            if (
              typeof snap.currentRosterFileName === "string" &&
              snap.currentRosterFileName.trim()
            ) {
              next.currentRosterFileName = snap.currentRosterFileName.trim();
            }
            if (typeof snap.roundLabel === "string" && snap.roundLabel.trim()) {
              next.roundLabel = snap.roundLabel.trim();
            }
            if (
              typeof snap.leftEliminatedCount === "number" &&
              Number.isFinite(snap.leftEliminatedCount)
            ) {
              next.leftEliminatedCount = Math.max(
                0,
                Math.min(5, Math.trunc(snap.leftEliminatedCount)),
              );
            }
            if (
              typeof snap.rightEliminatedCount === "number" &&
              Number.isFinite(snap.rightEliminatedCount)
            ) {
              next.rightEliminatedCount = Math.max(
                0,
                Math.min(5, Math.trunc(snap.rightEliminatedCount)),
              );
            }
            if (typeof snap.showFinalWinnerHighlight === "boolean") {
              next.showFinalWinnerHighlight = snap.showFinalWinnerHighlight;
            } else {
              next.showFinalWinnerHighlight = true;
            }
            /**
             * OT-ender unsave: remove the intermediate rows that were flushed
             * into the Results log and put the in-card OT log back so the
             * operator can re-record the final result.
             */
            if (Array.isArray(snap.otFlushResultLogIds)) {
              for (const id of snap.otFlushResultLogIds) {
                if (typeof id === "string" && id) {
                  await deleteResultLogByIdForTournament(id, tournamentId);
                }
              }
            }
            if (snap.otIntermediateLogJsonBefore !== undefined) {
              (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson =
                snap.otIntermediateLogJsonBefore;
            }
          }
        } catch (e) {
          console.warn("[api/board final_unsave] bad preFinalStateJson:", e);
        }
        next.finalSaved = false;
        next.finalResultType = null;
        next.finalWinnerName = null;
        next.finalResultLogId = null;
        next.preFinalStateJson = null;
        break;
      }
      case "result_log_delete": {
        const id =
          typeof cmd.resultLogId === "string" ? cmd.resultLogId.trim() : "";
        if (!id) break;
        try {
          await prisma.resultLog.deleteMany({
            where: { id, tournamentId },
          });
        } catch (err) {
          const msg = prismaErrorMessage(err);
          if (!isMissingTournamentIdColumnMessage(msg)) {
            console.error("[api/board result_log_delete]", err);
            break;
          }
          await prisma.resultLog.deleteMany({ where: { id } });
        }
        break;
      }
      case "result_log_manual_add": {
        const team = cmd.teamName.trim().toUpperCase();
        const first = cmd.firstName.trim().toUpperCase();
        const last = cmd.lastName.trim().toUpperCase();
        const d = cmd.manualDate.trim();
        const t = cmd.manualTime.trim();
        if (!team || !first || !last) {
          return NextResponse.json(
            { error: "Team, first name, and last name are required" },
            { status: 400 },
          );
        }
        const fighter = `${first} ${last}`.trim();
        try {
          await prisma.resultLog.create({
            data: {
              tournamentId,
              rosterFileName: next.currentRosterFileName,
              roundLabel: "MANUAL",
              leftName: fighter,
              rightName: team,
              leftTeamName: null,
              rightTeamName: null,
              resultType: "MANUAL",
              winnerName: null,
              isManual: true,
              manualDate: d || null,
              manualTime: t || null,
            },
          });
        } catch (error) {
          console.error("[api/board result_log_manual_add] ResultLog create:", error);
        }
        break;
      }
      default:
        break;
    }
  }

  if (
    next.timerRunning &&
    next.timerEndsAt &&
    next.timerEndsAt.getTime() <= Date.now()
  ) {
    next.timerSeconds = 0;
    next.timerRunning = false;
    next.timerEndsAt = null;
    if (isOtRoundLabelFromDropdown(next.roundLabel) && next.otRoundElapsedRunStartedAt) {
      markPersistOtRoundSecondaryClock();
      const delta = Math.floor(
        (Date.now() - next.otRoundElapsedRunStartedAt.getTime()) / 1000,
      );
      next.otRoundElapsedBaseSeconds = Math.max(0, next.otRoundElapsedBaseSeconds + delta);
      next.otRoundElapsedRunStartedAt = null;
    }
  }

  if (foldOtRoundElapsedOrphanAnchorWhenPaused(next)) {
    markPersistOtRoundSecondaryClock();
  }

  await prisma.liveScoreboardState.update({
    where: { tournamentId },
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
      sound10Enabled: next.sound10Enabled,
      soundWarningSeconds: next.soundWarningSeconds,
      sound0Enabled: next.sound0Enabled,
      sound10PlayNonce: next.sound10PlayNonce,
      sound0PlayNonce: next.sound0PlayNonce,
      otPlayDirection: next.otPlayDirection,
      ...(persistOtRoundSecondaryClock
        ? {
            otRoundElapsedBaseSeconds: next.otRoundElapsedBaseSeconds,
            otRoundElapsedRunStartedAt: next.otRoundElapsedRunStartedAt,
            otRoundTransferConsumed: next.otRoundTransferConsumed,
            otRoundTransferUndoMainSeconds: next.otRoundTransferUndoMainSeconds,
            otRoundTransferUndoElapsedTotal: next.otRoundTransferUndoElapsedTotal,
          }
        : {}),
      showFinalWinnerHighlight: next.showFinalWinnerHighlight,
      timerCuesResetNonce: next.timerCuesResetNonce,
      recordedMatchClock: next.recordedMatchClock ?? null,
      recordedMatchRound: next.recordedMatchRound ?? null,
      otIntermediateLogJson:
        (next as { otIntermediateLogJson?: string | null }).otIntermediateLogJson ??
        null,
    },
  });

  const payload = await getBoardPayload(tournamentId);
  return NextResponse.json(payload);
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
