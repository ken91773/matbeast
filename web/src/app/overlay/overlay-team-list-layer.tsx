"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Two-team list overlay rendered inside the scoreboard output window.
 * Sits in a fixed 1920×1080 vertical band (y 316 → 503) and crossfades in
 * when the dashboard APPLIES teams mode.
 *
 * Format (updated 2026-04-29 — transparent-background artwork):
 * - Background: `/teamsbg3.png` (1920×187, 32-bit ARGB with full alpha)
 *   rendered at native resolution and aligned to the band's top-left so
 *   it covers the band edge-to-edge. The image is mostly transparent and
 *   only contains a small white "MatBeast" logo near the top center
 *   (opaque bounding box ≈ x [787..1156] y [23..65]). Everywhere else,
 *   the underlying scoreboard shows through. We DO NOT draw any extra
 *   border, box, shadow, or fallback fill around the image.
 * - Team text: rendered as one or two lines centered horizontally inside
 *   the band and vertically centered in the lower portion (beneath the
 *   logo). One team → one line, two teams → two lines stacked with a
 *   small gap.
 * - Font / colors / highlighting: unchanged from the previous design.
 *   - Team label: Oswald 700 at 40 px in `#99c5ff`.
 *   - Player names: Oswald 400 at 40 px in `#d9d9d9`, uppercased, separated
 *     by 4 non-breaking spaces (`TEAMNAME:␠␠␠␠NAME1␠␠␠␠NAME2…`).
 *   - Click a player name to toggle a yellow breathing-glow highlight
 *     (`#ffec4d`); same `matbeastTeamGlow` keyframe as before.
 * - Shrink-to-fit: the line wrapper is measured at its natural width and
 *   uniformly scaled if it would overflow the available text area
 *   (1920 px canvas minus side insets, 187 px band minus the reserved
 *   logo strip on top). Long rosters shrink, short rosters render at
 *   natural size.
 */

const BAND_TOP_PX = 316;
const BAND_BOTTOM_PX = 503;
const BAND_HEIGHT_PX = BAND_BOTTOM_PX - BAND_TOP_PX;
const CANVAS_WIDTH_PX = 1920;
const FONT_SIZE_PX = 40;
const LINE_GAP_PX = Math.round(FONT_SIZE_PX * 0.5);

/**
 * Background image (native pixel size). Transparent PNG containing only
 * a centered white "MatBeast" logo near the top — text is overlaid below
 * the logo region using the constants below to position / clip the text
 * area.
 */
const BACKGROUND_IMAGE_URL = "/teamsbg3.png";
const BACKGROUND_IMAGE_WIDTH_PX = 1920;
const BACKGROUND_IMAGE_HEIGHT_PX = 187;

/**
 * Vertical strip at the top of `teamsbg3.png` reserved for the built-in
 * white logo (opaque pixels live in y ≈ 23..65). Team text is rendered
 * inside the area below this strip so the descenders of the topmost line
 * have a small visual gap below the logo's baseline.
 */
const TITLE_AREA_HEIGHT_PX = 75;

/**
 * Horizontal padding inside the band (per side). The artwork has no side
 * accents (it's transparent outside the centered logo), so insets here
 * are purely for breathing room between the team text and the canvas
 * edges; tightened from the v1.0.1 value because there's no decorative
 * border to clear any more.
 */
const TEXT_AREA_SIDE_INSET_PX = 48;

/**
 * Small bottom inset so the descenders of the bottommost line don't kiss
 * the bottom edge of the band.
 */
const TEXT_AREA_BOTTOM_INSET_PX = 8;

const TEXT_AREA_WIDTH_PX =
  BACKGROUND_IMAGE_WIDTH_PX - TEXT_AREA_SIDE_INSET_PX * 2;
const TEXT_AREA_HEIGHT_PX =
  BACKGROUND_IMAGE_HEIGHT_PX - TITLE_AREA_HEIGHT_PX - TEXT_AREA_BOTTOM_INSET_PX;

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

  const contentWrapperRef = useRef<HTMLDivElement | null>(null);

  /**
   * `dims` holds the uniform scale that makes the natural-width line
   * stack fit inside the text area (everything beneath the title strip
   * of the bg image). Null until the first measurement lands — the
   * overlay is rendered at opacity 0 during the initial frame so a
   * temporarily over-wide stack never flashes onscreen.
   */
  const [dims, setDims] = useState<{ scale: number } | null>(null);

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
    const scaleW = TEXT_AREA_WIDTH_PX / naturalW;
    const scaleH = TEXT_AREA_HEIGHT_PX / naturalH;
    const scale = Math.min(1, scaleW, scaleH);
    setDims({ scale });
  };

  useLayoutEffect(() => {
    let cancelled = false;
    /* Defer one frame so the browser has painted the new text with the
       freshly-loaded Oswald face before we read `offsetWidth`; synchronous
       reads during the same layout pass sometimes return 0 while the font
       is still swapping in. */
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      measureAndFit();
    });

    /**
     * Oswald is async-loaded via @fontsource (@font-face rules). On first
     * paint the fallback stack (`Bebas Neue` → system-ui) is used, which
     * has noticeably narrower glyphs than Oswald — so the raf-scheduled
     * measurement above records a too-small `naturalW`, the scale is
     * computed against that, and when Oswald swaps in a moment later the
     * wider text would overflow. `document.fonts.ready` resolves once
     * every declared font face has finished loading (or failed), so
     * re-running the measure then gives us the true post-swap width.
     * Wrapped in a try/catch because older browsers (and some Electron
     * edge cases) expose `document.fonts` without `ready` or throw on
     * access. */
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
     * additional font-face swaps, window DPR changes, etc. Because the
     * observed element's `width: max-content` always reflects the true
     * natural content size (ignoring containing-block clamping), each
     * callback reads a correct `naturalW` / `naturalH` and keeps the
     * scale in sync with what's actually rendered.
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
          width: BACKGROUND_IMAGE_WIDTH_PX,
          height: BACKGROUND_IMAGE_HEIGHT_PX,
          opacity: dims ? 1 : 0,
          transition: "opacity 120ms linear",
        }}
      >
        {/*
         * Background image — rendered at native 1920×187 px. Mostly
         * transparent with the white MatBeast logo baked into the upper
         * portion of the artwork; no additional border, fill, or shadow
         * is drawn around it.
         */}
        <img
          src={BACKGROUND_IMAGE_URL}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: `${BACKGROUND_IMAGE_WIDTH_PX}px`,
            height: `${BACKGROUND_IMAGE_HEIGHT_PX}px`,
            display: "block",
            pointerEvents: "none",
          }}
        />
        {/*
         * Text region: clipped to the area beneath the logo strip and
         * inside the side insets. Flex-centers the line stack
         * horizontally + vertically inside that area.
         */}
        <div
          style={{
            position: "absolute",
            top: `${TITLE_AREA_HEIGHT_PX}px`,
            left: `${TEXT_AREA_SIDE_INSET_PX}px`,
            width: `${TEXT_AREA_WIDTH_PX}px`,
            height: `${TEXT_AREA_HEIGHT_PX}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          {/*
           * Inner line wrapper: rendered at natural size (max-content),
           * uniformly scaled down via `transform: scale()` when the
           * lines would overflow the text area. `width: max-content`
           * lets us measure the true natural width regardless of the
           * absolute-positioning containing block.
           */}
          <div
            ref={contentWrapperRef}
            style={{
              display: "inline-flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: "max-content",
              height: "max-content",
              gap: `${LINE_GAP_PX}px`,
              textAlign: "center",
              whiteSpace: "nowrap",
              transform: `scale(${resolvedScale})`,
              transformOrigin: "center center",
              pointerEvents: "none",
            }}
          >
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
    </div>
  );
}
