"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Two-team list overlay rendered inside the scoreboard output window.
 * Sits in a fixed 1920×1080 vertical band (y 316 → 503) and crossfades in
 * when the dashboard APPLIES teams mode.
 *
 * Format (locked 2026-04-17, logo added 2026-04-17):
 * - Font: Oswald 700 (team label, color `#99c5ff`) + Oswald 400 (players,
 *   color `#d9d9d9`) at 40 px.
 * - One line per team, `TEAMNAME:␠␠␠␠NAME1␠␠␠␠NAME2…` (4 spaces throughout).
 * - Team name + player names uppercased. Player order = lineupOrder asc,
 *   skipping TBD / empty slots. Always "FIRST LAST" (no nickname). Player
 *   list capped upstream at 5 (starters only).
 * - Logo (`/CHAMPIONSHIP.png`, 50 px tall, auto width) sits at the top of the
 *   gradient box with a 16 px gap above the first team line. Its measured
 *   width participates in the shrink-to-fit calc so a future wider logo still
 *   stays inside the 1920 canvas.
 * - One team → line vertically centered (logo above). Two teams → both
 *   centered with ~0.5-line (≈ 20 px) gap between them, logo above.
 * - Background: content-hugging rect, padding ≈ 32 px horizontal / 20 px
 *   vertical, 0.5 px border `#d9d9d9`. Filled with `/bgteam.png` (1920×187)
 *   centered at native resolution so the rectangle crops the image around
 *   its center; any rectangle overflow falls through to a solid black
 *   fallback. The background image does NOT scale with the content — it's a
 *   separate fixed-size layer behind the transformed content, so long
 *   rosters / 2-team shrink-to-fit only shrink text+logo.
 * - Shrink-to-fit: the content wrapper (logo + team lines + padding) is
 *   measured at its natural size, then a single uniform scale is applied so
 *   the wrapper fits into the 1920 × 187 band (horizontal: keep a 24 px
 *   safety margin per side; vertical: cap at 187 px). The rectangle is then
 *   sized to the scaled content so the border hugs the visible content —
 *   critical for the 2-team case, which is naturally ~206 px tall and must
 *   be clamped to 187 px per spec.
 */

const BAND_TOP_PX = 316;
const BAND_BOTTOM_PX = 503;
const BAND_HEIGHT_PX = BAND_BOTTOM_PX - BAND_TOP_PX;
const CANVAS_WIDTH_PX = 1920;
const FONT_SIZE_PX = 40;
const LINE_GAP_PX = Math.round(FONT_SIZE_PX * 0.5);
const PADDING_X_PX = 32;
const PADDING_Y_PX = 20;
/** Horizontal cap: rectangle may span up to the 1920 canvas width minus a
 *  48 px safety margin per side (max border-box width = 1824 px). Long
 *  rosters trigger shrink-to-fit; shorter rosters render at natural width
 *  and center inside the band. */
const CANVAS_EDGE_PADDING_PX = 48;
const MAX_RECT_WIDTH_PX = CANVAS_WIDTH_PX - CANVAS_EDGE_PADDING_PX * 2;
/** Vertical cap: the rectangle must fit inside the 187 px band. When the
 *  natural content height exceeds this (2-team layouts are ~206 px tall), a
 *  uniform content scale is applied so the rectangle ends up at exactly
 *  `BAND_HEIGHT_PX` tall. 1-team layouts (~146 px natural) sit under this
 *  cap so they render at their natural size. */
const MAX_RECT_HEIGHT_PX = BAND_HEIGHT_PX;
/** Logo dimensions: intrinsic 50 px tall (aspect ratio preserved via `width:
 *  auto`). `LOGO_GAP_PX` is the space between the bottom of the logo and the
 *  top of the first team line. Both are scaled together with the lines via
 *  the enclosing `transform: scale()` when shrink-to-fit kicks in. */
const LOGO_SRC = "/CHAMPIONSHIP.png";
const LOGO_HEIGHT_PX = 50;
const LOGO_GAP_PX = 16;
const TEAM_NAME_COLOR = "#99c5ff";
const PLAYER_NAME_COLOR = "#d9d9d9";
/** Highlighted player styling. Yellow text with a continuously pulsing
 *  ("breathing") yellow glow that runs as long as the player is selected.
 *  The color is driven by a 1 s CSS transition (smooth fade between
 *  default and highlight hue on click / unclick); the `text-shadow` is
 *  driven by the `matbeastTeamGlow` keyframe animation defined inline
 *  below, which pulses shadow radius + alpha between a gentle baseline
 *  and a punchy peak every `BREATHE_CYCLE_MS`. Non-highlighted names fall
 *  through to `PLAYER_NAME_COLOR` with no shadow and no animation. */
const PLAYER_HIGHLIGHT_COLOR = "#ffec4d";
const PLAYER_HIGHLIGHT_TRANSITION_MS = 1000;
const BREATHE_ANIMATION_NAME = "matbeastTeamGlow";
const BREATHE_CYCLE_MS = 2000;
/** Single inline stylesheet (mounted once per overlay-layer instance) that
 *  registers the breathing keyframe. Inlined instead of putting it in
 *  `overlay/layout.tsx` so the animation stays co-located with the only
 *  component that uses it and so tree-shaking doesn't need to reason about
 *  global CSS ownership. */
const BREATHE_KEYFRAMES_CSS = `
@keyframes ${BREATHE_ANIMATION_NAME} {
  0%, 100% {
    text-shadow:
      0 0 4px rgba(255, 236, 77, 0.55),
      0 0 10px rgba(255, 236, 77, 0.32);
  }
  50% {
    text-shadow:
      0 0 10px rgba(255, 236, 77, 1),
      0 0 22px rgba(255, 236, 77, 0.85),
      0 0 36px rgba(255, 236, 77, 0.55);
  }
}
`;
/** Rectangle background: 1920×187 PNG sized to match the band the rectangle
 *  is centered inside. Rendered at its native pixel size via
 *  `background-size: <w>px <h>px` + `background-position: center`, so the
 *  rectangle simply acts as a window cropping the image. Transparent areas
 *  outside the image (e.g. when a 2-team layout is taller than the 187 px
 *  band) fall through to `BACKGROUND_FALLBACK_COLOR` for a seamless feel. */
const BACKGROUND_IMAGE_URL = "/bgteam.png";
const BACKGROUND_IMAGE_WIDTH_PX = 1920;
const BACKGROUND_IMAGE_HEIGHT_PX = 187;
const BACKGROUND_FALLBACK_COLOR = "#000000";
const BORDER_COLOR = "#d9d9d9";
/** Team label and player names share the Oswald typeface — only the weight
 *  differs (700 for the team label so it reads as the heading, 400 for the
 *  players). Both variants are self-hosted via fontsource; the 400 + 700
 *  sources are imported in `overlay/layout.tsx`. Bebas Neue stays in the
 *  fallback chain only as a defensive fallback if Oswald fails to load.  */
const TEAM_FONT_STACK = '"Oswald", "Bebas Neue", system-ui, sans-serif';
const PLAYER_FONT_STACK = '"Oswald", "Bebas Neue", system-ui, sans-serif';
const TEAM_FONT_WEIGHT = 700;
const PLAYER_FONT_WEIGHT = 400;
const INTER_NAME_GAP = "\u00A0\u00A0\u00A0\u00A0";

export type TeamListLayerInput = {
  teamName: string;
  players: string[];
};

function normalizeLine(team: TeamListLayerInput | null): {
  label: string;
  players: string[];
} | null {
  if (!team) return null;
  const name = (team.teamName ?? "").trim().toUpperCase();
  if (!name || name === "TBD") return null;
  const cleanPlayers = team.players
    .map((p) => (p ?? "").trim().toUpperCase())
    .filter((p) => p.length > 0);
  return {
    label: `${name}:`,
    players: cleanPlayers,
  };
}

function Line({
  label,
  players,
  highlightedIndex,
  onPlayerClick,
}: {
  label: string;
  players: string[];
  /** Index of the currently-highlighted player within this line, or null if
   *  no highlight is active on this line. */
  highlightedIndex: number | null;
  /** Fires when a player name in this line is clicked. Index is the
   *  player's position within the line's filtered list (0-based). */
  onPlayerClick?: (index: number) => void;
}) {
  return (
    <div
      style={{
        display: "inline-block",
        whiteSpace: "nowrap",
        fontSize: `${FONT_SIZE_PX}px`,
        lineHeight: 1,
        letterSpacing: "0.02em",
      }}
    >
      <span
        style={{
          color: TEAM_NAME_COLOR,
          fontFamily: TEAM_FONT_STACK,
          fontWeight: TEAM_FONT_WEIGHT,
        }}
      >
        {label}
      </span>
      {players.map((player, i) => {
        const isHighlighted = highlightedIndex === i;
        return (
          <span key={i}>
            {/*
             * Non-breaking spaces kept inside a dedicated span so the gap
             * between names is never a click target and never animates —
             * only the player name itself glows.
             */}
            <span
              style={{
                color: PLAYER_NAME_COLOR,
                fontFamily: PLAYER_FONT_STACK,
                fontWeight: PLAYER_FONT_WEIGHT,
                whiteSpace: "pre",
              }}
            >
              {INTER_NAME_GAP}
            </span>
            <span
              role={onPlayerClick ? "button" : undefined}
              tabIndex={onPlayerClick ? 0 : undefined}
              onClick={onPlayerClick ? () => onPlayerClick(i) : undefined}
              onKeyDown={
                onPlayerClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPlayerClick(i);
                      }
                    }
                  : undefined
              }
              style={{
                color: isHighlighted ? PLAYER_HIGHLIGHT_COLOR : PLAYER_NAME_COLOR,
                /**
                 * Breathing glow only while highlighted. The color still
                 * uses a 1 s transition so the YELLOW fades in/out
                 * smoothly when selection changes; the shadow itself is
                 * fully driven by the keyframe animation while active and
                 * simply disappears when the animation is removed — the
                 * surrounding color fade masks the instant shadow drop so
                 * the off-transition still reads as graceful.
                 */
                textShadow: isHighlighted ? undefined : "none",
                animation: isHighlighted
                  ? `${BREATHE_ANIMATION_NAME} ${BREATHE_CYCLE_MS}ms ease-in-out infinite`
                  : "none",
                transition: `color ${PLAYER_HIGHLIGHT_TRANSITION_MS}ms ease-in-out`,
                fontFamily: PLAYER_FONT_STACK,
                fontWeight: PLAYER_FONT_WEIGHT,
                /* Re-enable pointer events only on the name itself — parent
                   containers keep `pointerEvents: "none"` so clicks that
                   miss a name fall through to whatever is behind the
                   overlay (e.g. dashboard drag targets under the iframe). */
                pointerEvents: onPlayerClick ? "auto" : "none",
                cursor: onPlayerClick ? "pointer" : "default",
                outline: "none",
              }}
            >
              {player}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export type TeamListHighlightPosition = {
  team: "A" | "B";
  playerIndex: number;
};

export function OverlayTeamListLayer({
  teamA,
  teamB,
  highlight = null,
  onPlayerClick,
}: {
  teamA: TeamListLayerInput | null;
  teamB: TeamListLayerInput | null;
  /** Currently highlighted player across both team lines, or null. */
  highlight?: TeamListHighlightPosition | null;
  /** Called when a player name is clicked. If omitted, names render
   *  non-interactive (pointer-events disabled), which is the behaviour for
   *  any consumer that doesn't need the click-to-glow feature. */
  onPlayerClick?: (position: TeamListHighlightPosition) => void;
}) {
  const normalizedA = useMemo(() => normalizeLine(teamA), [teamA]);
  const normalizedB = useMemo(() => normalizeLine(teamB), [teamB]);

  const logoRef = useRef<HTMLImageElement | null>(null);
  const contentWrapperRef = useRef<HTMLDivElement | null>(null);

  /**
   * `dims` is the result of measuring the content wrapper (logo + lines +
   * padding) at its natural, unscaled size and computing the uniform scale
   * that makes it fit inside the 1920 × 187 band. The rectangle is then
   * rendered at `{ w, h }` so the border hugs the scaled content; the scale
   * is applied only to the content layer, leaving the `bgteam.png`
   * background at its native 1920×187 resolution behind the scaled text.
   * Null until the first measurement lands — the rectangle is rendered at
   * opacity 0 during that initial frame to avoid a flash of over-tall
   * content.
   */
  const [dims, setDims] = useState<{ scale: number; w: number; h: number } | null>(null);

  const measureAndFit = () => {
    const wrapper = contentWrapperRef.current;
    if (!wrapper) return;
    /* `offsetWidth` / `offsetHeight` reflect the wrapper's natural layout
       box and ignore any active `transform: scale()`, so we can remeasure
       without removing the applied scale first. */
    const naturalW = wrapper.offsetWidth;
    const naturalH = wrapper.offsetHeight;
    if (naturalW <= 0 || naturalH <= 0) {
      setDims(null);
      return;
    }
    const scaleW = MAX_RECT_WIDTH_PX / naturalW;
    const scaleH = MAX_RECT_HEIGHT_PX / naturalH;
    const scale = Math.min(1, scaleW, scaleH);
    /* Use `Math.ceil` on the width so sub-pixel rounding never truncates
       the last glyph; `Math.round` on the height is fine because the cap
       (187) is the visual ceiling and rounding up would push it beyond the
       band, which is exactly what we're trying to avoid. */
    setDims({
      scale,
      w: Math.ceil(naturalW * scale),
      h: Math.min(MAX_RECT_HEIGHT_PX, Math.round(naturalH * scale)),
    });
  };

  useLayoutEffect(() => {
    let cancelled = false;
    /* Defer one frame so the browser has painted the new text with the
       freshly-loaded Oswald face before we read `offsetWidth`; synchronous
       reads during the same layout pass sometimes return 0 while the font
       is still swapping in. The logo's `onLoad` separately re-measures
       once the PNG decodes, so slow-loading images can't pin us at a stale
       scale. */
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      measureAndFit();
    });

    /**
     * Oswald is async-loaded via @fontsource (@font-face rules). On first
     * paint the fallback stack (`Bebas Neue` → system-ui) is used, which
     * has noticeably narrower glyphs than Oswald — so the raf-scheduled
     * measurement above records a too-small `naturalW`, the rectangle is
     * sized to that, and when Oswald swaps in a moment later the wider
     * text overflows and gets clipped by `overflow: hidden` on the
     * rectangle. `document.fonts.ready` resolves once every declared font
     * face has finished loading (or failed), so re-running the measure
     * then gives us the true post-swap width. Wrapped in a try/catch
     * because older browsers (and some Electron edge cases) expose
     * `document.fonts` without `ready` or throw on access. */
    try {
      const fonts = (
        typeof document !== "undefined"
          ? (document as Document & { fonts?: FontFaceSet }).fonts
          : undefined
      );
      if (fonts && fonts.ready && typeof fonts.ready.then === "function") {
        fonts.ready.then(() => {
          if (cancelled) return;
          measureAndFit();
        });
      }
    } catch {
      /* ignore — fall back to raf-only measurement */
    }

    /**
     * ResizeObserver on the content wrapper catches any further natural
     * size changes we don't explicitly trigger above: late CSS rules,
     * additional font-face swaps, logo decode jitter, window DPR changes,
     * etc. Because the observed element's `width: max-content` always
     * reflects the true natural content size (ignoring containing-block
     * clamping), each callback reads a correct `naturalW` / `naturalH`
     * and keeps the rectangle in sync with what's actually rendered.
     */
    const wrapper = contentWrapperRef.current;
    let resizeObs: ResizeObserver | null = null;
    if (wrapper && typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => {
        if (cancelled) return;
        measureAndFit();
      });
      resizeObs.observe(wrapper);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (resizeObs) resizeObs.disconnect();
    };
  }, [
    normalizedA?.label,
    normalizedA?.players.join("\u0001"),
    normalizedB?.label,
    normalizedB?.players.join("\u0001"),
  ]);

  if (!normalizedA && !normalizedB) return null;

  const resolvedW = dims ? dims.w : undefined;
  const resolvedH = dims ? dims.h : undefined;
  const resolvedScale = dims ? dims.scale : 1;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: BAND_TOP_PX,
        width: CANVAS_WIDTH_PX,
        height: BAND_HEIGHT_PX,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
      aria-hidden
    >
      {/*
       * Inline the breathing-glow keyframes so the animation registers
       * without relying on a separate global stylesheet. Rendered once per
       * mounted overlay layer; React de-dupes identical `<style>` content
       * cheaply and the browser parses the rule only once per document.
       */}
      <style
        // eslint-disable-next-line react/no-unknown-property
        dangerouslySetInnerHTML={{ __html: BREATHE_KEYFRAMES_CSS }}
      />
      <div
        style={{
          position: "relative",
          /* Explicit scaled dimensions so the border hugs the visible
             (scaled) content — this is what keeps the 2-team rectangle at
             exactly 187 px tall instead of 206 px. */
          width: resolvedW,
          height: resolvedH,
          overflow: "hidden",
          backgroundColor: BACKGROUND_FALLBACK_COLOR,
          border: `0.5px solid ${BORDER_COLOR}`,
          borderRadius: "2px",
          boxShadow: "0 2px 12px rgba(0,0,0,0.55)",
          opacity: dims ? 1 : 0,
          transition: "opacity 120ms linear",
        }}
      >
        {/*
         * Background layer: rendered at native 1920 × 187 px regardless of
         * the rectangle's current scaled size, so the image is never
         * stretched / shrunk when the content layer scales down. Center it
         * absolutely (not via `background-position`) so the rectangle's
         * `overflow: hidden` crops it around the same center point as the
         * content layer.
         */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: `${BACKGROUND_IMAGE_WIDTH_PX}px`,
            height: `${BACKGROUND_IMAGE_HEIGHT_PX}px`,
            transform: "translate(-50%, -50%)",
            backgroundImage: `url(${BACKGROUND_IMAGE_URL})`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center center",
            backgroundSize: `${BACKGROUND_IMAGE_WIDTH_PX}px ${BACKGROUND_IMAGE_HEIGHT_PX}px`,
            pointerEvents: "none",
          }}
        />
        {/*
         * Content wrapper: rendered at natural size (no width/height set),
         * centered inside the rectangle, then `scale()` applied as the last
         * step so the visible footprint matches `dims.w × dims.h`. Because
         * the wrapper is `position: absolute`, its layout box does not
         * participate in the rectangle's intrinsic sizing, which is how the
         * outer rectangle can hold an explicit scaled-down size while the
         * wrapper is still measured at natural dimensions.
         */}
        <div
          ref={contentWrapperRef}
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: `translate(-50%, -50%) scale(${resolvedScale})`,
            transformOrigin: "center center",
            display: "inline-flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            /* Force the wrapper to size to its natural content rather than
               the shrink-to-fit width of its (absolute-positioning)
               containing block. Without this, a briefly-narrow rectangle on
               the very first layout pass can clamp `offsetWidth` below the
               true natural width and cause the measurement → scale cycle to
               lock in a too-small rectangle, visually cropping the team
               list well short of 1920 px. `max-content` tells the browser
               "use the widest the content prefers" regardless of
               ancestors. */
            width: "max-content",
            height: "max-content",
            /* `gap` drives team-to-team spacing; the logo sits in its own
               flex slot and tunes its gap to the first line via a dedicated
               `marginBottom` below so we can size logo-gap independently. */
            gap: `${LINE_GAP_PX}px`,
            padding: `${PADDING_Y_PX}px ${PADDING_X_PX}px`,
            textAlign: "center",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          <img
            ref={logoRef}
            src={LOGO_SRC}
            alt=""
            draggable={false}
            onLoad={measureAndFit}
            style={{
              display: "block",
              height: `${LOGO_HEIGHT_PX}px`,
              width: "auto",
              marginBottom: `${LOGO_GAP_PX - LINE_GAP_PX}px`,
              /* `LINE_GAP_PX` already separates the logo's flex slot from the
                 first team line via the column `gap`; this negative-or-positive
                 delta on `marginBottom` tunes the logo-to-first-line distance
                 to the desired 16 px without disturbing the team-to-team gap. */
              pointerEvents: "none",
            }}
          />
          {normalizedA ? (
            <Line
              label={normalizedA.label}
              players={normalizedA.players}
              highlightedIndex={
                highlight && highlight.team === "A"
                  ? highlight.playerIndex
                  : null
              }
              onPlayerClick={
                onPlayerClick
                  ? (index) => onPlayerClick({ team: "A", playerIndex: index })
                  : undefined
              }
            />
          ) : null}
          {normalizedB ? (
            <Line
              label={normalizedB.label}
              players={normalizedB.players}
              highlightedIndex={
                highlight && highlight.team === "B"
                  ? highlight.playerIndex
                  : null
              }
              onPlayerClick={
                onPlayerClick
                  ? (index) => onPlayerClick({ team: "B", playerIndex: index })
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
