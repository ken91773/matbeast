"use client";

import {
  SCOREBOARD_OT_MAIN_HEX,
  SCOREBOARD_OT_SUBLINE_HEX,
} from "@/lib/scoreboard-ot-colors";
import {
  CENTER_OT_STRIP,
  CENTER_TIMER,
  LEFT_PLAYER_STRIP,
  RIGHT_PLAYER_STRIP,
  LEFT_TEAM_STRIP,
  RIGHT_TEAM_STRIP,
  SCOREBOARD_VIEWBOX,
  type VbRect,
} from "@/lib/scoreboard-layout";
import type { BracketOverlaySlot } from "@/lib/bracket-overlay-model";
import type { BoardPayload } from "@/types/board";
import {
  scoreboardOtRedTimerStyle,
  scoreboardSubclockRoundLabelFromBoard,
  scoreboardTimerLineFromBoard,
} from "@/lib/scoreboard-timer-display";
import { finalWinnerIsLeft, finalWinnerIsRight } from "@/lib/board-final-display";
import { useEffect, useRef } from "react";

const STAGE_W = 1920;
const STAGE_H = 1080;
const OVERLAY_FONT_STACK = '"Bebas Neue", system-ui, sans-serif';

export type CssPctRect = {
  left: string;
  top: string;
  width: string;
  height: string;
};

function cssPctToPx(r: CssPctRect) {
  const x = (parseFloat(r.left) / 100) * STAGE_W;
  const y = (parseFloat(r.top) / 100) * STAGE_H;
  const w = (parseFloat(r.width) / 100) * STAGE_W;
  const h = (parseFloat(r.height) / 100) * STAGE_H;
  return { x, y, w, h };
}

function vbToPx(box: VbRect) {
  const { width: vw, height: vh } = SCOREBOARD_VIEWBOX;
  return {
    x: (box.x / vw) * STAGE_W,
    y: (box.y / vh) * STAGE_H,
    w: (box.width / vw) * STAGE_W,
    h: (box.height / vh) * STAGE_H,
  };
}

function drawCellText(
  ctx: CanvasRenderingContext2D,
  text: string,
  r: { x: number; y: number; w: number; h: number },
  opts: {
    align: CanvasTextAlign;
    font: string;
    fill: string;
    padX?: number;
    offsetY?: number;
  },
) {
  const pad = opts.padX ?? 8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.font = opts.font;
  ctx.fillStyle = opts.fill;
  ctx.textAlign = opts.align;
  ctx.textBaseline = "middle";
  const cx =
    opts.align === "center"
      ? r.x + r.w / 2
      : opts.align === "right"
        ? r.x + r.w - pad
        : r.x + pad;
  const cy = r.y + r.h / 2 + (opts.offsetY ?? 0);
  const maxW = Math.max(0, r.w - pad * 2);
  ctx.fillText(text, cx, cy, maxW);
  ctx.restore();
}

export type BracketSlotsBundle = {
  mode: 4 | 8;
  fourTeamSlots: BracketOverlaySlot[];
  quarterSlots: BracketOverlaySlot[];
  semiSlots: BracketOverlaySlot[];
  grandSlots: [BracketOverlaySlot, BracketOverlaySlot];
} | null;

export function OverlayCanvasTextLayer({
  scene,
  board,
  timerLine,
  roundLine,
  bracketMode,
  bracketSlots,
  fourTeamBoxes,
  quarterBoxes,
  eightSemiBoxes,
  eightGrandSplitBoxes,
  bracketOverlayEventTitle,
  bracketHighlightMatchId,
  bracketTeamFontSizePx,
  defaultTextColor,
}: {
  scene: "scoreboard" | "bracket";
  board: BoardPayload | undefined;
  timerLine: string;
  roundLine: string;
  bracketMode: 4 | 8;
  bracketSlots: BracketSlotsBundle;
  fourTeamBoxes: CssPctRect[];
  quarterBoxes: CssPctRect[];
  eightSemiBoxes: CssPctRect[];
  eightGrandSplitBoxes: readonly [CssPctRect, CssPctRect] | null;
  bracketOverlayEventTitle: string;
  bracketHighlightMatchId: string | null;
  bracketTeamFontSizePx: number;
  defaultTextColor: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = () => {
      try {
        const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
        canvas.width = Math.round(STAGE_W * dpr);
        canvas.height = Math.round(STAGE_H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, STAGE_W, STAGE_H);

        if (scene === "bracket") {
          const font = `${bracketTeamFontSizePx}px ${OVERLAY_FONT_STACK}`;
          const drawSlot = (slot: BracketOverlaySlot | undefined, rect: CssPctRect | undefined) => {
            if (!rect) return;
            const r = cssPctToPx(rect);
            if (slot?.backgroundColor) {
              ctx.fillStyle = slot.backgroundColor;
              ctx.fillRect(r.x, r.y, r.w, r.h);
            }
            const label = (slot?.text ?? "").trim() || " ";
            drawCellText(ctx, label, r, {
              align: "center",
              font,
              fill: slot?.color ?? defaultTextColor,
              offsetY: 2,
            });
            if (
              slot?.matchId &&
              bracketHighlightMatchId &&
              slot.matchId === bracketHighlightMatchId
            ) {
              ctx.save();
              ctx.strokeStyle = "rgb(234, 179, 8)";
              ctx.lineWidth = 3;
              ctx.shadowColor = "rgba(234, 179, 8, 0.85)";
              ctx.shadowBlur = 16;
              ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
              ctx.shadowBlur = 0;
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = "rgba(254, 243, 199, 0.95)";
              ctx.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
              ctx.restore();
            }
          };

          if (bracketMode === 4) {
            for (let i = 0; i < fourTeamBoxes.length; i++) {
              const slot = bracketSlots?.fourTeamSlots[i];
              drawSlot(slot, fourTeamBoxes[i]);
            }
          } else {
            for (let i = 0; i < quarterBoxes.length; i++) {
              drawSlot(bracketSlots?.quarterSlots[i], quarterBoxes[i]);
            }
            for (let i = 0; i < eightSemiBoxes.length; i++) {
              const slot = bracketSlots?.semiSlots[i];
              drawSlot(slot, eightSemiBoxes[i]);
            }
            if (eightGrandSplitBoxes) {
              for (let i = 0; i < 2; i++) {
                const slot = bracketSlots?.grandSlots[i];
                drawSlot(slot, eightGrandSplitBoxes[i]);
              }
            }
          }

          ctx.save();
          ctx.font = `72px ${OVERLAY_FONT_STACK}`;
          ctx.fillStyle = defaultTextColor;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(bracketOverlayEventTitle, STAGE_W / 2, STAGE_H - 138, STAGE_W * 0.92);
          ctx.restore();
          return;
        }

        /** Scoreboard */
        const timerR = vbToPx(CENTER_TIMER);
        const rest = Boolean(board?.timerRestMode);
        const otRed = scoreboardOtRedTimerStyle(board ?? undefined);
        const timerColor = rest ? "#fcd34d" : otRed ? SCOREBOARD_OT_MAIN_HEX : "#e5e7eb";
        const roundColor = rest ? "#fcd34d" : otRed ? SCOREBOARD_OT_SUBLINE_HEX : "#d9d9d9";
        const line =
          timerLine.trim().length > 0
            ? timerLine
            : scoreboardTimerLineFromBoard(board ?? undefined);

    ctx.save();
    ctx.font = `bold 132px ${OVERLAY_FONT_STACK}`;
    ctx.fillStyle = timerColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(line, timerR.x + timerR.w / 2, timerR.y + timerR.h * 0.42, timerR.w - 16);

    ctx.font = `600 38px ${OVERLAY_FONT_STACK}`;
    ctx.fillStyle = roundColor;
    const roundText =
      roundLine.trim().length > 0
        ? roundLine
        : scoreboardSubclockRoundLabelFromBoard(board ?? undefined);
    ctx.fillText(roundText, timerR.x + timerR.w / 2, timerR.y + timerR.h * 0.78, timerR.w - 16);
    ctx.restore();

    if (board && board.timerPhase === "OVERTIME") {
      const ot = vbToPx(CENTER_OT_STRIP);
      const line = `OT ${board.overtimeIndex} · L${board.overtimeWinsLeft} R${board.overtimeWinsRight}`;
      drawCellText(ctx, line, ot, {
        align: "center",
        font: `600 40px ${OVERLAY_FONT_STACK}`,
        fill: "#fde68a",
      });
    }

    const stripPlayerName = (side: "left" | "right") => {
      const p = side === "left" ? board?.left : board?.right;
      const dn = (p?.displayName ?? "").trim();
      const raw = (dn || (p?.lastName ?? "").trim()).trim();
      return raw.toUpperCase() || "—";
    };

    const leftPlayer = vbToPx(LEFT_PLAYER_STRIP);
    const leftName = stripPlayerName("left");
    const leftWin =
      board?.finalSaved &&
      (board.showFinalWinnerHighlight ?? true) &&
      finalWinnerIsLeft(board.finalResultType ?? null);
    drawCellText(ctx, leftName, leftPlayer, {
      align: "right",
      font: `bold 57.6px ${OVERLAY_FONT_STACK}`,
      fill: leftWin ? "#34d399" : "#d9d9d9",
      padX: 24,
      offsetY: 4,
    });

    const leftTeam = vbToPx(LEFT_TEAM_STRIP);
    drawCellText(ctx, (board?.left?.teamName ?? "").toUpperCase(), leftTeam, {
      align: "right",
      font: `500 40px ${OVERLAY_FONT_STACK}`,
      fill: "#d9d9d9",
      padX: 24,
      offsetY: 2,
    });

    const rightPlayer = vbToPx(RIGHT_PLAYER_STRIP);
    const rightName = stripPlayerName("right");
    const rightWin =
      board?.finalSaved &&
      (board.showFinalWinnerHighlight ?? true) &&
      finalWinnerIsRight(board.finalResultType ?? null);
    drawCellText(ctx, rightName, rightPlayer, {
      align: "left",
      font: `bold 57.6px ${OVERLAY_FONT_STACK}`,
      fill: rightWin ? "#34d399" : "#d9d9d9",
      padX: 24,
      offsetY: 4,
    });

        const rightTeam = vbToPx(RIGHT_TEAM_STRIP);
        drawCellText(ctx, (board?.right?.teamName ?? "").toUpperCase(), rightTeam, {
          align: "left",
          font: `500 40px ${OVERLAY_FONT_STACK}`,
          fill: "#d9d9d9",
          padX: 24,
          offsetY: 2,
        });
      } catch (error) {
        console.error("[overlay-canvas] draw failed", error);
      }
    };

    draw();
    const fontsApi = (typeof document !== "undefined" ? document.fonts : undefined) as
      | FontFaceSet
      | undefined;
    if (!fontsApi) return;
    if (fontsApi.status !== "loaded") {
      void fontsApi.ready.then(() => {
        draw();
      });
    }
  }, [
    scene,
    board,
    timerLine,
    roundLine,
    bracketMode,
    bracketSlots,
    fourTeamBoxes,
    quarterBoxes,
    eightSemiBoxes,
    eightGrandSplitBoxes,
    bracketOverlayEventTitle,
    bracketHighlightMatchId,
    bracketTeamFontSizePx,
    defaultTextColor,
  ]);

  return (
    <canvas
      ref={ref}
      width={STAGE_W}
      height={STAGE_H}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 200,
        pointerEvents: "none",
      }}
    />
  );
}
