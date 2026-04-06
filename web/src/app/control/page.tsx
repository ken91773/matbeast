"use client";

import type { BoardPayload } from "@/types/board";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Player = {
  id: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  lineupOrder: number;
  team: { name: string };
};

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function displayName(p: Player) {
  const last = p.lastName.trim();
  return last || `${p.firstName} ${p.lastName}`.trim();
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

export default function ControlPage() {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
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
  const firstBoardLoad = useRef(true);
  const boardLoadInFlight = useRef(false);
  const latestBoardSeq = useRef(0);
  const playersLoadInFlight = useRef(false);

  const loadPlayers = useCallback(async () => {
    if (playersLoadInFlight.current) return;
    playersLoadInFlight.current = true;
    try {
      const pRes = await fetch("/api/players", { cache: "no-store" });
      if (!pRes.ok) {
        setErr("Could not load players");
        return;
      }
      const pJson = (await pRes.json()) as { players: Player[] };
      setPlayers(pJson.players);
    } finally {
      playersLoadInFlight.current = false;
    }
  }, []);

  const loadBoard = useCallback(async () => {
    if (boardLoadInFlight.current) return;
    boardLoadInFlight.current = true;
    const seq = ++latestBoardSeq.current;
    setErr(null);
    try {
      const bRes = await fetch("/api/board", { cache: "no-store" });
      if (seq !== latestBoardSeq.current) return;
      if (!bRes.ok) {
        setErr("Board unavailable — did you run prisma db push?");
        return;
      }
      const b = (await bRes.json()) as BoardPayload;
      if (seq !== latestBoardSeq.current) return;
      setBoard(b);
      if (!roundDirty) {
        setRoundLabel(b.roundLabel);
      }
      if (firstBoardLoad.current) {
        setLeftId(
          b.customLeftName?.trim()
            ? CUSTOM_FIGHTER
            : (b.leftPlayerId ?? ""),
        );
        setRightId(
          b.customRightName?.trim()
            ? CUSTOM_FIGHTER
            : (b.rightPlayerId ?? ""),
        );
        setLeftCustomName(b.customLeftName ?? "");
        setLeftCustomTeamName(b.customLeftTeamName ?? "");
        setRightCustomName(b.customRightName ?? "");
        setRightCustomTeamName(b.customRightTeamName ?? "");
        firstBoardLoad.current = false;
      }
    } finally {
      boardLoadInFlight.current = false;
    }
  }, [roundDirty]);

  useEffect(() => {
    void loadPlayers();
    void loadBoard();
    const playersInterval = setInterval(() => {
      void loadPlayers();
    }, 15000);

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await loadBoard();
      if (cancelled) return;
      setTimeout(tick, 1000);
    };
    const starter = setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      clearTimeout(starter);
      clearInterval(playersInterval);
    };
  }, [loadBoard, loadPlayers]);

  async function patch(
    body: Record<string, unknown>,
  ): Promise<BoardPayload | null> {
    setErr(null);
    const res = await fetch("/api/board", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "Update failed";
      try {
        const j = (await res.json()) as { error?: string; hint?: string };
        msg = [j.error, j.hint].filter(Boolean).join(" — ") || msg;
      } catch {
        // keep default message
      }
      setErr(msg);
      return null;
    }
    const j = (await res.json()) as BoardPayload;
    setBoard(j);
    setLeftId(j.customLeftName?.trim() ? CUSTOM_FIGHTER : (j.leftPlayerId ?? ""));
    setRightId(
      j.customRightName?.trim() ? CUSTOM_FIGHTER : (j.rightPlayerId ?? ""),
    );
    setLeftCustomName(j.customLeftName ?? "");
    setLeftCustomTeamName(j.customLeftTeamName ?? "");
    setRightCustomName(j.customRightName ?? "");
    setRightCustomTeamName(j.customRightTeamName ?? "");
    return j;
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
    return (
      <div className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
        <p className="text-zinc-400">{err ?? "Loading board…"}</p>
        {err && (
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

  const pOpts = players
    .slice()
    .sort((a, b) => {
      const tn = a.team.name.localeCompare(b.team.name);
      if (tn !== 0) return tn;
      return a.lineupOrder - b.lineupOrder;
    });

  const presetValue = ROUND_PRESETS.includes(
    roundLabel as (typeof ROUND_PRESETS)[number],
  )
    ? roundLabel
    : CUSTOM_PRESET;
  const winnerLabel = board.finalWinnerName
    ? board.finalWinnerName.trim().split(/\s+/).slice(-1)[0] ?? board.finalWinnerName
    : "";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold">Mat control</h1>
        <p className="text-sm text-zinc-400">
          Current roster file:{" "}
          <span className="font-semibold text-zinc-200">
            {board.currentRosterFileName || "UNTITLED"}
          </span>
        </p>
        <nav className="flex gap-3 text-sm text-zinc-400">
          <Link className="hover:text-white" href="/">
            Home
          </Link>
          <Link className="hover:text-white" href="/roster">
            Roster
          </Link>
          <Link className="hover:text-white" href="/overlay" target="_blank">
            Overlay
          </Link>
        </nav>
      </header>

      {err && (
        <p className="mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-red-200">
          {err}
        </p>
      )}

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-3 font-medium text-zinc-300">Fighters & round</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm text-zinc-500">Left corner</label>
              <select
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2"
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
              {leftId === CUSTOM_FIGHTER && (
                <div className="mt-2 grid gap-2">
                  <input
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 uppercase"
                    value={leftCustomName}
                    onChange={(e) => setLeftCustomName(e.target.value.toUpperCase())}
                    placeholder="CUSTOM LEFT NAME"
                  />
                  <input
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 uppercase"
                    value={leftCustomTeamName}
                    onChange={(e) =>
                      setLeftCustomTeamName(e.target.value.toUpperCase())
                    }
                    placeholder="CUSTOM LEFT TEAM"
                  />
                </div>
              )}
            </div>
            <div>
              <label className="text-sm text-zinc-500">Right corner</label>
              <select
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2"
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
              {rightId === CUSTOM_FIGHTER && (
                <div className="mt-2 grid gap-2">
                  <input
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 uppercase"
                    value={rightCustomName}
                    onChange={(e) => setRightCustomName(e.target.value.toUpperCase())}
                    placeholder="CUSTOM RIGHT NAME"
                  />
                  <input
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 uppercase"
                    value={rightCustomTeamName}
                    onChange={(e) =>
                      setRightCustomTeamName(e.target.value.toUpperCase())
                    }
                    placeholder="CUSTOM RIGHT TEAM"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="mt-3">
            <label className="text-sm text-zinc-500">Round label</label>
            <div className="mt-1 flex flex-wrap gap-2">
              <select
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm"
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
                className="min-w-[180px] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-2"
                value={roundLabel}
                onChange={(e) => {
                  setRoundLabel(e.target.value);
                  setRoundDirty(true);
                }}
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-start gap-2">
            <button
              type="button"
              className="rounded bg-amber-600 px-4 py-2 font-medium text-black hover:bg-amber-500"
              onClick={() => applyFighters()}
            >
              Apply to board
            </button>
            <button
              type="button"
              className="rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-600"
              onClick={() => setShowFinalPanel((s) => !s)}
            >
              FINAL
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-4 py-2 font-medium text-white hover:bg-zinc-600"
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
              className="rounded bg-red-800 px-4 py-2 font-medium text-white hover:bg-red-700 disabled:opacity-50"
              disabled={!board.finalSaved}
              onClick={() => void patch({ command: { type: "final_unsave" } })}
            >
              UNSAVE
            </button>
          </div>
          {showFinalPanel && (
            <div className="mt-3 rounded border border-zinc-700 bg-zinc-950/60 p-3">
              <label className="text-sm text-zinc-400">
                Final result (click to save)
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
                  onClick={async () => {
                    const saved = await patch({
                      leftPlayerId:
                        leftId && leftId !== CUSTOM_FIGHTER ? leftId : null,
                      rightPlayerId:
                        rightId && rightId !== CUSTOM_FIGHTER ? rightId : null,
                      customLeftName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomName.trim().toUpperCase()
                          : null,
                      customLeftTeamName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomTeamName.trim().toUpperCase()
                          : null,
                      customRightName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomName.trim().toUpperCase()
                          : null,
                      customRightTeamName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomTeamName.trim().toUpperCase()
                          : null,
                      roundLabel,
                      command: { type: "final_save", resultType: "LEFT" },
                    });
                    if (saved) setShowFinalPanel(false);
                  }}
                >
                  {board.left?.displayName?.trim() || "LEFT FIGHTER"}
                </button>
                <button
                  type="button"
                  className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
                  onClick={async () => {
                    const saved = await patch({
                      leftPlayerId:
                        leftId && leftId !== CUSTOM_FIGHTER ? leftId : null,
                      rightPlayerId:
                        rightId && rightId !== CUSTOM_FIGHTER ? rightId : null,
                      customLeftName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomName.trim().toUpperCase()
                          : null,
                      customLeftTeamName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomTeamName.trim().toUpperCase()
                          : null,
                      customRightName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomName.trim().toUpperCase()
                          : null,
                      customRightTeamName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomTeamName.trim().toUpperCase()
                          : null,
                      roundLabel,
                      command: { type: "final_save", resultType: "RIGHT" },
                    });
                    if (saved) setShowFinalPanel(false);
                  }}
                >
                  {board.right?.displayName?.trim() || "RIGHT FIGHTER"}
                </button>
                <button
                  type="button"
                  className="rounded bg-zinc-700 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-600"
                  onClick={async () => {
                    const saved = await patch({
                      leftPlayerId:
                        leftId && leftId !== CUSTOM_FIGHTER ? leftId : null,
                      rightPlayerId:
                        rightId && rightId !== CUSTOM_FIGHTER ? rightId : null,
                      customLeftName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomName.trim().toUpperCase()
                          : null,
                      customLeftTeamName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomTeamName.trim().toUpperCase()
                          : null,
                      customRightName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomName.trim().toUpperCase()
                          : null,
                      customRightTeamName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomTeamName.trim().toUpperCase()
                          : null,
                      roundLabel,
                      command: { type: "final_save", resultType: "DRAW" },
                    });
                    if (saved) setShowFinalPanel(false);
                  }}
                >
                  DRAW
                </button>
                <button
                  type="button"
                  className="rounded bg-zinc-700 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-600"
                  onClick={async () => {
                    const saved = await patch({
                      leftPlayerId:
                        leftId && leftId !== CUSTOM_FIGHTER ? leftId : null,
                      rightPlayerId:
                        rightId && rightId !== CUSTOM_FIGHTER ? rightId : null,
                      customLeftName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomName.trim().toUpperCase()
                          : null,
                      customLeftTeamName:
                        leftId === CUSTOM_FIGHTER
                          ? leftCustomTeamName.trim().toUpperCase()
                          : null,
                      customRightName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomName.trim().toUpperCase()
                          : null,
                      customRightTeamName:
                        rightId === CUSTOM_FIGHTER
                          ? rightCustomTeamName.trim().toUpperCase()
                          : null,
                      roundLabel,
                      command: { type: "final_save", resultType: "NO_CONTEST" },
                    });
                    if (saved) setShowFinalPanel(false);
                  }}
                >
                  NO CONTEST
                </button>
                <button
                  type="button"
                  className="rounded border border-zinc-600 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
                  onClick={() => setShowFinalPanel(false)}
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
          {board.finalSaved && board.finalResultType === "LEFT" && (
            <p className="mt-3 text-sm font-semibold text-emerald-400">
              WINNER: {winnerLabel}
            </p>
          )}
          {board.finalSaved && board.finalResultType === "RIGHT" && (
            <p className="mt-3 text-sm font-semibold text-emerald-400">
              WINNER: {winnerLabel}
            </p>
          )}
          {board.finalSaved && board.finalResultType === "DRAW" && (
            <p className="mt-3 text-sm font-semibold text-zinc-400">DRAW</p>
          )}
          {board.finalSaved && board.finalResultType === "NO_CONTEST" && (
            <p className="mt-3 text-sm font-semibold text-zinc-400">
              NO CONTEST
            </p>
          )}
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-3 font-medium text-zinc-300">Timer</h2>
          <p className="font-mono text-4xl text-white">
            {fmt(board.secondsRemaining)}
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            {board.timerPhase === "REGULATION" ? "Regulation" : "Overtime"} · OT
            period {board.overtimeIndex} · OT wins L
            {board.overtimeWinsLeft} R{board.overtimeWinsRight}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded bg-green-800 px-3 py-2 text-sm hover:bg-green-700"
              onClick={() => patch({ command: { type: "timer_start" } })}
            >
              Start
            </button>
            <button
              type="button"
              className="rounded bg-yellow-800 px-3 py-2 text-sm hover:bg-yellow-700"
              onClick={() => patch({ command: { type: "timer_pause" } })}
            >
              Pause
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() => patch({ command: { type: "reset_timer_regulation" } })}
            >
              Reset to 4:00
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() => patch({ command: { type: "reset_timer_overtime" } })}
            >
              Reset to 1:00
            </button>
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
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-3 font-medium text-zinc-300">
            Quintet eliminations (inner-first X on overlay)
          </h2>
          <p className="mb-3 text-sm text-zinc-500">
            Left: {board.leftEliminatedCount} · Right:{" "}
            {board.rightEliminatedCount}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded bg-red-900 px-3 py-2 text-sm hover:bg-red-800"
              onClick={() => patch({ command: { type: "eliminate_left" } })}
            >
              − Left fighter
            </button>
            <button
              type="button"
              className="rounded bg-red-900 px-3 py-2 text-sm hover:bg-red-800"
              onClick={() => patch({ command: { type: "eliminate_right" } })}
            >
              − Right fighter
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() => patch({ command: { type: "undo_eliminate_left" } })}
            >
              Undo left
            </button>
            <button
              type="button"
              className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
              onClick={() => patch({ command: { type: "undo_eliminate_right" } })}
            >
              Undo right
            </button>
          </div>
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-3 font-medium text-zinc-300">Overtime (best of 3)</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded bg-blue-900 px-3 py-2 text-sm hover:bg-blue-800"
              onClick={() => patch({ command: { type: "ot_round_win_left" } })}
            >
              OT round → Left
            </button>
            <button
              type="button"
              className="rounded bg-blue-900 px-3 py-2 text-sm hover:bg-blue-800"
              onClick={() => patch({ command: { type: "ot_round_win_right" } })}
            >
              OT round → Right
            </button>
          </div>
          <button
            type="button"
            className="mt-6 rounded border border-zinc-600 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            onClick={() => {
              if (
                confirm(
                  "Full reset: timer, OT scores, eliminations — keep fighters?",
                )
              ) {
                patch({ command: { type: "reset_match" } });
              }
            }}
          >
            Full match reset (timer + OT + eliminations)
          </button>
        </section>
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 lg:col-span-2">
          <h2 className="mb-3 font-medium text-zinc-300">Results log</h2>
          {board.resultsLog.length === 0 ? (
            <p className="text-sm text-zinc-500">No saved final results yet.</p>
          ) : (
            <div className="max-h-60 overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="py-1">Time</th>
                    <th className="py-1">Roster file</th>
                    <th className="py-1">Round</th>
                    <th className="py-1">Left</th>
                    <th className="py-1">Right</th>
                    <th className="py-1">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {board.resultsLog.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-800">
                      <td className="py-1 text-zinc-400">
                        {new Date(r.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="py-1">{r.rosterFileName}</td>
                      <td className="py-1">{r.roundLabel}</td>
                      <td className="py-1">{r.leftName}</td>
                      <td className="py-1">{r.rightName}</td>
                      <td className="py-1">
                        {r.winnerName ? (
                          <span className="font-semibold text-emerald-400">
                            {r.winnerName}
                          </span>
                        ) : (
                          r.resultType.replace("_", " ")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
