"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import {
  MATBEAST_TOURNAMENT_HEADER,
  matbeastFetch,
} from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { formatControlCardFinalHeader } from "@/lib/control-final-header";
import { openScoreboardOverlayWindow } from "@/lib/open-scoreboard-overlay";
import {
  primeTimerAlertAudioFromUserGesture,
  useTimerAlertSounds,
} from "@/hooks/useTimerAlertSounds";
import {
  OVERLAY_APPLY_PROPAGATION_MS,
  OVERLAY_BARN_DOOR_MS,
  isOverlayOutputBroadcast,
  openOverlayOutputChannel,
} from "@/lib/overlay-output-broadcast";
import {
  getAudioVolumePercent,
  setAudioVolumePercent,
} from "@/lib/audio-output";
import type { BoardPayload } from "@/types/board";
import { useLiveScoreboardTimerLine } from "@/hooks/useLiveScoreboardTimerLine";
import { boardRefetchIntervalMs } from "@/lib/board-timer-poll";
import { OT_ROUND_DROPDOWN_LABELS, otRoundLabelParts } from "@/lib/ot-round-label";
import {
  formatOtElapsedColonSeconds,
  formatOtElapsedMmss,
  formatOtIntermediateLine,
  parseOtElapsedMmss,
  totalEscapeSecondsForSide,
} from "@/lib/ot-intermediate-log";
import {
  formatWallMss,
  scoreboardOtRedTimerStyle,
} from "@/lib/scoreboard-timer-display";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  lineupOrder: number;
  team: { id: string; name: string };
};

function displayName(p: Player) {
  const full = `${p.firstName} ${p.lastName}`.trim();
  return full || p.lastName.trim() || p.firstName.trim() || "—";
}

/** Last name for control / confirmations (not nickname). */
function boardCornerLastName(
  slot: BoardPayload["left"] | BoardPayload["right"] | null | undefined,
): string {
  const ln = slot?.lastName?.trim();
  if (ln) return ln.toUpperCase();
  const d = slot?.displayName?.trim() ?? "";
  if (!d) return "—";
  const parts = d.split(/\s+/).filter(Boolean);
  return (parts[parts.length - 1] ?? d).toUpperCase();
}

function cornerWinnerSummary(board: BoardPayload, corner: "LEFT" | "RIGHT") {
  const slot = corner === "LEFT" ? board.left : board.right;
  const team = slot?.teamName?.trim() || "—";
  const name = boardCornerLastName(slot);
  return `${corner} — ${team} — ${name}`;
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function SwapCornersIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM17 7h-7.01V4L21 8l-3.99 4V9H17V7z" />
    </svg>
  );
}

function SoundIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zm0-9a1 1 0 0 0-1 1v2.09a8.5 8.5 0 0 1 0 11.82V20a1 1 0 1 0 2 0v-2.88a10.5 10.5 0 0 0 0-10.24V4a1 1 0 0 0-1-1z" />
    </svg>
  );
}

const ROUND_PRESETS = [
  "Quarter Finals",
  "Semi Finals",
  "Grand Final",
  ...OT_ROUND_DROPDOWN_LABELS,
] as const;
const CUSTOM_PRESET = "CUSTOM";
const CUSTOM_FIGHTER = "__CUSTOM__";

/** Winning corner for a final result, or null for DRAW / NO_CONTEST. */
function winnerSideFromResultType(rt: string): "left" | "right" | null {
  switch (rt) {
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

/** OT-round result buttons. Plain SUB/ESC/DRAW advance; OT_* end the match. */
type OtResultKind = "SUB" | "ESC" | "DRAW" | "OT_SUB" | "OT_ESC" | "OT_WINDQ";

/** Current (unsaved) OT intermediate pick on the control card. */
type OtSelection =
  | { side: "left" | "right"; kind: "SUB" | "ESC" }
  | "DRAW"
  | null;

/** Next label in the OT ROUND1 ↑ → … → OT ROUND 3 ↓ sequence, or null at the end. */
function nextOtRoundLabel(label: string): string | null {
  const trimmed = label.trim();
  const direct = OT_ROUND_DROPDOWN_LABELS.findIndex((l) => l === trimmed);
  const seqIdx =
    direct >= 0
      ? direct
      : (() => {
          const parts = otRoundLabelParts(label);
          if (!parts || !parts.half) return -1;
          return (parts.index - 1) * 2 + (parts.half === "top" ? 0 : 1);
        })();
  if (seqIdx < 0 || seqIdx >= OT_ROUND_DROPDOWN_LABELS.length - 1) return null;
  return OT_ROUND_DROPDOWN_LABELS[seqIdx + 1];
}

/** Map an OT result kind + winning corner to a stored FinalResultType. */
function otResultTypeFor(
  kind: OtResultKind,
  corner: "LEFT" | "RIGHT" | null,
): string | null {
  switch (kind) {
    case "DRAW":
      return "DRAW";
    case "SUB":
    case "OT_SUB":
      return corner === "LEFT"
        ? "SUBMISSION_LEFT"
        : corner === "RIGHT"
          ? "SUBMISSION_RIGHT"
          : null;
    case "ESC":
    case "OT_ESC":
      return corner === "LEFT"
        ? "ESCAPE_LEFT"
        : corner === "RIGHT"
          ? "ESCAPE_RIGHT"
          : null;
    case "OT_WINDQ":
      /** Winner corner → the OTHER corner is the disqualified (losing) side. */
      return corner === "LEFT" ? "DQ_RIGHT" : corner === "RIGHT" ? "DQ_LEFT" : null;
    default:
      return null;
  }
}

/** Whether the chosen result is "expected" in the given OT half/context. */
function otResultIsExpected(
  kind: OtResultKind,
  half: "top" | "bottom",
  index: 1 | 2 | 3,
  afterTopSub: boolean,
): boolean {
  if (half === "top") {
    return kind === "SUB" || kind === "ESC" || kind === "DRAW" || kind === "OT_WINDQ";
  }
  if (index === 3) {
    /**
     * OT ROUND 3 ↓ (final tie-break). Enders: OT-SUB / OT-ESC / OT-WinByDQ.
     * Intermediate ESC is ALSO expected here (no warning): the operator needs
     * to record the escape's elapsed time so each fighter's total escape time
     * can be summed and compared to decide the lowest-time winner.
     */
    return (
      kind === "OT_SUB" ||
      kind === "OT_ESC" ||
      kind === "OT_WINDQ" ||
      kind === "ESC"
    );
  }
  if (afterTopSub) {
    return kind === "OT_SUB" || kind === "OT_WINDQ";
  }
  return kind === "OT_SUB" || kind === "OT_WINDQ" || kind === "ESC" || kind === "DRAW";
}

export default function ControlPanel({
  standalone = false,
}: {
  standalone?: boolean;
}) {
  const { tournamentId, ready } = useEventWorkspace();
  const queryClient = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  /**
   * Read-only follower of the overlay LIVE / barn-door state plus a setter, so
   * APPLY can orchestrate close → change → open. ControlPanel mirrors the live
   * state via `live` / `pong` broadcasts and can drive it via `live`, but it
   * deliberately does NOT answer `ping` — the dashboard / output window owns the
   * authoritative state; answering could broadcast a stale value.
   */
  const [overlayOutputLive, setOverlayOutputLive] = useState(false);
  const overlayLiveChannelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    let ch: BroadcastChannel;
    try {
      ch = openOverlayOutputChannel();
    } catch {
      return;
    }
    overlayLiveChannelRef.current = ch;
    ch.onmessage = (ev: MessageEvent) => {
      if (!isOverlayOutputBroadcast(ev.data)) return;
      const m = ev.data;
      if (m.kind === "live" || m.kind === "pong") {
        setOverlayOutputLive(m.live);
      }
    };
    /** Learn the current live state from whoever owns it. */
    ch.postMessage({ kind: "ping" });
    return () => {
      overlayLiveChannelRef.current = null;
      ch.close();
    };
  }, []);
  const setOverlayLiveBroadcast = (next: boolean) => {
    setOverlayOutputLive(next);
    overlayLiveChannelRef.current?.postMessage({ kind: "live", live: next });
  };
  const [leftId, setLeftId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");
  const [leftCustomName, setLeftCustomName] = useState("");
  const [leftCustomTeamName, setLeftCustomTeamName] = useState("");
  const [rightCustomName, setRightCustomName] = useState("");
  const [rightCustomTeamName, setRightCustomTeamName] = useState("");
  const [roundLabel, setRoundLabel] = useState("Quarter Finals");
  const [roundDirty, setRoundDirty] = useState(false);
  const [showFinalPanel, setShowFinalPanel] = useState(false);
  const [finalCorner, setFinalCorner] = useState<"LEFT" | "RIGHT" | null>(null);
  const [otSelection, setOtSelection] = useState<OtSelection>(null);
  const [otLeftElapsed, setOtLeftElapsed] = useState("");
  const [otRightElapsed, setOtRightElapsed] = useState("");
  const [warningSelectOverride, setWarningSelectOverride] = useState<
    "30" | "CUS" | null
  >(null);
  const [customWarningDraft, setCustomWarningDraft] = useState("30");
  const [audioVolume, setAudioVolume] = useState(100);
  const [selectedBracketTeamIds, setSelectedBracketTeamIds] = useState<string[] | null>(
    null,
  );
  const [selectedBracketMatchId, setSelectedBracketMatchId] = useState<string | null>(
    null,
  );
  const [selectedBracketRoundLabel, setSelectedBracketRoundLabel] = useState<string | null>(
    null,
  );
  const firstBoardLoad = useRef(true);
  const prevTimerOtRoundModeRef = useRef(false);
  /**
   * Tracks whether the upcoming OT bottom half follows a TOP submission
   * ("beat-the-time"). Used only to decide whether to warn on an unexpected
   * result — the actual clock/label mutation is server-driven, so a stale
   * value (e.g. after a reload) at worst shows/skips a confirmation prompt.
   */
  const otBottomAfterSubRef = useRef(false);
  const selectedBracketMatchIdRef = useRef<string | null>(null);
  /** Latest highlighted bracket round label (e.g. "Semi Finals"); ref so the
   *  full-match-reset handler (subscribed once) reads the current value. */
  const selectedBracketRoundLabelRef = useRef<string | null>(null);
  const patchRef = useRef<
    (body: Record<string, unknown>) => Promise<BoardPayload | null>
  >(async () => null);
  const timerRunningRef = useRef(false);
  const boardReadyRef = useRef(false);

  useEffect(() => {
    firstBoardLoad.current = true;
  }, [tournamentId]);

  useEffect(() => {
    const onFullMatchReset = () => {
      if (
        !window.confirm(
          "Full reset: timer, overtime scores, players, and players remaining.",
        )
      ) {
        return;
      }
      /**
       * Carry the highlighted bracket round into the reset so the round label
       * lands on the current match's round (e.g. "Semi Finals") instead of
       * snapping back to the default "Quarter Finals". `reset_match` itself
       * leaves the round label alone, so we set it via the direct `roundLabel`
       * field (applied before the command).
       */
      const body: Record<string, unknown> = { command: { type: "reset_match" } };
      const highlightedRound = selectedBracketRoundLabelRef.current?.trim();
      if (highlightedRound) {
        body.roundLabel = highlightedRound;
      }
      void patchRef.current(body);
    };
    window.addEventListener("matbeast-control-full-match-reset", onFullMatchReset);
    return () => {
      window.removeEventListener(
        "matbeast-control-full-match-reset",
        onFullMatchReset,
      );
    };
  }, []);

  useEffect(() => {
    setSelectedBracketTeamIds(null);
    setSelectedBracketMatchId(null);
    setSelectedBracketRoundLabel(null);
    selectedBracketMatchIdRef.current = null;
    selectedBracketRoundLabelRef.current = null;
  }, [tournamentId]);

  useEffect(() => {
    if (showFinalPanel) setFinalCorner(null);
  }, [showFinalPanel]);

  useEffect(() => {
    setAudioVolume(getAudioVolumePercent());
  }, []);

  const {
    data: board,
    error: boardQueryError,
    isLoading: boardLoading,
  } = useQuery({
    queryKey: matbeastKeys.board(tournamentId),
    queryFn: async ({ signal }) => {
      const bRes = await matbeastFetch("/api/board", {
        cache: "no-store",
        signal,
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      });
      if (!bRes.ok) {
        throw new Error("Board unavailable — did you run prisma db push?");
      }
      return (await bRes.json()) as BoardPayload;
    },
    enabled: ready && !!tournamentId,
    refetchInterval: (query) =>
      boardRefetchIntervalMs(query.state.data as BoardPayload | undefined),
  });

  timerRunningRef.current = board?.timerRunning ?? false;
  boardReadyRef.current = !!(ready && tournamentId && board);

  const scoreboardTimerLine = useLiveScoreboardTimerLine(board);

  const { data: playersData } = useQuery({
    queryKey: matbeastKeys.players(tournamentId),
    queryFn: async () => {
      const pRes = await matbeastFetch("/api/players", {
        cache: "no-store",
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      });
      if (!pRes.ok) {
        throw new Error("Could not load players");
      }
      return (await pRes.json()) as { players: Player[] };
    },
    enabled: ready && !!tournamentId,
    refetchInterval: 15_000,
  });

  const players = useMemo(() => playersData?.players ?? [], [playersData]);
  useEffect(() => {
    const onBracketSelection = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          tournamentId?: string | null;
          teamIds?: string[] | null;
          matchId?: string | null;
          roundLabel?: string | null;
        }>
      ).detail;
      if (!detail?.tournamentId || detail.tournamentId !== tournamentId) return;
      const ids = Array.isArray(detail.teamIds)
        ? detail.teamIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      setSelectedBracketTeamIds(ids.length > 0 ? ids : null);
      const matchId =
        typeof detail.matchId === "string" && detail.matchId.trim()
          ? detail.matchId
          : null;
      const bracketRoundLabel =
        typeof detail.roundLabel === "string" && detail.roundLabel.trim()
          ? detail.roundLabel.trim()
          : null;
    setSelectedBracketMatchId(matchId);
    setSelectedBracketRoundLabel(bracketRoundLabel);
    selectedBracketRoundLabelRef.current = bracketRoundLabel;
      if (matchId && matchId !== selectedBracketMatchIdRef.current && bracketRoundLabel) {
        setRoundLabel(bracketRoundLabel);
        setRoundDirty(true);
        selectedBracketMatchIdRef.current = matchId;
      }
    };
    window.addEventListener("matbeast-bracket-selection", onBracketSelection);
    return () => {
      window.removeEventListener("matbeast-bracket-selection", onBracketSelection);
    };
  }, [tournamentId]);

  useEffect(() => {
    if (!board) return;
    if (!roundDirty) {
      setRoundLabel(board.roundLabel);
    }
    if (firstBoardLoad.current) {
      setLeftId(
        board.customLeftName?.trim()
          ? CUSTOM_FIGHTER
          : (board.leftPlayerId ?? ""),
      );
      setRightId(
        board.customRightName?.trim()
          ? CUSTOM_FIGHTER
          : (board.rightPlayerId ?? ""),
      );
      setLeftCustomName(board.customLeftName ?? "");
      setLeftCustomTeamName(board.customLeftTeamName ?? "");
      setRightCustomName(board.customRightName ?? "");
      setRightCustomTeamName(board.customRightTeamName ?? "");
      firstBoardLoad.current = false;
    }
  }, [board, roundDirty]);

  const boardErr =
    boardQueryError instanceof Error ? boardQueryError.message : null;

  const warningSeconds =
    typeof board?.soundWarningSeconds === "number" && Number.isFinite(board.soundWarningSeconds)
      ? Math.max(1, Math.min(99, Math.trunc(board.soundWarningSeconds)))
      : 30;
  const effectiveWarningSeconds =
    board?.timerOtRoundMode && warningSelectOverride === null ? 10 : warningSeconds;
  const warningSelectValue = board?.sound10Enabled === false
      ? "OFF"
      : board?.timerOtRoundMode && warningSelectOverride === null
        ? "10"
        : warningSelectOverride
          ? warningSelectOverride
          : warningSeconds === 10
            ? "10"
            : warningSeconds === 30
              ? "30"
              : "CUS";

  useEffect(() => {
    if (!board) return;
    const wasTimerOtRoundMode = prevTimerOtRoundModeRef.current;
    prevTimerOtRoundModeRef.current = board.timerOtRoundMode;
    if (board.timerOtRoundMode) {
      if (!wasTimerOtRoundMode) {
        setCustomWarningDraft("10");
        setWarningSelectOverride(null);
        return;
      }
      if (warningSelectOverride === null) {
        setCustomWarningDraft("10");
      } else if (warningSelectOverride !== "CUS") {
        setCustomWarningDraft(String(warningSeconds).padStart(2, "0").slice(-2));
      }
      return;
    }
    if (warningSelectOverride !== "CUS") {
      setCustomWarningDraft(String(warningSeconds).padStart(2, "0").slice(-2));
    }
    if (warningSeconds !== 10 && warningSeconds !== 30) {
      setWarningSelectOverride("CUS");
    } else if (warningSelectOverride !== "CUS") {
      setWarningSelectOverride(null);
    }
  }, [board, warningSeconds, warningSelectOverride]);

  /**
   * Keep the "beat-the-time" flag honest: a TOP half (or any non-OT label) is
   * never "after a top submission". Bottom halves keep whatever our own advance
   * recorded so the unexpected-result warning stays accurate.
   */
  useEffect(() => {
    const parts = otRoundLabelParts(board?.roundLabel);
    if (!parts || parts.half === "top") {
      otBottomAfterSubRef.current = false;
    }
  }, [board?.roundLabel]);

  /**
   * Do not include `board.updatedAt` here: it changes on every board PATCH, which
   * resets `prevSecondsRef` in `useTimerAlertSounds` and **swallows boundary cues**.
   *
   * Do not include `timerRunning`: when the clock hits 0 the server sets
   * `timerRunning` false on the same response as `secondsRemaining === 0`, so a
   * run-bit in the key would clear `prevSecondsRef` before the 0-crossing check
   * and the air horn would never fire (same class of bug for the 10s cue on pause).
   */
  const timerAudioResetKey = board
    ? `${tournamentId ?? ""}|oi:${board.overtimeIndex}|ph:${board.timerPhase}|r:${board.timerRestMode ? 1 : 0}|u:${board.timerOtCountUpMode ? 1 : 0}|a:${board.timerOtArmedMode ? 1 : 0}|d:${board.timerOtCountdownMode ? 1 : 0}|dir:${board.otPlayDirection}|otr:${board.timerOtRoundMode ? 1 : 0}|cue:${board.timerCuesResetNonce ?? 0}`
    : (tournamentId ?? undefined);

  useTimerAlertSounds(
    board?.secondsRemaining,
    timerAudioResetKey,
    board?.sound10Enabled,
    effectiveWarningSeconds,
    board?.sound0Enabled,
    board?.timerRestMode,
    board?.sound10PlayNonce,
    board?.sound0PlayNonce,
    true,
    board?.timerOtCountdownMode ?? false,
    board?.timerRunning,
    board?.timerEndsAt ?? null,
  );

  const pOpts = useMemo(() => {
    const teamFilter = selectedBracketTeamIds ? new Set(selectedBracketTeamIds) : null;
    return players
      .filter((p) => !teamFilter || teamFilter.has(p.team.id))
      .slice()
      .sort((a, b) => {
        const tn = a.team.name.localeCompare(b.team.name);
        if (tn !== 0) return tn;
        return a.lineupOrder - b.lineupOrder;
      });
  }, [players, selectedBracketTeamIds]);

  useEffect(() => {
    const allowedPlayerIds = new Set(pOpts.map((p) => p.id));
    if (leftId && leftId !== CUSTOM_FIGHTER && !allowedPlayerIds.has(leftId)) {
      setLeftId("");
    }
    if (rightId && rightId !== CUSTOM_FIGHTER && !allowedPlayerIds.has(rightId)) {
      setRightId("");
    }
  }, [pOpts, leftId, rightId]);

  async function patch(
    body: Record<string, unknown>,
    opts?: { skipUndo?: boolean },
  ): Promise<BoardPayload | null> {
    if (!tournamentId) return null;
    setErr(null);
    /**
     * `skipUndo: true` bypasses dashboard-undo capture AND tournament dirty
     * marking (both are gated by the `x-matbeast-skip-undo` header in
     * `matbeast-fetch.ts`). Use for ephemeral commands that do not change
     * persisted event state — e.g. "play this sound now" pings, which bump a
     * board nonce purely to fan out an audio cue and would otherwise trigger
     * spurious autosaves and pollute the undo stack.
     */
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [MATBEAST_TOURNAMENT_HEADER]: tournamentId,
    };
    if (opts?.skipUndo) {
      headers["x-matbeast-skip-undo"] = "1";
    }
    // Abort in-flight GET /api/board (1s refetch) so a stale poll cannot overwrite
    // this PATCH response (e.g. OT ELAPSED snapping back).
    await queryClient.cancelQueries({
      queryKey: matbeastKeys.board(tournamentId),
      exact: true,
    });
    const res = await matbeastFetch("/api/board", {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "Update failed";
      try {
        const j = (await res.json()) as {
          error?: string;
          hint?: string;
          detail?: string;
        };
        msg = [j.error, j.detail, j.hint].filter(Boolean).join(" — ") || msg;
      } catch {
        // keep default message
      }
      setErr(msg);
      return null;
    }
    const j = (await res.json()) as BoardPayload;
    await queryClient.cancelQueries({
      queryKey: matbeastKeys.board(tournamentId),
      exact: true,
    });
    queryClient.setQueryData(matbeastKeys.board(tournamentId), {
      ...j,
      resultsLog: Array.isArray(j.resultsLog) ? [...j.resultsLog] : [],
    });
    setRoundDirty(false);
    const cmdType =
      typeof body.command === "object" &&
      body.command !== null &&
      "type" in body.command &&
      typeof (body.command as { type: unknown }).type === "string"
        ? (body.command as { type: string }).type
        : null;
    const boardWriteTouchesResultLog =
      cmdType === "final_save" ||
      cmdType === "final_unsave" ||
      cmdType === "result_log_delete" ||
      cmdType === "result_log_manual_add";
    if (boardWriteTouchesResultLog) {
      try {
        await queryClient.refetchQueries({
          queryKey: matbeastKeys.board(tournamentId),
          exact: true,
        });
      } catch {
        /* keep setQueryData */
      }
    }
    setLeftId(j.customLeftName?.trim() ? CUSTOM_FIGHTER : (j.leftPlayerId ?? ""));
    setRightId(
      j.customRightName?.trim() ? CUSTOM_FIGHTER : (j.rightPlayerId ?? ""),
    );
    setLeftCustomName(j.customLeftName ?? "");
    setLeftCustomTeamName(j.customLeftTeamName ?? "");
    setRightCustomName(j.customRightName ?? "");
    setRightCustomTeamName(j.customRightTeamName ?? "");
    setRoundLabel(j.roundLabel);
    return j;
  }
  patchRef.current = patch;

  useEffect(() => {
    const isEditableTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      if (t.closest("[data-matbeast-rename-dialog]")) return true;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return t.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.code !== "Space") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat) return;
      // While editing an input/textarea/select, Space must type a space.
      if (isEditableTarget(e.target)) return;
      // Otherwise Space is reserved exclusively for the match timer. Always
      // preventDefault so it never activates whatever button/link happens to
      // have focus (the prior behavior let Space "click" the focused control).
      e.preventDefault();
      if (!boardReadyRef.current) return;
      void patchRef.current({
        command: {
          type: timerRunningRef.current ? "timer_pause" : "timer_start",
        },
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function fighterPayload(): Record<string, unknown> {
    return {
      leftPlayerId: leftId && leftId !== CUSTOM_FIGHTER ? leftId : null,
      rightPlayerId: rightId && rightId !== CUSTOM_FIGHTER ? rightId : null,
      customLeftName:
        leftId === CUSTOM_FIGHTER
          ? leftCustomName.trim().toUpperCase() || null
          : null,
      customLeftTeamName:
        leftId === CUSTOM_FIGHTER
          ? leftCustomTeamName.trim().toUpperCase() || null
          : null,
      customRightName:
        rightId === CUSTOM_FIGHTER
          ? rightCustomName.trim().toUpperCase() || null
          : null,
      customRightTeamName:
        rightId === CUSTOM_FIGHTER
          ? rightCustomTeamName.trim().toUpperCase() || null
          : null,
    };
  }

  async function submitFinalResult(
    resultType: string,
    confirmMessage: string,
  ): Promise<void> {
    if (!window.confirm(confirmMessage)) return;
    /** OT state BEFORE the save: a regulation 4-4 draw can transition INTO OT
     *  (server-side), so `saved.timerOtRoundMode` may flip true even though this
     *  was a regulation result — base the dropdown keep/clear on the prior state. */
    const wasOt = board?.timerOtRoundMode ?? false;
    const saved = await patch({
      ...fighterPayload(),
      roundLabel,
      command: {
        type: "final_save",
        resultType,
        selectedBracketMatchId,
      },
    });
    if (saved) {
      /**
       * Clear the control's fighter dropdowns based on the outcome (the
       * scoreboard overlay keeps showing the names until the next APPLY):
       *   • DRAW / NO_CONTEST — both fighters are replaced, so clear both.
       *   • Win — the winner stays selected to face the next challenger; the
       *     loser's dropdown clears so the operator picks the next fighter.
       *   • Sweep — once a team reaches 5 eliminations the team match is over,
       *     so clear both in preparation for a new team match.
       *
       * Exception: in an OVERTIME round (OT ROUND label) the same two fighters
       * keep going regardless of result, so leave both dropdowns untouched.
       */
      const winnerSide = winnerSideFromResultType(resultType);
      const matchOver =
        (saved.leftEliminatedCount ?? 0) >= 5 ||
        (saved.rightEliminatedCount ?? 0) >= 5;
      const clearLeftDropdown = () => {
        setLeftId("");
        setLeftCustomName("");
        setLeftCustomTeamName("");
      };
      const clearRightDropdown = () => {
        setRightId("");
        setRightCustomName("");
        setRightCustomTeamName("");
      };
      if (wasOt) {
        // OT ROUND intermediate-style final: keep both fighters selected.
      } else if (matchOver || winnerSide === null) {
        clearLeftDropdown();
        clearRightDropdown();
      } else if (winnerSide === "left") {
        clearRightDropdown();
      } else {
        clearLeftDropdown();
      }
      setShowFinalPanel(false);
      setFinalCorner(null);

      /**
       * Team match decided by a regulation sweep (exactly one side reached 5 —
       * a dual 4-4 draw instead goes to OT, see server). Advance the bracket:
       * the winner was set server-side; here we move the current-match highlight
       * to the next logical team match.
       */
      const leftOut = (saved.leftEliminatedCount ?? 0) >= 5;
      const rightOut = (saved.rightEliminatedCount ?? 0) >= 5;
      const teamDecidedBySweep = !wasOt && (leftOut !== rightOut);
      if (teamDecidedBySweep && selectedBracketMatchId) {
        void advanceBracketToNextMatch();
      }
    }
  }

  /**
   * After a team match is decided (regulation sweep or OT ender), refresh the
   * bracket (the winner + downstream seeding were set server-side) and tell the
   * Bracket card to move its "current match" highlight to the next logical team
   * match. That selection re-emits the bracket-selection event, which updates
   * the round label, the overlay highlight, and the next match's team ids.
   */
  async function advanceBracketToNextMatch(): Promise<void> {
    if (!tournamentId) return;
    try {
      await queryClient.invalidateQueries({
        queryKey: matbeastKeys.bracket(tournamentId),
      });
    } catch {
      /* ignore — BracketPanel refetches on the advance event below */
    }
    window.dispatchEvent(
      new CustomEvent("matbeast-bracket-advance-current", {
        detail: { tournamentId },
      }),
    );
  }

  /** Toggle an OT intermediate pick on the card; auto-fills the elapsed box. */
  function handleOtSelect(next: OtSelection): void {
    setOtSelection((prev) => {
      const same =
        prev === next ||
        (prev &&
          next &&
          prev !== "DRAW" &&
          next !== "DRAW" &&
          prev.side === next.side &&
          prev.kind === next.kind);
      if (same) {
        if (prev && prev !== "DRAW") {
          if (prev.side === "left") setOtLeftElapsed("");
          else setOtRightElapsed("");
        }
        return null;
      }
      if (next && next !== "DRAW") {
        const snap = formatOtElapsedColonSeconds(board?.otRoundElapsedSeconds ?? 0);
        if (next.side === "left") setOtLeftElapsed(snap);
        else setOtRightElapsed(snap);
      }
      return next;
    });
  }

  /**
   * Commit the selected OT intermediate result (SUB / ESC / DRAW). Appends to
   * the in-card OT log and advances the round per the OT rules; on OT ROUND 3 ↓
   * an (unexpected) result is recorded without advancing. Players stay the same.
   */
  async function commitOtIntermediate(): Promise<void> {
    if (!board) return;
    const parts = otRoundLabelParts(board.roundLabel);
    if (!parts || !parts.half) return;
    const { half, index } = parts;
    const sel = otSelection;
    if (!sel) {
      window.alert("Select a result first (SUB / ESC / DRAW).");
      return;
    }

    let kind: "SUB" | "ESC" | "DRAW";
    let side: "left" | "right" | null;
    let elapsedSeconds: number | null;
    if (sel === "DRAW") {
      kind = "DRAW";
      side = null;
      elapsedSeconds = null;
    } else {
      kind = sel.kind;
      side = sel.side;
      const box = side === "left" ? otLeftElapsed : otRightElapsed;
      elapsedSeconds = parseOtElapsedMmss(box);
      if (elapsedSeconds == null) {
        window.alert("Enter the elapsed time as m:ss (e.g. 0:26).");
        return;
      }
    }

    const expected = otResultIsExpected(
      kind,
      half,
      index,
      otBottomAfterSubRef.current,
    );
    if (!expected && !window.confirm("Unexpected Result-Sure?")) return;

    const isFinalRound3Bottom = half === "bottom" && index === 3;
    const mode: "advance" | "record_only" = isFinalRound3Bottom
      ? "record_only"
      : "advance";
    let clock: "transfer" | "oneMinute" | "none" = "none";
    let nextLabel: string | null = null;
    if (mode === "advance") {
      clock = half === "top" && kind === "SUB" ? "transfer" : "oneMinute";
      nextLabel = nextOtRoundLabel(board.roundLabel);
    }

    const saved = await patch({
      command: {
        type: "ot_intermediate_result",
        outcome: kind,
        side,
        elapsedSeconds,
        mode,
        clock,
        nextRoundLabel: nextLabel,
      },
    });
    if (!saved) return;

    if (mode === "advance") {
      otBottomAfterSubRef.current = half === "top" ? kind === "SUB" : false;
    }
    setOtSelection(null);
    setOtLeftElapsed("");
    setOtRightElapsed("");
  }

  /** Undo the last in-card OT half: pop the entry and restore the pre-save clock/label. */
  async function commitOtUnsave(): Promise<void> {
    if (!board) return;
    if ((board.otIntermediateLog ?? []).length === 0) return;
    const saved = await patch({ command: { type: "ot_intermediate_unsave" } });
    if (!saved) return;
    /** Re-derive the beat-the-time flag from the restored log/label. */
    const parts = otRoundLabelParts(saved.roundLabel);
    if (!parts || parts.half !== "bottom") {
      otBottomAfterSubRef.current = false;
    } else {
      const log = saved.otIntermediateLog ?? [];
      const top = log[log.length - 1];
      otBottomAfterSubRef.current = Boolean(
        top && top.kind === "SUB" && top.roundLabel.trim().endsWith("↑"),
      );
    }
    setOtSelection(null);
    setOtLeftElapsed("");
    setOtRightElapsed("");
  }

  /**
   * OT-ender (final winner). Always finalizes: records the winner to the Results
   * log and flushes the in-card OT log (server side). Warns first on an
   * unexpected result, but on "I'm Sure" still records the final (a gap in the
   * intermediate record is acceptable). Never advances the OT round label, but
   * it DOES decide the team match: both fighter dropdowns clear and the bracket
   * highlight advances to the next logical match.
   */
  async function submitOtResult(kind: OtResultKind): Promise<void> {
    if (!board) return;
    const parts = otRoundLabelParts(board.roundLabel);
    if (!parts || !parts.half) return;
    const { half, index } = parts;

    if (!finalCorner) {
      window.alert("Tap the winning fighter (left or right) first.");
      return;
    }
    const rt = otResultTypeFor(kind, finalCorner);
    if (!rt) {
      window.alert("Tap the winning fighter (left or right) first.");
      return;
    }

    const expected = otResultIsExpected(
      kind,
      half,
      index,
      otBottomAfterSubRef.current,
    );
    if (!expected && !window.confirm("Unexpected Result-Sure?")) return;

    const saved = await patch({
      command: { type: "final_save", resultType: rt, selectedBracketMatchId },
    });
    if (!saved) return;

    setShowFinalPanel(false);
    setFinalCorner(null);

    /**
     * An OT ender finishes the whole team match: clear both fighter dropdowns
     * (a new team match is next) and advance the bracket — the winner was set
     * server-side from the winning corner; here we move the current-match
     * highlight to the next logical team match.
     */
    setLeftId("");
    setLeftCustomName("");
    setLeftCustomTeamName("");
    setRightId("");
    setRightCustomName("");
    setRightCustomTeamName("");
    if (selectedBracketMatchId) {
      void advanceBracketToNextMatch();
    }
  }

  if (!ready || !tournamentId) {
    return (
      <div
        className={
          standalone ? "min-h-screen bg-zinc-950 p-6 text-zinc-100" : "p-2 text-zinc-100"
        }
      >
        <p className="text-zinc-400">Loading workspace…</p>
      </div>
    );
  }

  async function applyFighters() {
    /**
     * APPLY commits the selected fighters and (only when the operator actually
     * changed the round dropdown/input to a **different** label) the round
     * label. Sending the same OT round label would otherwise re-run OT
     * reconcile on the server and reset the secondary ELAPSED clock; the
     * `roundDirty` + string compare guard keeps repeated APPLYs inside the
     * same OT round from zeroing ELAPSED.
     */
    const body: Record<string, unknown> = fighterPayload();
    if (
      board &&
      roundDirty &&
      roundLabel.trim() !== (board.roundLabel ?? "").trim()
    ) {
      body.roundLabel = roundLabel;
    }
    /**
     * Committing a matchup clears any prior final result so both fighter
     * names reset to white (the previous winner is no longer highlighted
     * green once the operator applies a new pairing).
     */
    body.clearFinalResult = true;
    /**
     * APPLY also resets the regulation clock to 4:00 (paused). Finalizing a
     * result no longer resets the timer; the operator gets the fresh clock here
     * instead. The server ignores this for OT rounds (they keep their own clock).
     */
    body.resetTimerForApply = true;

    /**
     * Barn-door orchestration around the change:
     *  - If the overlay is LIVE, first close the barn doors, commit the change
     *    while it's hidden, then reopen the doors on the fresh content.
     *  - If it's NOT live, commit the change behind the (already closed) doors,
     *    then open with the barn-door effect.
     * Either way the overlay ends LIVE. We pause after the commit so the
     * overlay window's board poll has time to pick up the new fighters/round
     * before the doors open. (`postScoreboardMode` is untouched — this only
     * drives the live/barn-door state.)
     */
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const wasLive = overlayOutputLive;
    if (wasLive) {
      setOverlayLiveBroadcast(false);
      await sleep(OVERLAY_BARN_DOOR_MS);
    }
    const saved = await patch(body);
    if (!saved) {
      // Restore the prior live state on failure so we don't strand the doors.
      if (wasLive) setOverlayLiveBroadcast(true);
      return;
    }
    await sleep(OVERLAY_APPLY_PROPAGATION_MS);
    setOverlayLiveBroadcast(true);
  }

  if (!board) {
    const blockingErr = err ?? boardErr;
    return (
      <div
        className={
          standalone ? "min-h-screen bg-zinc-950 p-6 text-zinc-100" : "p-2 text-zinc-100"
        }
      >
        <p className="text-zinc-400">
          {blockingErr ?? (boardLoading ? "Loading board…" : "Board unavailable.")}
        </p>
        {blockingErr && (
          <p className="mt-4 text-sm text-zinc-500">
            From <code className="text-zinc-300">web</code>: copy{" "}
            <code className="text-zinc-300">.env.example</code> to{" "}
            <code className="text-zinc-300">.env</code>, then{" "}
            <code className="text-zinc-300">npx prisma db push</code> and{" "}
            <code className="text-zinc-300">npm run dev</code>.
          </p>
        )}
      </div>
    );
  }

  const presetValue = ROUND_PRESETS.includes(
    roundLabel as (typeof ROUND_PRESETS)[number],
  )
    ? roundLabel
    : CUSTOM_PRESET;
  const isStandalonePage = standalone;
  const lbl = isStandalonePage
    ? "text-sm font-medium uppercase tracking-wide text-zinc-500"
    : "text-[11px] font-medium uppercase tracking-wide text-zinc-500";
  const fieldFighterPick =
    "min-w-0 w-full rounded border border-zinc-700 bg-zinc-900 " +
    (isStandalonePage ? "px-2 py-2" : "px-1.5 py-0.5 text-[11px]");
  const fieldSm = isStandalonePage
    ? "px-2 py-2 text-sm"
    : "px-1.5 py-0.5 text-[11px]";
  const actionBtn =
    isStandalonePage
      ? "rounded px-4 py-2 font-medium"
      : "rounded px-2 py-1 text-[11px] font-medium";

  return (
    <div
      className={
        standalone
          ? "min-h-screen bg-zinc-950 p-6 text-zinc-100"
          : "text-zinc-100"
      }
    >
      {standalone ? (
        <header className="mb-6 flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-semibold">Mat control</h1>
          <p className="text-sm text-zinc-400">
            Event file:{" "}
            <span className="font-semibold text-zinc-200">
              {board.currentRosterFileName || "UNTITLED"}
            </span>
          </p>
          <nav className="flex flex-wrap items-center gap-3 text-sm text-zinc-400">
            <Link className="hover:text-white" href="/">
              Dashboard
            </Link>
            <button
              type="button"
              className="bg-transparent p-0 text-inherit hover:text-white"
              onClick={() => openScoreboardOverlayWindow()}
            >
              Overlay
            </button>
            {(() => {
              const line = formatControlCardFinalHeader(board);
              return line ? (
                <span
                  className="min-w-0 max-w-[min(100%,28rem)] truncate text-[11px] font-normal uppercase tracking-[0.1em] text-zinc-400"
                  title={line}
                >
                  {line}
                </span>
              ) : null;
            })()}
            <button
              type="button"
              className="shrink-0 rounded border border-red-900/50 bg-red-950/35 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-red-200/95 hover:bg-red-900/40"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("matbeast-control-full-match-reset"),
                )
              }
            >
              Full match reset
            </button>
          </nav>
        </header>
      ) : null}

      {(err || boardErr) && (
        <p className="mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-red-200">
          {err ?? boardErr}
        </p>
      )}

      <div
        className={
          isStandalonePage
            ? "mb-8 grid gap-6 lg:grid-cols-2"
            : "grid grid-cols-1 gap-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
        }
      >
        <section
          className={
            isStandalonePage
              ? "relative rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
              : "relative border-b border-zinc-700 p-4 lg:border-b-0 lg:border-r"
          }
        >
          <div className="flex flex-col gap-1">
            <div className="w-full min-w-0">
              <select
                className={fieldFighterPick}
                value={leftId}
                onChange={(e) => setLeftId(e.target.value)}
              >
                <option value={CUSTOM_FIGHTER}>CUSTOM</option>
                <option value="">—</option>
                {pOpts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.team.name} · #{p.lineupOrder} {displayName(p)}
                  </option>
                ))}
              </select>
            </div>
            {leftId === CUSTOM_FIGHTER ? (
              <div className="mt-1 grid w-full max-w-full gap-1">
                <input
                  className={`w-full rounded border border-zinc-700 bg-zinc-900 uppercase ${isStandalonePage ? "px-2 py-2" : "px-1.5 py-0.5 text-[11px]"}`}
                  value={leftCustomName}
                  onChange={(e) => setLeftCustomName(e.target.value.toUpperCase())}
                  placeholder="CUSTOM LEFT NAME"
                />
                <input
                  className={`w-full rounded border border-zinc-700 bg-zinc-900 uppercase ${isStandalonePage ? "px-2 py-2" : "px-1.5 py-0.5 text-[11px]"}`}
                  value={leftCustomTeamName}
                  onChange={(e) =>
                    setLeftCustomTeamName(e.target.value.toUpperCase())
                  }
                  placeholder="CUSTOM LEFT TEAM"
                />
              </div>
            ) : null}
            <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
              <span className={`${lbl} block text-left`}>
                <span className="mr-0.5 text-zinc-400" aria-hidden>
                  ↑
                </span>
                LT CORNER{" "}
                <span className="font-normal text-zinc-500">(YOUR RT)</span>
              </span>
              <button
                type="button"
                title={
                  board.finalSaved
                    ? "Unsave the final result before swapping corners"
                    : "Swap left and right corners (fighters, teams, eliminations, OT wins)"
                }
                disabled={board.finalSaved}
                onClick={() =>
                  void patch({
                    ...fighterPayload(),
                    roundLabel,
                    command: { type: "swap_mat_corners" },
                  })
                }
                className="shrink-0 justify-self-center rounded border border-zinc-600 bg-zinc-800/80 px-1.5 py-1 text-zinc-200 hover:border-teal-600/60 hover:bg-zinc-800 hover:text-teal-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SwapCornersIcon className="h-3.5 w-3.5" />
                <span className="sr-only">Swap corners</span>
              </button>
              <span className={`${lbl} block text-left`}>
                RT CORNER{" "}
                <span className="font-normal text-zinc-500">(YOUR LT)</span>
                <span className="ml-0.5 text-zinc-400" aria-hidden>
                  ↓
                </span>
              </span>
            </div>
            <div className="w-full min-w-0">
              <select
                className={fieldFighterPick}
                value={rightId}
                onChange={(e) => setRightId(e.target.value)}
              >
                <option value={CUSTOM_FIGHTER}>CUSTOM</option>
                <option value="">—</option>
                {pOpts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.team.name} · #{p.lineupOrder} {displayName(p)}
                  </option>
                ))}
              </select>
            </div>
            {rightId === CUSTOM_FIGHTER ? (
              <div className="mt-1 grid w-full max-w-full gap-1">
                <input
                  className={`w-full rounded border border-zinc-700 bg-zinc-900 uppercase ${isStandalonePage ? "px-2 py-2" : "px-1.5 py-0.5 text-[11px]"}`}
                  value={rightCustomName}
                  onChange={(e) => setRightCustomName(e.target.value.toUpperCase())}
                  placeholder="CUSTOM RIGHT NAME"
                />
                <input
                  className={`w-full rounded border border-zinc-700 bg-zinc-900 uppercase ${isStandalonePage ? "px-2 py-2" : "px-1.5 py-0.5 text-[11px]"}`}
                  value={rightCustomTeamName}
                  onChange={(e) =>
                    setRightCustomTeamName(e.target.value.toUpperCase())
                  }
                  placeholder="CUSTOM RIGHT TEAM"
                />
              </div>
            ) : null}
          </div>
          <div className="mt-2">
            <label className={lbl}>Round label</label>
            <div className="mt-1 flex flex-wrap gap-2">
              <select
                className={`rounded border border-zinc-700 bg-zinc-900 ${fieldSm}`}
                value={presetValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM_PRESET) return;
                  setRoundLabel(v);
                  setRoundDirty(true);
                }}
              >
                <option value="Quarter Finals">Quarter Finals</option>
                <option value="Semi Finals">Semi Finals</option>
                <option value="Grand Final">Grand Final</option>
                <option value="OT ROUND1 ↑">OT ROUND1 ↑</option>
                <option value="OT ROUND1 ↓">OT ROUND1 ↓</option>
                <option value="OT ROUND 2 ↑">OT ROUND 2 ↑</option>
                <option value="OT ROUND 2 ↓">OT ROUND 2 ↓</option>
                <option value="OT ROUND 3 ↑">OT ROUND 3 ↑</option>
                <option value="OT ROUND 3 ↓">OT ROUND 3 ↓</option>
                <option value={CUSTOM_PRESET}>CUSTOM</option>
              </select>
              <input
                className={`min-w-[180px] flex-1 rounded border border-zinc-700 bg-zinc-900 uppercase ${isStandalonePage ? "px-2 py-2" : "px-1.5 py-0.5 text-[11px]"}`}
                value={roundLabel}
                onChange={(e) => {
                  setRoundLabel(e.target.value.toUpperCase());
                  setRoundDirty(true);
                }}
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-start gap-1.5">
            <button
              type="button"
              className={`${actionBtn} bg-amber-600 text-black hover:bg-amber-500`}
              title="Save fighter picks, custom names, and (only when you changed it) the round label. Does not reset OT elapsed for repeated APPLYs inside the same round."
              aria-label="Apply fighters and round label to the board"
              onClick={() => applyFighters()}
            >
              APPLY
            </button>
            <button
              type="button"
              className={`${actionBtn} bg-emerald-700 text-white hover:bg-emerald-600`}
              onClick={() => setShowFinalPanel((s) => !s)}
            >
              FINAL
            </button>
            <button
              type="button"
              className={`${actionBtn} bg-zinc-700 text-white hover:bg-zinc-600`}
              onClick={() => {
                const resetRoundLabel = selectedBracketRoundLabel ?? "Quarter Finals";
                setLeftId("");
                setRightId("");
                setLeftCustomName("");
                setLeftCustomTeamName("");
                setRightCustomName("");
                setRightCustomTeamName("");
                setRoundLabel(resetRoundLabel);
                setRoundDirty(false);
                setShowFinalPanel(false);
                void patch({
                  command: { type: "clear_fields", roundLabel: resetRoundLabel },
                });
              }}
            >
              CLEAR
            </button>
            <button
              type="button"
              className={`${actionBtn} bg-red-800 text-white hover:bg-red-700 disabled:opacity-50`}
              disabled={!board.finalSaved}
              onClick={() => void patch({ command: { type: "final_unsave" } })}
            >
              UNSAVE
            </button>
          </div>
          <div className="mt-2 border-t border-zinc-800 pt-2">
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <span className="shrink-0 text-[9px] font-bold uppercase text-zinc-500">
                    L
                  </span>
                  <span className="min-w-0 truncate text-[10px] font-medium text-zinc-400">
                    {(board.left?.teamName || "—").trim() || "—"}
                  </span>
                  <span className="ml-auto inline-flex min-h-6 min-w-[1.35rem] shrink-0 items-center justify-center rounded border border-teal-700/50 bg-teal-950/40 px-1 py-0.5 text-sm font-bold tabular-nums leading-none text-teal-100">
                    {5 - Math.min(5, board.leftEliminatedCount)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-0.5">
                  <button
                    type="button"
                    className="rounded bg-red-900 px-1 py-0.5 text-[9px] font-semibold uppercase hover:bg-red-800"
                    onClick={() => patch({ command: { type: "eliminate_left" } })}
                  >
                    − LEFT
                  </button>
                  <button
                    type="button"
                    className="rounded bg-emerald-900 px-1 py-0.5 text-[9px] font-semibold uppercase hover:bg-emerald-800"
                    onClick={() =>
                      patch({ command: { type: "undo_eliminate_left" } })
                    }
                  >
                    + LEFT
                  </button>
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <span className="shrink-0 text-[9px] font-bold uppercase text-zinc-500">
                    R
                  </span>
                  <span className="min-w-0 truncate text-[10px] font-medium text-zinc-400">
                    {(board.right?.teamName || "—").trim() || "—"}
                  </span>
                  <span className="ml-auto inline-flex min-h-6 min-w-[1.35rem] shrink-0 items-center justify-center rounded border border-teal-700/50 bg-teal-950/40 px-1 py-0.5 text-sm font-bold tabular-nums leading-none text-teal-100">
                    {5 - Math.min(5, board.rightEliminatedCount)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-0.5">
                  <button
                    type="button"
                    className="rounded bg-red-900 px-1 py-0.5 text-[9px] font-semibold uppercase hover:bg-red-800"
                    onClick={() => patch({ command: { type: "eliminate_right" } })}
                  >
                    − RIGHT
                  </button>
                  <button
                    type="button"
                    className="rounded bg-emerald-900 px-1 py-0.5 text-[9px] font-semibold uppercase hover:bg-emerald-800"
                    onClick={() =>
                      patch({ command: { type: "undo_eliminate_right" } })
                    }
                  >
                    + RIGHT
                  </button>
                </div>
              </div>
            </div>
          </div>
          {showFinalPanel && (
            <div className="absolute inset-0 z-30 flex flex-col overflow-auto rounded-md border border-teal-800/60 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-sm">
              <p className="text-sm font-medium text-zinc-300">
                {board.timerOtRoundMode ? "Final result — OVERTIME" : "Final result"}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {board.timerOtRoundMode
                  ? "Tap the winner, then OT-SUB / OT-ESC / OT-WinByDQ to end overtime (green winner) and save the intermediate log to Results. Record each half on the timer card."
                  : "Tap a fighter for submission, escape, or DQ. Draw / no contest need no selection."}
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setFinalCorner("LEFT")}
                  className={[
                    "rounded border px-2 py-2 text-left transition",
                    finalCorner === "LEFT"
                      ? "border-teal-500 bg-teal-900/30 ring-1 ring-teal-500/50"
                      : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600",
                  ].join(" ")}
                >
                  <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                    Lt corner (your rt)
                  </p>
                  <p className="text-sm font-semibold text-zinc-100">
                    {boardCornerLastName(board.left)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {board.left?.teamName?.trim() || "—"}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setFinalCorner("RIGHT")}
                  className={[
                    "rounded border px-2 py-2 text-left transition",
                    finalCorner === "RIGHT"
                      ? "border-teal-500 bg-teal-900/30 ring-1 ring-teal-500/50"
                      : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600",
                  ].join(" ")}
                >
                  <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                    Rt corner (your lt)
                  </p>
                  <p className="text-sm font-semibold text-zinc-100">
                    {boardCornerLastName(board.right)}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {board.right?.teamName?.trim() || "—"}
                  </p>
                </button>
              </div>
              {board.timerOtRoundMode ? (
                <>
                  <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-emerald-500/80">
                    End overtime — winner
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
                      onClick={() => void submitOtResult("OT_SUB")}
                    >
                      OT-SUB
                    </button>
                    <button
                      type="button"
                      className="rounded bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
                      onClick={() => void submitOtResult("OT_ESC")}
                    >
                      OT-ESC
                    </button>
                    <button
                      type="button"
                      className="rounded bg-emerald-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
                      onClick={() => void submitOtResult("OT_WINDQ")}
                    >
                      OT-WinByDQ
                    </button>
                    <button
                      type="button"
                      className="rounded border border-zinc-600 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                      onClick={() => {
                        setShowFinalPanel(false);
                        setFinalCorner(null);
                      }}
                    >
                      CANCEL
                    </button>
                  </div>
                </>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded bg-emerald-800 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    onClick={() => {
                      if (!finalCorner) {
                        window.alert("Tap left or right fighter first.");
                        return;
                      }
                      const rt =
                        finalCorner === "LEFT"
                          ? "SUBMISSION_LEFT"
                          : "SUBMISSION_RIGHT";
                      void submitFinalResult(
                        rt,
                        `Record SUBMISSION?\n\nWinner: ${cornerWinnerSummary(board, finalCorner)}`,
                      );
                    }}
                  >
                    SUBMISSION
                  </button>
                  <button
                    type="button"
                    className="rounded bg-sky-900 px-2 py-1.5 text-xs font-semibold text-white hover:bg-sky-800"
                    onClick={() => {
                      if (!finalCorner) {
                        window.alert("Tap left or right fighter first.");
                        return;
                      }
                      const rt =
                        finalCorner === "LEFT" ? "ESCAPE_LEFT" : "ESCAPE_RIGHT";
                      void submitFinalResult(
                        rt,
                        `Record ESCAPE?\n\nWinner: ${cornerWinnerSummary(board, finalCorner)}`,
                      );
                    }}
                  >
                    ESCAPE
                  </button>
                  <button
                    type="button"
                    className="rounded bg-orange-900 px-2 py-1.5 text-xs font-semibold text-white hover:bg-orange-800"
                    onClick={() => {
                      if (!finalCorner) {
                        window.alert("Tap the disqualified fighter first.");
                        return;
                      }
                      const rt = finalCorner === "LEFT" ? "DQ_LEFT" : "DQ_RIGHT";
                      const other = finalCorner === "LEFT" ? "RIGHT" : "LEFT";
                      void submitFinalResult(
                        rt,
                        `Disqualify ${finalCorner} corner?\n\nWinner: ${cornerWinnerSummary(board, other)}`,
                      );
                    }}
                  >
                    WIN BY DQ
                  </button>
                  <button
                    type="button"
                    className="rounded bg-zinc-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-zinc-600"
                    onClick={() =>
                      void submitFinalResult(
                        "NO_CONTEST",
                        "Record NO CONTEST for this bout?",
                      )
                    }
                  >
                    NO CONTEST
                  </button>
                  <button
                    type="button"
                    className="rounded bg-zinc-700 px-2 py-1.5 text-xs font-semibold text-white hover:bg-zinc-600"
                    onClick={() =>
                      void submitFinalResult("DRAW", "Record DRAW for this bout?")
                    }
                  >
                    DRAW
                  </button>
                  <button
                    type="button"
                    className="rounded border border-zinc-600 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                    onClick={() => {
                      setShowFinalPanel(false);
                      setFinalCorner(null);
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        <section
          className={
            isStandalonePage
              ? "rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
              : "p-4"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={`font-mono text-4xl ${
                board.timerRestMode
                  ? "text-amber-300"
                  : scoreboardOtRedTimerStyle(board)
                    ? "text-red-800"
                    : board.timerRunning
                      ? "text-white"
                      : "text-red-500"
              }`}
            >
              {scoreboardTimerLine}
            </p>
            {board.timerOtRoundMode ? (
              <>
                <button
                  type="button"
                  title={
                    board.otRoundTransferConsumed
                      ? "Undo: restore match clock and OT elapsed before they were moved (paused only)"
                      : "Move OT elapsed into the match clock; ELAPSED resets to 0 (paused only). Separate from APPLY (fighters)."
                  }
                  disabled={board.timerRunning}
                  onClick={() =>
                    void patch({ command: { type: "ot_round_transfer_elapsed_to_main" } })
                  }
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center self-end rounded border border-zinc-600 bg-zinc-800/80 text-zinc-200 hover:border-teal-600/60 hover:bg-zinc-800 hover:text-teal-100 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                  </svg>
                  <span className="sr-only">
                    {board.otRoundTransferConsumed
                      ? "Undo move OT elapsed to match clock"
                      : "Move OT elapsed to match clock; reset ELAPSED"}
                  </span>
                </button>
                <div className="flex flex-col items-center gap-0.5 leading-none">
                  <span className="text-[0.625rem] font-semibold uppercase tracking-wide text-zinc-500">
                    ELAPSED:
                  </span>
                  <p
                    className="font-mono text-[1.575rem] leading-none text-yellow-300 tabular-nums"
                    aria-label="Overtime elapsed"
                  >
                    {formatWallMss(board.otRoundElapsedSeconds)}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-1 self-center">
                  <button
                    type="button"
                    title={board.timerRunning ? "Pause (Space)" : "Start (Space)"}
                    aria-label={
                      board.timerRunning ? "Pause timer (Space)" : "Start timer (Space)"
                    }
                    className={
                      "inline-flex h-8 w-8 items-center justify-center rounded text-white " +
                      (board.timerRunning
                        ? "bg-red-800 hover:bg-red-700"
                        : "bg-green-800 hover:bg-green-700")
                    }
                    onClick={() =>
                      patch({
                        command: {
                          type: board.timerRunning ? "timer_pause" : "timer_start",
                        },
                      })
                    }
                  >
                    {board.timerRunning ? (
                      <PauseIcon className="h-4 w-4" />
                    ) : (
                      <PlayIcon className="h-4 w-4 pl-0.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600"
                    onClick={() => patch({ command: { type: "reset_timer_overtime" } })}
                  >
                    1:00
                  </button>
                  <button
                    type="button"
                    className="rounded bg-indigo-900 px-2 py-1 text-xs hover:bg-indigo-800"
                    onClick={() =>
                      patch({
                        command: { type: "adjust_timer_seconds", deltaSeconds: 10 },
                      })
                    }
                  >
                    +0:10
                  </button>
                  <button
                    type="button"
                    className="rounded bg-indigo-900 px-2 py-1 text-xs hover:bg-indigo-800"
                    onClick={() =>
                      patch({
                        command: { type: "adjust_timer_seconds", deltaSeconds: -10 },
                      })
                    }
                  >
                    -0:10
                  </button>
                  <button
                    type="button"
                    className="rounded bg-violet-900 px-2 py-1 text-xs hover:bg-violet-800"
                    onClick={() =>
                      patch({
                        command: { type: "adjust_timer_seconds", deltaSeconds: 1 },
                      })
                    }
                  >
                    +0:01
                  </button>
                  <button
                    type="button"
                    className="rounded bg-violet-900 px-2 py-1 text-xs hover:bg-violet-800"
                    onClick={() =>
                      patch({
                        command: { type: "adjust_timer_seconds", deltaSeconds: -1 },
                      })
                    }
                  >
                    -0:01
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
            {board.roundLabel}
          </p>
          {!board.timerOtRoundMode && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              title={board.timerRunning ? "Pause (Space)" : "Start (Space)"}
              aria-label={
                board.timerRunning ? "Pause timer (Space)" : "Start timer (Space)"
              }
              className={
                "inline-flex h-10 w-10 items-center justify-center rounded text-white " +
                (board.timerRunning
                  ? "bg-red-800 hover:bg-red-700"
                  : "bg-green-800 hover:bg-green-700")
              }
              onClick={() =>
                patch({
                  command: {
                    type: board.timerRunning ? "timer_pause" : "timer_start",
                  },
                })
              }
            >
              {board.timerRunning ? (
                <PauseIcon className="h-5 w-5" />
              ) : (
                <PlayIcon className="h-5 w-5 pl-0.5" />
              )}
            </button>
            {!board.timerOtRoundMode && (
              <button
                type="button"
                className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
                onClick={() =>
                  patch({
                    command: { type: "reset_timer_regulation" },
                  })
                }
              >
                4:00
              </button>
            )}
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() => patch({ command: { type: "reset_timer_overtime" } })}
            >
              1:00
            </button>
            {!board.timerOtRoundMode && (
              <button
                type="button"
                className="rounded bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400"
                onClick={() => patch({ command: { type: "set_timer_rest_period" } })}
              >
                Rest
              </button>
            )}
          </div>
          )}
          {!board.timerOtRoundMode && (
          <div className="mt-2 flex flex-wrap gap-2">
            {!board.timerOtRoundMode && (
              <button
                type="button"
                className="rounded bg-sky-900 px-3 py-2 text-sm hover:bg-sky-800"
                onClick={() =>
                  patch({
                    command: { type: "adjust_timer_seconds", deltaSeconds: 60 },
                  })
                }
              >
                +1:00
              </button>
            )}
            {!board.timerOtRoundMode && (
              <button
                type="button"
                className="rounded bg-sky-900 px-3 py-2 text-sm hover:bg-sky-800"
                onClick={() =>
                  patch({
                    command: { type: "adjust_timer_seconds", deltaSeconds: -60 },
                  })
                }
              >
                -1:00
              </button>
            )}
            <button
              type="button"
              className="rounded bg-indigo-900 px-3 py-2 text-sm hover:bg-indigo-800"
              onClick={() =>
                patch({ command: { type: "adjust_timer_seconds", deltaSeconds: 10 } })
              }
            >
              +0:10
            </button>
            <button
              type="button"
              className="rounded bg-indigo-900 px-3 py-2 text-sm hover:bg-indigo-800"
              onClick={() =>
                patch({
                  command: { type: "adjust_timer_seconds", deltaSeconds: -10 },
                })
              }
            >
              -0:10
            </button>
            <button
              type="button"
              className="rounded bg-violet-900 px-3 py-2 text-sm hover:bg-violet-800"
              onClick={() =>
                patch({ command: { type: "adjust_timer_seconds", deltaSeconds: 1 } })
              }
            >
              +0:01
            </button>
            <button
              type="button"
              className="rounded bg-violet-900 px-3 py-2 text-sm hover:bg-violet-800"
              onClick={() =>
                patch({ command: { type: "adjust_timer_seconds", deltaSeconds: -1 } })
              }
            >
              -0:01
            </button>
          </div>
          )}
          {board.timerOtRoundMode && (
            <OtResultCard
              board={board}
              selection={otSelection}
              leftElapsed={otLeftElapsed}
              rightElapsed={otRightElapsed}
              onSelect={handleOtSelect}
              onLeftElapsedChange={setOtLeftElapsed}
              onRightElapsedChange={setOtRightElapsed}
              onSave={() => void commitOtIntermediate()}
              onUnsave={() => void commitOtUnsave()}
            />
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <div className="inline-flex items-center gap-1">
              <span className="text-[10px] font-semibold tracking-wide text-zinc-300">
                WARN
              </span>
              <select
                aria-label="Warning sound time"
                className="h-6 rounded border border-zinc-600 bg-zinc-900 px-1 text-[10px] font-semibold text-zinc-100"
                value={warningSelectValue}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "OFF") {
                    setWarningSelectOverride(null);
                    void patch({
                      command: {
                        type: "set_sound_warning",
                        enabled: false,
                        seconds: warningSeconds,
                      },
                    });
                    return;
                  }
                  if (value === "CUS") {
                    setWarningSelectOverride("CUS");
                    setCustomWarningDraft(
                      String(warningSeconds).padStart(2, "0").slice(-2),
                    );
                    void patch({
                      command: {
                        type: "set_sound_warning",
                        enabled: true,
                        seconds: warningSeconds,
                      },
                    });
                    return;
                  }
                  const seconds = Number(value);
                  setWarningSelectOverride(
                    board?.timerOtRoundMode && seconds !== 10 ? "30" : null,
                  );
                  setCustomWarningDraft(String(seconds).padStart(2, "0"));
                  void patch({
                    command: {
                      type: "set_sound_warning",
                      enabled: true,
                      seconds,
                    },
                  });
                }}
              >
                <option value="30">30</option>
                <option value="10">10</option>
                <option value="OFF">OFF</option>
                <option value="CUS">CUS</option>
              </select>
              {warningSelectValue === "CUS" ? (
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="^[0-9]{0,2}$"
                  maxLength={2}
                  aria-label="Custom warning seconds"
                  className="h-6 w-9 rounded border border-zinc-600 bg-zinc-900 px-1 text-center text-[10px] font-semibold text-zinc-100"
                  value={customWarningDraft}
                  onChange={(e) => {
                    const next = e.target.value.replace(/\D/g, "").slice(0, 2);
                    setCustomWarningDraft(next);
                    const seconds = Number(next);
                    if (seconds > 0) {
                      void patch({
                        command: {
                          type: "set_sound_warning",
                          enabled: true,
                          seconds,
                        },
                      });
                    }
                  }}
                  onBlur={() => {
                    const seconds = Math.max(1, Number(customWarningDraft) || 1);
                    const normalized = String(seconds).padStart(2, "0").slice(-2);
                    setCustomWarningDraft(normalized);
                    void patch({
                      command: {
                        type: "set_sound_warning",
                        enabled: true,
                        seconds,
                      },
                    });
                  }}
                />
              ) : null}
            </div>
            <div className="inline-flex items-center gap-1">
              <span className="text-[10px] font-semibold tracking-wide text-zinc-300">
                HORN:
              </span>
              <button
                type="button"
                aria-label={board.sound0Enabled ? "Disable air horn" : "Enable air horn"}
                className={[
                  "relative inline-flex h-6 w-6 items-center justify-center rounded border transition",
                  board.sound0Enabled
                    ? "border-emerald-500 bg-emerald-700/25 text-emerald-300"
                    : "border-zinc-600 bg-zinc-700/30 text-zinc-400",
                ].join(" ")}
                onClick={() =>
                  patch({
                    command: {
                      type: "set_sound_0_enabled",
                      enabled: !board.sound0Enabled,
                    },
                  })
                }
              >
                <SoundIcon className="h-3.5 w-3.5" />
                {!board.sound0Enabled ? (
                  <svg
                    className="pointer-events-none absolute inset-0 h-full w-full text-red-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden
                  >
                    <path d="M5 5l14 14" />
                  </svg>
                ) : null}
              </button>
            </div>
            <button
              type="button"
              className="rounded border border-zinc-600 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-800"
              onClick={() => {
                primeTimerAlertAudioFromUserGesture();
                void patch(
                  { command: { type: "play_sound_10_now" } },
                  { skipUndo: true },
                );
              }}
            >
              PLAY WARN
            </button>
            <button
              type="button"
              className="rounded border border-zinc-600 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-800"
              onClick={() => {
                primeTimerAlertAudioFromUserGesture();
                void patch(
                  { command: { type: "play_sound_0_now" } },
                  { skipUndo: true },
                );
              }}
            >
              PLAY HORN
            </button>
            <label className="ml-1 inline-flex items-center gap-1 text-[10px] text-zinc-300">
              VOL
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={audioVolume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setAudioVolume(v);
                  setAudioVolumePercent(v);
                }}
                className="h-2 w-20 accent-teal-500"
              />
              <span className="w-8 text-right tabular-nums">{audioVolume}</span>
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * OT-round intermediate result card (control timer card, OT mode only). Each
 * fighter gets SUB / ESC (toggle) plus an editable elapsed box, a shared DRAW
 * toggle and a save action. Saving appends to the in-card OT log and advances
 * the round. `TOT ESC:` tallies each fighter's escape time across the period.
 */
function OtResultCard({
  board,
  selection,
  leftElapsed,
  rightElapsed,
  onSelect,
  onLeftElapsedChange,
  onRightElapsedChange,
  onSave,
  onUnsave,
}: {
  board: BoardPayload;
  selection: OtSelection;
  leftElapsed: string;
  rightElapsed: string;
  onSelect: (sel: OtSelection) => void;
  onLeftElapsedChange: (v: string) => void;
  onRightElapsedChange: (v: string) => void;
  onSave: () => void;
  onUnsave: () => void;
}) {
  const log = board.otIntermediateLog ?? [];
  const isPicked = (side: "left" | "right", kind: "SUB" | "ESC") =>
    selection !== null &&
    selection !== "DRAW" &&
    selection.side === side &&
    selection.kind === kind;

  const renderRow = (
    side: "left" | "right",
    name: string,
    teamName: string,
    elapsed: string,
    onElapsed: (v: string) => void,
  ) => {
    const totEsc = totalEscapeSecondsForSide(log, side);
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-[5rem] flex-1 truncate text-[11px] font-semibold text-zinc-100">
          {name || (side === "left" ? "Left fighter" : "Right fighter")}
          {teamName.trim() ? (
            <span className="ml-1 font-normal text-zinc-400">
              · {teamName.trim()}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => onSelect({ side, kind: "SUB" })}
          className={[
            "rounded px-1.5 py-0.5 text-[11px] font-semibold transition",
            isPicked(side, "SUB")
              ? "bg-emerald-600 text-white ring-1 ring-emerald-300"
              : "bg-zinc-700 text-zinc-100 hover:bg-zinc-600",
          ].join(" ")}
        >
          SUB
        </button>
        <button
          type="button"
          onClick={() => onSelect({ side, kind: "ESC" })}
          className={[
            "rounded px-1.5 py-0.5 text-[11px] font-semibold transition",
            isPicked(side, "ESC")
              ? "bg-sky-600 text-white ring-1 ring-sky-300"
              : "bg-zinc-700 text-zinc-100 hover:bg-zinc-600",
          ].join(" ")}
        >
          ESC
        </button>
        <input
          type="text"
          inputMode="numeric"
          placeholder=":ss"
          aria-label={`${side} elapsed time`}
          value={elapsed}
          onChange={(e) => onElapsed(e.target.value)}
          className="h-6 w-9 rounded border border-zinc-600 bg-zinc-900 px-1 text-center font-mono text-[11px] text-zinc-100"
        />
        <span className="text-[11px] uppercase tracking-wide text-zinc-400">
          TOT ESC:{" "}
          <span className="font-bold text-white">{formatOtElapsedMmss(totEsc)}</span>
        </span>
      </div>
    );
  };

  return (
    <div className="mt-3 rounded-md border border-teal-800/50 bg-zinc-900/40 p-2">
      <div className="flex flex-col gap-1.5">
        {renderRow(
          "left",
          board.left?.displayName ?? "",
          board.left?.teamName ?? "",
          leftElapsed,
          onLeftElapsedChange,
        )}
        {renderRow(
          "right",
          board.right?.displayName ?? "",
          board.right?.teamName ?? "",
          rightElapsed,
          onRightElapsedChange,
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSelect("DRAW")}
          className={[
            "rounded px-2 py-0.5 text-[11px] font-semibold transition",
            selection === "DRAW"
              ? "bg-amber-500 text-black ring-1 ring-amber-300"
              : "bg-zinc-700 text-zinc-100 hover:bg-zinc-600",
          ].join(" ")}
        >
          DRAW
        </button>
        <button
          type="button"
          title="Save this half and advance"
          aria-label="Save OT half"
          onClick={onSave}
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-teal-700 text-white hover:bg-teal-600"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z" />
          </svg>
        </button>
        <button
          type="button"
          title="Undo the last saved half"
          aria-label="Undo last OT half"
          onClick={onUnsave}
          disabled={log.length === 0}
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-zinc-700 text-zinc-100 hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.97 7.97 0 0 1 12.5 11c2.86 0 5.29 1.87 6.16 4.45l2.36-.78C19.84 10.98 16.5 8 12.5 8z" />
          </svg>
        </button>
      </div>
      {log.length > 0 && (
        <div className="mt-2 max-h-32 overflow-auto rounded border border-zinc-800 bg-zinc-950/60 p-2">
          <ul className="space-y-0.5 font-mono text-[11px] leading-snug text-zinc-300">
            {log.map((entry, i) => (
              <li key={`${entry.createdAt}-${i}`}>{formatOtIntermediateLine(entry)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
