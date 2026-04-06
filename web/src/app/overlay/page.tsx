"use client";

import type { BoardPayload } from "@/types/board";
import {
  CENTER_OT_STRIP,
  CENTER_TIMER,
  vbRectToPercentStyle,
} from "@/lib/scoreboard-layout";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

const W = 1920;
const H = 1080;

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function SilhouetteRow({
  side,
  crossed,
}: {
  side: "left" | "right";
  crossed: number[];
}) {
  const crossedSet = new Set(crossed);
  const order = [0, 1, 2, 3, 4];
  const flexDir = side === "left" ? "flex-row" : "flex-row-reverse";
  return (
    <div className={`flex ${flexDir} items-end justify-center gap-3`}>
      {order.map((idx) => (
        <div
          key={idx}
          className="relative flex h-16 w-10 items-end justify-center"
        >
          <div
            className="h-14 w-8 rounded-t-full border-2 border-white/80 bg-black/30"
            aria-hidden
          />
          {crossedSet.has(idx) && (
            <img
              src="/redx.png"
              alt=""
              className="pointer-events-none absolute inset-0 m-auto h-[85%] w-[85%] object-contain drop-shadow-[0_0_6px_rgba(0,0,0,0.95)]"
              aria-hidden
            />
          )}
        </div>
      ))}
    </div>
  );
}

export default function OverlayPage() {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [scale, setScale] = useState(1);
  const pollInFlight = useRef(false);

  const poll = useCallback(async () => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const res = await fetch("/api/board", { cache: "no-store" });
      if (res.ok) setBoard((await res.json()) as BoardPayload);
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    function fit() {
      const sx = window.innerWidth / W;
      const sy = window.innerHeight / H;
      setScale(Math.min(sx, sy));
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-zinc-600">
      <a
        href="/control"
        className="fixed left-2 top-2 z-50 rounded bg-black/60 px-2 py-1 text-xs text-zinc-400 hover:text-white"
      >
        Control
      </a>
      <Link
        href="/"
        className="fixed right-2 top-2 z-50 rounded bg-black/60 px-2 py-1 text-xs text-zinc-400 hover:text-white"
      >
        Home
      </Link>

      <div
        style={{
          width: W,
          height: H,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
        className="relative shrink-0 overflow-hidden bg-zinc-600 shadow-2xl"
      >
        {/* Background art */}
        <img
          src="/scoreboard.svg"
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-fill"
          draggable={false}
        />

        {/* Dynamic layer — regions from SVG viewBox (see scoreboard-layout.ts) */}
        <div className="absolute inset-0 text-white">
          {/* Time + round — both inside path252 center cell; round sits under the clock */}
          <div
            className="absolute flex flex-col items-center justify-center gap-0 overflow-hidden px-2 [container-type:size]"
            style={vbRectToPercentStyle(CENTER_TIMER)}
          >
            <span
              className="shrink-0 px-1 text-center font-black leading-none tabular-nums drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)]"
              style={{
                fontSize: "clamp(4.05rem, 75.6cqh, 12.15rem)",
                lineHeight: 1,
              }}
            >
              {board ? fmt(board.secondsRemaining) : "—:—"}
            </span>
            <span
              className="w-full min-w-0 max-w-full text-center font-semibold uppercase leading-none text-zinc-100 drop-shadow-[0_2px_8px_black]"
              style={{
                fontSize: "clamp(0.995rem, 42.84cqh, 2.83rem)",
                lineHeight: 1,
                /* Pull up toward digits (font metrics add default gap) */
                marginTop: "-0.18em",
              }}
            >
              {board?.roundLabel ?? ""}
            </span>
          </div>

          {/* OT readout — path300 strip */}
          {board && board.timerPhase === "OVERTIME" && (
            <div
              className="absolute flex items-center justify-center overflow-hidden [container-type:size]"
              style={vbRectToPercentStyle(CENTER_OT_STRIP)}
            >
              <span
                className="text-center font-semibold tabular-nums text-amber-200 drop-shadow-[0_2px_6px_black]"
                style={{ fontSize: "clamp(1rem, 44cqh, 2.7rem)" }}
              >
                OT {board.overtimeIndex} · L{board.overtimeWinsLeft} R
                {board.overtimeWinsRight}
              </span>
            </div>
          )}

          {/* Left name / team */}
          <div className="absolute left-[6%] top-[22%] w-[26%] text-left">
            <div
              className={`font-bold leading-tight drop-shadow-[0_2px_8px_black] ${
                board?.finalSaved && board.finalResultType === "LEFT"
                  ? "text-emerald-400"
                  : ""
              }`}
              style={{ fontSize: "4.5rem" }}
            >
              {board?.left?.displayName ?? "—"}
            </div>
            <div
              className="mt-1 font-medium text-zinc-200 drop-shadow-[0_2px_6px_black]"
              style={{ fontSize: "3rem" }}
            >
              {board?.left?.teamName ?? ""}
            </div>
          </div>

          {/* Right name / team */}
          <div className="absolute right-[6%] top-[22%] w-[26%] text-right">
            <div
              className={`font-bold leading-tight drop-shadow-[0_2px_8px_black] ${
                board?.finalSaved && board.finalResultType === "RIGHT"
                  ? "text-emerald-400"
                  : ""
              }`}
              style={{ fontSize: "4.5rem" }}
            >
              {board?.right?.displayName ?? "—"}
            </div>
            <div
              className="mt-1 font-medium text-zinc-200 drop-shadow-[0_2px_6px_black]"
              style={{ fontSize: "3rem" }}
            >
              {board?.right?.teamName ?? ""}
            </div>
          </div>

          {/* Health / silhouettes */}
          <div className="absolute bottom-[14%] left-[8%] w-[32%]">
            <SilhouetteRow
              side="left"
              crossed={board?.leftCrossedSilhouettes ?? []}
            />
          </div>
          <div className="absolute bottom-[14%] right-[8%] w-[32%]">
            <SilhouetteRow
              side="right"
              crossed={board?.rightCrossedSilhouettes ?? []}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
