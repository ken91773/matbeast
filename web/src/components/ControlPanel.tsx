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
  getAudioVolumePercent,
  setAudioVolumePercent,
} from "@/lib/audio-output";
import type { BoardPayload } from "@/types/board";
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

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  "OT ROUND 1",
  "OT ROUND 2",
  "OT ROUND 3",
] as const;
const CUSTOM_PRESET = "CUSTOM";
const CUSTOM_FIGHTER = "__CUSTOM__";

export default function ControlPanel({
  standalone = false,
}: {
  standalone?: boolean;
}) {
  const { tournamentId, ready } = useEventWorkspace();
  const queryClient = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
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
  const [audioVolume, setAudioVolume] = useState(100);
  const [selectedBracketTeamIds, setSelectedBracketTeamIds] = useState<string[] | null>(
    null,
  );
  const [selectedBracketMatchId, setSelectedBracketMatchId] = useState<string | null>(
    null,
  );
  const firstBoardLoad = useRef(true);
  const patchRef = useRef<
    (body: Record<string, unknown>) => Promise<BoardPayload | null>
  >(async () => null);

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
      void patchRef.current({ command: { type: "reset_match" } });
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
    queryFn: async () => {
      const bRes = await matbeastFetch("/api/board", {
        cache: "no-store",
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      });
      if (!bRes.ok) {
        throw new Error("Board unavailable — did you run prisma db push?");
      }
      return (await bRes.json()) as BoardPayload;
    },
    enabled: ready && !!tournamentId,
    refetchInterval: 1000,
  });

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
        }>
      ).detail;
      if (!detail?.tournamentId || detail.tournamentId !== tournamentId) return;
      const ids = Array.isArray(detail.teamIds)
        ? detail.teamIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      setSelectedBracketTeamIds(ids.length > 0 ? ids : null);
      setSelectedBracketMatchId(
        typeof detail.matchId === "string" && detail.matchId.trim()
          ? detail.matchId
          : null,
      );
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

  useTimerAlertSounds(
    board?.secondsRemaining,
    tournamentId ?? undefined,
    board?.sound10Enabled,
    board?.sound0Enabled,
    board?.timerRestMode,
    board?.sound10PlayNonce,
    board?.sound0PlayNonce,
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
    queryClient.setQueryData(matbeastKeys.board(tournamentId), {
      ...j,
      resultsLog: Array.isArray(j.resultsLog) ? [...j.resultsLog] : [],
    });
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
      setShowFinalPanel(false);
      setFinalCorner(null);
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
    const updated = await patch({
      leftPlayerId: leftId && leftId !== CUSTOM_FIGHTER ? leftId : null,
      rightPlayerId: rightId && rightId !== CUSTOM_FIGHTER ? rightId : null,
      customLeftName:
        leftId === CUSTOM_FIGHTER ? leftCustomName.trim().toUpperCase() : null,
      customLeftTeamName:
        leftId === CUSTOM_FIGHTER
          ? leftCustomTeamName.trim().toUpperCase()
          : null,
      customRightName:
        rightId === CUSTOM_FIGHTER ? rightCustomName.trim().toUpperCase() : null,
      customRightTeamName:
        rightId === CUSTOM_FIGHTER
          ? rightCustomTeamName.trim().toUpperCase()
          : null,
      roundLabel,
    });
    if (updated) {
      setRoundLabel(updated.roundLabel);
      setRoundDirty(false);
    }
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
                <option value="OT ROUND 1">OT ROUND 1</option>
                <option value="OT ROUND 2">OT ROUND 2</option>
                <option value="OT ROUND 3">OT ROUND 3</option>
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
                setLeftId("");
                setRightId("");
                setLeftCustomName("");
                setLeftCustomTeamName("");
                setRightCustomName("");
                setRightCustomTeamName("");
                setRoundLabel("Quarter Finals");
                setRoundDirty(false);
                setShowFinalPanel(false);
                void patch({ command: { type: "clear_fields" } });
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
              <p className="text-sm font-medium text-zinc-300">Final result</p>
              <p className="mt-1 text-xs text-zinc-500">
                Tap a fighter for submission, escape, or DQ. Draw / no contest need
                no selection.
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
          <p
            className={`font-mono text-4xl ${
              board.timerRestMode ? "text-amber-300" : "text-white"
            }`}
          >
            {fmt(board.secondsRemaining)}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              title={board.timerRunning ? "Pause" : "Start"}
              aria-label={board.timerRunning ? "Pause timer" : "Start timer"}
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
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() =>
                patch({
                  command: { type: "set_timer_seconds", seconds: 300 },
                })
              }
            >
              Reset 5:00
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() =>
                patch({
                  command: { type: "reset_timer_regulation" },
                })
              }
            >
              Reset 4:00
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() => patch({ command: { type: "reset_timer_overtime" } })}
            >
              Reset 1:00
            </button>
            <button
              type="button"
              className="rounded bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400"
              onClick={() => patch({ command: { type: "set_timer_rest_period" } })}
            >
              1:00 Rest
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded bg-sky-900 px-3 py-2 text-sm hover:bg-sky-800"
              onClick={() =>
                patch({ command: { type: "adjust_timer_seconds", deltaSeconds: 60 } })
              }
            >
              +1:00
            </button>
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
          <div className="mt-2 flex flex-wrap gap-2">
            <div className="inline-flex items-center gap-1">
              <span className="text-[10px] font-semibold tracking-wide text-zinc-300">
                10S WARNING:
              </span>
              <button
                type="button"
                aria-label={board.sound10Enabled ? "Disable 10-second warning" : "Enable 10-second warning"}
                className={[
                  "relative inline-flex h-6 w-6 items-center justify-center rounded border transition",
                  board.sound10Enabled
                    ? "border-emerald-500 bg-emerald-700/25 text-emerald-300"
                    : "border-zinc-600 bg-zinc-700/30 text-zinc-400",
                ].join(" ")}
                onClick={() =>
                  patch({
                    command: {
                      type: "set_sound_10_enabled",
                      enabled: !board.sound10Enabled,
                    },
                  })
                }
              >
                <SoundIcon className="h-3.5 w-3.5" />
                {!board.sound10Enabled ? (
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
            <div className="inline-flex items-center gap-1">
              <span className="text-[10px] font-semibold tracking-wide text-zinc-300">
                AIR HORN:
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
              PLAY 10S
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
