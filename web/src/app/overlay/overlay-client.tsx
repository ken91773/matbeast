"use client";

import {
  type OverlayOutputBroadcast,
  type OverlayScene,
  type ScoreboardOverlayMode,
  type TeamListHighlight,
  isOverlayOutputBroadcast,
  openOverlayOutputChannel,
  postTeamListHighlight,
} from "@/lib/overlay-output-broadcast";
import {
  OverlayTeamListLayer,
  type TeamListLayerInput,
  type TeamListHighlightPosition,
} from "@/app/overlay/overlay-team-list-layer";
import {
  MATBEAST_TOURNAMENT_HEADER,
  getMatBeastTournamentId,
  setMatBeastTournamentId,
} from "@/lib/matbeast-fetch";
import type { BoardPayload } from "@/types/board";
import {
  SCOREBOARD_OT_MAIN_HEX,
  SCOREBOARD_OT_SUBLINE_HEX,
} from "@/lib/scoreboard-ot-colors";
import {
  scoreboardOtRedTimerStyle,
  scoreboardSubclockRoundLabelFromBoard,
  scoreboardTimerLineFromBoard,
} from "@/lib/scoreboard-timer-display";
import {
  CENTER_OT_STRIP,
  CENTER_TIMER,
  LEFT_SILHOUETTE_ICONS,
  LEFT_PLAYER_STRIP,
  LEFT_TEAM_STRIP,
  RIGHT_PLAYER_STRIP,
  RIGHT_SILHOUETTE_ICONS,
  RIGHT_TEAM_STRIP,
  silhouetteSlotCenterLeftFrac,
  silhouetteSlotCenterRightFrac,
  vbRectToPercentStyle,
} from "@/lib/scoreboard-layout";
import { finalWinnerIsLeft, finalWinnerIsRight } from "@/lib/board-final-display";
import {
  type BracketPayload,
  namedTeamCount,
  normalizeBracketPayload,
} from "@/lib/bracket-display";
import { buildBracketOverlaySlots } from "@/lib/bracket-overlay-model";
import { OverlayCanvasTextLayer } from "@/app/overlay/overlay-canvas-text-layer";
import { useBracketOverlayMusic } from "@/app/overlay/use-bracket-overlay-music";
import { useTimerAlertSounds } from "@/hooks/useTimerAlertSounds";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { matbeastJson } from "@/lib/matbeast-query";
import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { type CSSProperties, useEffect, useMemo, useState } from "react";

const W = 1920;
const H = 1080;
const OVERLAY_FONT_STACK = '"Bebas Neue", system-ui, sans-serif';

/** 1920×1080 native art: convert pixel bbox to percent strings for absolute layout. */
function pctRectFromCorners(corners: Array<[number, number]>) {
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  return {
    left: `${(minX / W) * 100}%`,
    top: `${(minY / H) * 100}%`,
    width: `${(w / W) * 100}%`,
    height: `${(h / H) * 100}%`,
  };
}

/** Live ↔ stopped: left/right shutters meet at center when off-air, slide off when live. */
const OVERLAY_BARN_DOOR_MS = 1000;

/**
 * Maximum players rendered on the team-list overlay per team. Caps the
 * applied lineup to starters only (first five by lineupOrder); any additional
 * rostered players (bench, alternates) are intentionally omitted from the
 * graphic even when present in the team. Keep in sync with any future
 * "starters vs bench" semantics defined on the Teams card.
 */
const TEAM_LIST_STARTER_COUNT = 5;
/** Output window chrome: transparent so OBS sees alpha (matches Electron `transparent: true`). */
const OVERLAY_OUTPUT_CHROME_BG = "transparent";

/**
 * Visible inset frame on Electron output windows (`/overlay?outputScene=…` without `preview=1`).
 * Native title bar alone is easy to miss on transparent clients; this stays inside the capture area.
 */
const OVERLAY_OUTPUT_FRAME_STYLE: CSSProperties = {
  boxShadow:
    "inset 0 0 0 2px rgba(45, 212, 191, 0.95), inset 0 0 0 5px rgba(0, 0, 0, 0.45)",
};

function overlayFullName(p: BoardPayload["left"] | BoardPayload["right"] | null | undefined) {
  if (!p) return "";
  /** `displayName` from the board API is already "first last" for roster picks; do not prefer `lastName` alone. */
  const dn = (p.displayName ?? "").trim();
  if (dn) return dn.toUpperCase();
  const ln = (p.lastName ?? "").trim();
  if (ln) return ln.toUpperCase();
  return "";
}

function SilhouetteCrosses({
  side,
  crossed,
}: {
  side: "left" | "right";
  crossed: number[];
}) {
  const crossedSet = new Set(crossed);
  const box = side === "left" ? LEFT_SILHOUETTE_ICONS : RIGHT_SILHOUETTE_ICONS;
  const frac =
    side === "left" ? silhouetteSlotCenterLeftFrac : silhouetteSlotCenterRightFrac;

  return (
    <div
      className="pointer-events-none"
      style={{
        ...vbRectToPercentStyle(box),
        position: "absolute",
        /** Above `OverlayCanvasTextLayer` canvas (z-index 200). */
        zIndex: 250,
      }}
    >
      {[0, 1, 2, 3, 4].map((slot) =>
        crossedSet.has(slot) ? (
          <img
            key={slot}
            src="/redx.png"
            alt=""
            style={{
              position: "absolute",
              left: `${frac(slot) * 100}%`,
              top: "50%",
              height: "76%",
              width: "auto",
              transform: "translate(-50%, -50%)",
              objectFit: "contain",
              filter: "drop-shadow(0 0 6px rgba(0,0,0,0.95))",
            }}
            aria-hidden
          />
        ) : null,
      )}
    </div>
  );
}

export default function OverlayClient() {
  /**
   * Avoid `useSearchParams()`: server HTML for `/overlay?preview=1` can disagree with the
   * client's first read of the query string and cause a hydration mismatch → Next "Application error".
   * Read `window.location.search` only after mount so server + first client paint match.
   */
  /** Read synchronously on first paint so `outputScene` / `preview` control queries immediately. */
  const [urlSearch, setUrlSearch] = useState(
    () => (typeof window !== "undefined" ? window.location.search : ""),
  );
  const searchParams = useMemo(() => new URLSearchParams(urlSearch), [urlSearch]);
  const forcedTournamentIdFromQuery = searchParams.get("tournamentId")?.trim() || "";
  const isPreview = searchParams.get("preview") === "1";
  /**
   * NDI offscreen render flag. Set by `electron/ndi-smoke.js` (v0.9.21) and
   * future `electron/ndi-sender.js` (v0.9.22+) when loading the overlay
   * inside an offscreen `BrowserWindow` for broadcast capture. We piggyback
   * on the existing `outputScene` lock so scene routing stays identical to
   * the visible operator-monitor windows; `isNdi` only changes
   * presentation-layer concerns the broadcast viewer should not see (the
   * operator-confidence inset frame) and routes audio through the dedicated
   * NDI graph instead of the visible bracket window's audio engine
   * (introduced in v0.9.23).
   */
  const isNdi = searchParams.get("ndi") === "1";
  const previewSceneParam = searchParams.get("previewScene");
  const forcePreviewLive = searchParams.get("forcePreviewLive") === "1";
  const disableBarnDoor = searchParams.get("disableBarnDoor") === "1";
  /** Electron output windows: fixed scene; never follow dashboard `postOverlayScene` broadcast. */
  const lockedOutputScene = useMemo((): OverlayScene | null => {
    if (isPreview) return null;
    const o = searchParams.get("outputScene");
    if (o === "bracket" || o === "scoreboard") return o;
    return null;
  }, [isPreview, searchParams]);

  /**
   * Bracket overlay window: drive the looping music engine. Gated to the
   * actual bracket output `BrowserWindow` only — preview iframes and the
   * scoreboard overlay never instantiate the engine, so the operator's PC
   * never doubles cues with the bracket music.
   *
   * NDI offscreen render: v0.9.21 disables music in the offscreen renderer
   * because the visible bracket window still owns the audio graph. v0.9.23
   * will move the music graph into the offscreen renderer and add an
   * AudioWorklet PCM tap that ships float32 samples to `grandiose.audio()`.
   */
  /**
   * Bracket music engine.
   *   - Visible bracket overlay window (not preview, not NDI): runs the
   *     standard engine so the operator can MONITOR the music via their
   *     selected audio device.
   *   - Offscreen NDI bracket renderer (`isNdi`): runs the engine in
   *     PCM-tap mode so the music's audio graph is captured at full
   *     amplitude and forwarded to grandiose's `sender.audio()`.
   *     Local sink is forced silent so the operator doesn't hear two
   *     copies (visible window + offscreen window).
   *   - Preview iframe: no music engine. The dashboard preview is
   *     visual-only — operator monitors via the actual bracket window.
   */
  useBracketOverlayMusic(!isPreview && lockedOutputScene === "bracket", {
    tapPcmForNdi: isNdi,
  });

  const fallbackTournamentId =
    (typeof window !== "undefined" ? getMatBeastTournamentId()?.trim() : "") || "";
  const [runtimeTournamentId, setRuntimeTournamentId] = useState(
    forcedTournamentIdFromQuery || fallbackTournamentId || null,
  );
  const overlayTournamentId = runtimeTournamentId;

  /**
   * Keep `matbeastFetch` header aligned with resolved overlay tournament source.
   * Preview iframe: do not write the shared tournament id — avoids touching
   * localStorage from a nested document (and focus fights with the dashboard).
   */
  useEffect(() => {
    if (!overlayTournamentId) return;
    if (isPreview) return;
    setMatBeastTournamentId(overlayTournamentId);
  }, [overlayTournamentId, isPreview]);

  useEffect(() => {
    const onTournamentId = (
      event: Event,
    ) => {
      const detail = (
        event as CustomEvent<{ kind?: string; tournamentId?: string | null }>
      ).detail;
      if (!detail || detail.kind !== "matbeast-overlay-tournament-id") return;
      const next = typeof detail.tournamentId === "string" ? detail.tournamentId.trim() : "";
      setRuntimeTournamentId(next || null);
      setUrlSearch(typeof window !== "undefined" ? window.location.search : "");
    };
    window.addEventListener("matbeast-overlay-tournament-id", onTournamentId);
    return () => window.removeEventListener("matbeast-overlay-tournament-id", onTournamentId);
  }, []);

  /**
   * Electron creates overlay BrowserWindows at app startup before the dashboard
   * has set `matbeast-active-tournament-id` or dispatched IPC — the injected
   * `matbeast-overlay-tournament-id` event can fire before this listener mounts.
   * Sync from localStorage on mount and when another window updates the key so
   * bracket/scoreboard output fetches the same tournament as the dashboard preview
   * (which always has `?tournamentId=` in the iframe URL).
   */
  useEffect(() => {
    if (isPreview) return;
    const STORAGE_KEY = "matbeast-active-tournament-id";
    const syncFromStorage = () => {
      const tid = getMatBeastTournamentId()?.trim() || "";
      setRuntimeTournamentId((prev) => {
        if (tid) return tid;
        return prev;
      });
    };
    syncFromStorage();
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = (e.newValue ?? "").trim();
      setRuntimeTournamentId(next || null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [isPreview]);

  /**
   * Output window bootstraps tabs from localStorage async; use server list
   * for the canonical event name.
   *
   * IMPORTANT: this shares its query key (`matbeastKeys.tournaments()`)
   * with `EventWorkspaceProvider`, which expects `data` to be an
   * `Array<TournamentSummary>`. React Query caches by key only, so
   * whichever observer's queryFn writes last wins — a mismatched shape
   * here corrupts the provider's cache and makes its tab-name sync
   * effect crash with `find is not a function` the moment it runs
   * after us. Normalize to the array shape (`select` unwraps the
   * envelope) so both observers see the same thing.
   */
  const { data: tournamentsList } = useQuery({
    queryKey: matbeastKeys.tournaments(),
    queryFn: async () => {
      const j = await matbeastJson<{
        tournaments?: Array<{ id: string; name: string; updatedAt?: string }>;
      }>("/api/tournaments");
      return Array.isArray(j?.tournaments) ? j.tournaments : [];
    },
    enabled: !!overlayTournamentId,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 3000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  /**
   * Preserve the legacy `tournamentsPayload?.tournaments` read shape for
   * downstream call sites without plumbing a rename through the whole
   * file. Always an array (empty when the query hasn't resolved).
   */
  const tournamentsPayload = useMemo(
    () => ({ tournaments: tournamentsList ?? [] }),
    [tournamentsList],
  );

  /**
   * Same board query as the rest of the app: `matbeastJson` forces `cache: "no-store"` on fetch.
   * Preview (iframe) and output (Electron window) are separate JS contexts — each polls here;
   * `refetchOnMount: "always"` avoids showing a stale first paint after navigation or remount.
   */
  const { data: board } = useQuery({
    queryKey: matbeastKeys.board(overlayTournamentId),
    queryFn: ({ signal }) =>
      matbeastJson<BoardPayload>("/api/board", {
        signal,
        headers: overlayTournamentId
          ? { [MATBEAST_TOURNAMENT_HEADER]: overlayTournamentId }
          : undefined,
      }),
    /** Avoid resolving the wrong tournament before `overlayTournamentId` is synced (startup race). */
    enabled: !!overlayTournamentId,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 1000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  /**
   * Same reset-key shape as the dashboard's `ControlPanel` mount of
   * `useTimerAlertSounds` (see ControlPanel.tsx). The two mounts run
   * independent edge detectors; sharing the key shape ensures both
   * fire on identical board transitions.
   *
   * Excludes `board.updatedAt` and `timerRunning` for the same reason
   * as ControlPanel: those toggle every poll/pause and would clear
   * `prevSecondsRef` mid-crossing, swallowing the 10s/0 cues.
   */
  const ndiTimerAudioResetKey = useMemo(() => {
    if (!board) return overlayTournamentId ?? undefined;
    return [
      overlayTournamentId ?? "",
      `oi:${board.overtimeIndex}`,
      `ph:${board.timerPhase}`,
      `r:${board.timerRestMode ? 1 : 0}`,
      `u:${board.timerOtCountUpMode ? 1 : 0}`,
      `a:${board.timerOtArmedMode ? 1 : 0}`,
      `d:${board.timerOtCountdownMode ? 1 : 0}`,
      `dir:${board.otPlayDirection}`,
      `otr:${board.timerOtRoundMode ? 1 : 0}`,
      `cue:${board.timerCuesResetNonce ?? 0}`,
    ].join("|");
  }, [
    overlayTournamentId,
    board,
  ]);

  /**
   * NDI scoreboard audio cues (v0.9.35).
   *
   * Mounts the timer-alert hook in NDI tap mode for the offscreen
   * scoreboard `BrowserWindow` only. The dashboard's ControlPanel
   * already mounts the standard (audible) variant for the operator,
   * and the visible scoreboard output window is intentionally silent
   * — the operator monitors via the dashboard, and the NDI receiver
   * monitors via this offscreen renderer.
   *
   *   isPreview      → no cues (dashboard preview iframe is visual only)
   *   visible scoreboard window (no NDI, no preview)
   *                  → no cues (dashboard already plays them audibly)
   *   offscreen NDI scoreboard renderer (`isNdi`)
   *                  → cues fire silently and stream PCM via NDI
   *   bracket scenes → no cues (timer cues belong to scoreboard scene)
   */
  useTimerAlertSounds(
    board?.secondsRemaining,
    ndiTimerAudioResetKey,
    board?.sound10Enabled,
    board?.sound0Enabled,
    board?.timerRestMode,
    board?.sound10PlayNonce,
    board?.sound0PlayNonce,
    !isPreview && isNdi && lockedOutputScene === "scoreboard",
    board?.timerOtCountdownMode ?? false,
    { tapPcmForNdi: true, ndiScene: "scoreboard" },
  );

  const [stableBracketTitlesById, setStableBracketTitlesById] = useState<
    Record<string, string>
  >({});
  const bracketOverlayEventTitle = useMemo(() => {
    const list = tournamentsPayload?.tournaments;
    const fromServer =
      overlayTournamentId && Array.isArray(list)
        ? list.find((t) => t.id === overlayTournamentId)?.name?.trim()
        : undefined;
    const cached =
      overlayTournamentId ? stableBracketTitlesById[overlayTournamentId] : undefined;
    const raw = fromServer || cached || "";
    return raw ? raw.toUpperCase() : "UNTITLED EVENT";
  }, [
    overlayTournamentId,
    stableBracketTitlesById,
    tournamentsPayload?.tournaments,
  ]);
  useEffect(() => {
    const list = tournamentsPayload?.tournaments;
    const fromServer =
      overlayTournamentId && Array.isArray(list)
        ? list.find((t) => t.id === overlayTournamentId)?.name?.trim()
        : undefined;
    if (!overlayTournamentId || !fromServer) return;
    const next = fromServer.toUpperCase();
    setStableBracketTitlesById((prev) =>
      prev[overlayTournamentId] === next ? prev : { ...prev, [overlayTournamentId]: next },
    );
  }, [overlayTournamentId, tournamentsPayload?.tournaments]);

  const { data: bracketData } = useQuery({
    queryKey: matbeastKeys.bracket(overlayTournamentId),
    queryFn: async () =>
      normalizeBracketPayload(
        await matbeastJson<BracketPayload>("/api/bracket", {
          headers: { [MATBEAST_TOURNAMENT_HEADER]: overlayTournamentId! },
        }),
      ),
    enabled: !!overlayTournamentId,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 500,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const { data: teamsPayload } = useQuery({
    queryKey: matbeastKeys.teams(overlayTournamentId),
    queryFn: () =>
      matbeastJson<{
        teams: Array<{ id: string; name: string; seedOrder: number; overlayColor?: string | null }>;
      }>("/api/teams", {
        headers: { [MATBEAST_TOURNAMENT_HEADER]: overlayTournamentId! },
      }),
    enabled: !!overlayTournamentId,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 500,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  const bracketSlots = useMemo(() => {
    const teams = teamsPayload?.teams;
    if (!teams?.length) return null;
    try {
      /** Do not wait on bracket fetch: projection + roster alone populate labels (same as before split queries). */
      return buildBracketOverlaySlots({
        bracket: bracketData ?? { quarterFinals: [], semiFinals: [], grandFinal: null },
        teams,
      });
    } catch (error) {
      console.error("[overlay] buildBracketOverlaySlots failed", error);
      return null;
    }
  }, [bracketData, teamsPayload?.teams]);

  const [scale, setScale] = useState(1);
  /**
   * Real output window follows dashboard "OVERLAY LIVE/STOPPED".
   * Dashboard preview iframe uses the same broadcast channel value for its red chrome,
   * but ignores scene changes so preview stays independent.
   */
  const [outputLive, setOutputLive] = useState(false);
  /** Only used for legacy `/overlay` without `outputScene` (browser popup). */
  const [scene, setScene] = useState<OverlayScene>("scoreboard");
  const [previewScene, setPreviewScene] = useState<OverlayScene | null>(null);
  const [bracketHighlightMatchId, setBracketHighlightMatchId] = useState<string | null>(null);
  /**
   * Scoreboard-output content mode. Fully ephemeral — driven by dashboard
   * broadcasts (`scoreboard-mode`). Reset to `scoreboard` on mount; never
   * persisted, never read from /api/board. The scoreboard graphic and the
   * team-list layer are both mounted inside the barn-door wrapper; we drive
   * opacity between them to get a 1 s crossfade whenever this flips.
   */
  const [scoreboardMode, setScoreboardMode] =
    useState<ScoreboardOverlayMode>("scoreboard");
  const [teamListAId, setTeamListAId] = useState<string | null>(null);
  const [teamListBId, setTeamListBId] = useState<string | null>(null);
  /**
   * Currently-highlighted player in the team list (null = nothing selected).
   * Click-to-glow state synced across every overlay surface (preview iframe,
   * real output window, dashboard) via the `team-list-highlight`
   * broadcast. Reset automatically when the mode flips back to scoreboard
   * or either applied team id changes so we never leave a phantom glow
   * pointing at a player that is no longer in the layout.
   */
  const [teamListHighlight, setTeamListHighlight] =
    useState<TeamListHighlight | null>(null);

  /**
   * Player roster query for the team-list overlay (scoreboard-mode = "teams").
   * Enabled whenever the mode is active so the first applied APPLY has data
   * ready without waiting an extra poll cycle. 1 s refetch matches the board
   * poll cadence — team list is a low-change view, no need to hammer the API.
   */
  const { data: playersPayload } = useQuery({
    queryKey: matbeastKeys.players(overlayTournamentId),
    queryFn: () =>
      matbeastJson<{
        players: Array<{
          id: string;
          teamId: string;
          firstName: string;
          lastName: string;
          lineupOrder: number | null;
          team?: { name?: string | null };
        }>;
      }>("/api/players", {
        headers: { [MATBEAST_TOURNAMENT_HEADER]: overlayTournamentId! },
      }),
    enabled: !!overlayTournamentId && scoreboardMode === "teams",
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 1000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  /**
   * Resolve an applied team id into the `{ teamName, players: ["FIRST LAST"] }`
   * shape the team-list layer expects. Players sorted by lineupOrder asc; TBD
   * / empty first+last name pairs skipped (per spec), then capped at the
   * lineup starter count so the graphic never shows bench / alternate
   * players. Returns null if the team id is unset or no longer exists.
   */
  const teamListInputA = useMemo((): TeamListLayerInput | null => {
    if (!teamListAId) return null;
    const teams = teamsPayload?.teams ?? [];
    const team = teams.find((t) => t.id === teamListAId);
    if (!team) return null;
    const teamName = (team.name ?? "").trim();
    if (!teamName || teamName.toUpperCase() === "TBD") return null;
    const players = playersPayload?.players ?? [];
    const rostered = players
      .filter((p) => p.teamId === teamListAId)
      .slice()
      .sort((a, b) => {
        const ao = a.lineupOrder == null ? Number.POSITIVE_INFINITY : a.lineupOrder;
        const bo = b.lineupOrder == null ? Number.POSITIVE_INFINITY : b.lineupOrder;
        return ao - bo;
      })
      .map((p) => `${(p.firstName ?? "").trim()} ${(p.lastName ?? "").trim()}`.trim())
      .filter((n) => n.length > 0)
      .slice(0, TEAM_LIST_STARTER_COUNT);
    return { teamName, players: rostered };
  }, [teamListAId, teamsPayload?.teams, playersPayload?.players]);

  const teamListInputB = useMemo((): TeamListLayerInput | null => {
    if (!teamListBId) return null;
    const teams = teamsPayload?.teams ?? [];
    const team = teams.find((t) => t.id === teamListBId);
    if (!team) return null;
    const teamName = (team.name ?? "").trim();
    if (!teamName || teamName.toUpperCase() === "TBD") return null;
    const players = playersPayload?.players ?? [];
    const rostered = players
      .filter((p) => p.teamId === teamListBId)
      .slice()
      .sort((a, b) => {
        const ao = a.lineupOrder == null ? Number.POSITIVE_INFINITY : a.lineupOrder;
        const bo = b.lineupOrder == null ? Number.POSITIVE_INFINITY : b.lineupOrder;
        return ao - bo;
      })
      .map((p) => `${(p.firstName ?? "").trim()} ${(p.lastName ?? "").trim()}`.trim())
      .filter((n) => n.length > 0)
      .slice(0, TEAM_LIST_STARTER_COUNT);
    return { teamName, players: rostered };
  }, [teamListBId, teamsPayload?.teams, playersPayload?.players]);

  const previewRedDoorOpen = forcePreviewLive || outputLive;
  const previewSceneOverride = isPreview
    ? previewScene ??
      (previewSceneParam === "scoreboard" || previewSceneParam === "bracket"
        ? previewSceneParam
        : null)
    : null;
  const activeScene: OverlayScene =
    lockedOutputScene ?? previewSceneOverride ?? scene;
  const outputScoreboardVisible =
    disableBarnDoor || isPreview || activeScene !== "scoreboard" || outputLive;

  /** Match Brackets card: 4 vs 8 art. Never default to 8 while slots are still null (that forced 8-team overlay for 4-team events). */
  const bracketMode = useMemo(() => {
    if (bracketSlots) return bracketSlots.mode;
    const teams = teamsPayload?.teams;
    if (!teams?.length) return 4;
    try {
      const opts = teams.slice().sort((a, b) => a.seedOrder - b.seedOrder);
      return namedTeamCount(opts) > 4 ? 8 : 4;
    } catch (error) {
      console.error("[overlay] bracketMode fallback failed", error);
      return 4;
    }
  }, [bracketSlots, teamsPayload?.teams]);

  const bracketBackground =
    bracketMode === 4 ? "/overlay/bracket4.png" : "/overlay/bracket8.png";
  const textColor = "#d9d9d9";
  const bracketTeamFontSizePx = 34;

  const bracketBoxes =
    bracketMode === 4
      ? {
          /**
           * 4-team bracket slots (top → bottom, left then GF), from user-supplied corners.
           */
          fourTeamSlots: [
            // Box #1
            pctRectFromCorners([
              [412, 331],
              [724, 331],
              [724, 375],
              [412, 375],
            ]),
            // Box #2: 412,379 / 724,378 / 724,422 / 412,422
            pctRectFromCorners([
              [412, 379],
              [724, 378],
              [724, 422],
              [412, 422],
            ]),
            // Box #3
            pctRectFromCorners([
              [412, 703],
              [724, 703],
              [724, 747],
              [412, 747],
            ]),
            // Box #4
            pctRectFromCorners([
              [412, 750],
              [724, 750],
              [724, 794],
              [412, 794],
            ]),
            // Box #5: 980,512 / 1293,512 / 1293,556 / 980,556
            pctRectFromCorners([
              [980, 512],
              [1293, 512],
              [1293, 556],
              [980, 556],
            ]),
            // Box #6
            pctRectFromCorners([
              [980, 559],
              [1293, 559],
              [1293, 603],
              [980, 603],
            ]),
          ],
        }
      : {
          /**
           * 8-team bracket slots. Order mirrors QF match order (M0 home, M0 away,
           * M1 home, M1 away, …) so that `quarterSlots[i]` lines up with QF Box i+1.
           * Semifinals follow the same home/away flattening; GF is [top, bottom].
           * Coordinates are TL/BR pixel pairs on the 1920×1080 native canvas.
           */
          quarterFinals: [
            // QF Box 1 — M0 home
            pctRectFromCorners([
              [255, 195],
              [567, 240],
            ]),
            // QF Box 2 — M0 away
            pctRectFromCorners([
              [255, 244],
              [567, 287],
            ]),
            // QF Box 3 — M1 home
            pctRectFromCorners([
              [255, 374],
              [567, 417],
            ]),
            // QF Box 4 — M1 away
            pctRectFromCorners([
              [255, 420],
              [567, 464],
            ]),
            // QF Box 5 — M2 home
            pctRectFromCorners([
              [255, 568],
              [567, 612],
            ]),
            // QF Box 6 — M2 away
            pctRectFromCorners([
              [255, 615],
              [567, 659],
            ]),
            // QF Box 7 — M3 home
            pctRectFromCorners([
              [255, 746],
              [567, 790],
            ]),
            // QF Box 8 — M3 away
            pctRectFromCorners([
              [255, 793],
              [567, 836],
            ]),
          ],
          semiFinals: [
            // SF Box 9 — SF0 home
            pctRectFromCorners([
              [827, 285],
              [1140, 328],
            ]),
            // SF Box 10 — SF0 away
            pctRectFromCorners([
              [827, 332],
              [1140, 373],
            ]),
            // SF Box 11 — SF1 home
            pctRectFromCorners([
              [827, 657],
              [1140, 699],
            ]),
            // SF Box 12 — SF1 away
            pctRectFromCorners([
              [827, 704],
              [1140, 746],
            ]),
          ],
          grandFinal: [
            // GF Box 13 — top (home)
            pctRectFromCorners([
              [1398, 465],
              [1709, 508],
            ]),
            // GF Box 14 — bottom (away)
            pctRectFromCorners([
              [1398, 513],
              [1709, 557],
            ]),
          ] as const,
        };
  const quarterBoxes =
    bracketMode === 8
      ? (bracketBoxes as {
          quarterFinals: Array<{
            left: string;
            top: string;
            width: string;
            height: string;
          }>;
        }).quarterFinals
      : [];
  const fourTeamBoxes =
    bracketMode === 4
      ? (bracketBoxes as {
          fourTeamSlots: Array<{
            left: string;
            top: string;
            width: string;
            height: string;
          }>;
        }).fourTeamSlots
      : [];
  const eightSemiBoxes =
    bracketMode === 8
      ? (bracketBoxes as {
          semiFinals: Array<{
            left: string;
            top: string;
            width: string;
            height: string;
          }>;
        }).semiFinals
      : [];
  /**
   * 8-team GF is supplied as two explicit pct rects (top = home, bottom = away),
   * so no mid-height split math is needed.
   */
  const eightGrandSplitBoxes =
    bracketMode === 8
      ? (bracketBoxes as {
          grandFinal: readonly [
            { left: string; top: string; width: string; height: string },
            { left: string; top: string; width: string; height: string },
          ];
        }).grandFinal
      : null;

  useEffect(() => {
    setUrlSearch(typeof window !== "undefined" ? window.location.search : "");
  }, []);

  useEffect(() => {
    setBracketHighlightMatchId(null);
  }, [overlayTournamentId]);

  useEffect(() => {
    if (isPreview) return;
    let channel: BroadcastChannel;
    try {
      channel = openOverlayOutputChannel();
    } catch {
      return;
    }
    channel.postMessage({ kind: "ping" } satisfies OverlayOutputBroadcast);
    channel.onmessage = (ev: MessageEvent) => {
      if (!isOverlayOutputBroadcast(ev.data)) return;
      const m = ev.data;
      if (m.kind === "live" || m.kind === "pong") {
        setOutputLive(m.live);
      } else if (m.kind === "scene") {
        const params = new URLSearchParams(window.location.search);
        const locked = params.get("outputScene");
        if (locked === "bracket" || locked === "scoreboard") return;
        if (!isPreview) setScene(m.scene);
      } else if (m.kind === "bracket-current-match") {
        if (m.tournamentId == null && m.matchId == null) {
          setBracketHighlightMatchId(null);
        } else if (m.tournamentId === overlayTournamentId) {
          setBracketHighlightMatchId(m.matchId);
        }
      } else if (m.kind === "scoreboard-mode") {
        /** Only react to broadcasts that match this window's event. Prevents a
         *  stale dashboard tab from driving the wrong tournament's output. */
        if (m.tournamentId != null && m.tournamentId !== overlayTournamentId) return;
        setScoreboardMode(m.mode);
        setTeamListAId(m.teamAId);
        setTeamListBId(m.teamBId);
      } else if (m.kind === "team-list-highlight") {
        if (m.tournamentId != null && m.tournamentId !== overlayTournamentId) return;
        setTeamListHighlight(m.highlight);
      }
    };
    const onPageHide = (ev: PageTransitionEvent) => {
      if (isPreview || ev.persisted) return;
      const params = new URLSearchParams(window.location.search);
      /** Closing the bracket window alone should not flip dashboard "live" off (scoreboard may stay open). */
      if (params.get("outputScene") === "bracket") return;
      try {
        channel.postMessage({ kind: "output-closed" } satisfies OverlayOutputBroadcast);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      channel.close();
    };
  }, [isPreview, overlayTournamentId]);

  useEffect(() => {
    if (!isPreview) return;
    let channel: BroadcastChannel;
    try {
      channel = openOverlayOutputChannel();
    } catch {
      return;
    }
    channel.onmessage = (ev: MessageEvent) => {
      if (!isOverlayOutputBroadcast(ev.data)) return;
      const m = ev.data;
      if (m.kind === "live" || m.kind === "pong") {
        setOutputLive(m.live);
      } else if (m.kind === "bracket-current-match") {
        if (m.tournamentId == null && m.matchId == null) {
          setBracketHighlightMatchId(null);
        } else if (m.tournamentId === overlayTournamentId) {
          setBracketHighlightMatchId(m.matchId);
        }
      } else if (m.kind === "scoreboard-mode") {
        if (m.tournamentId != null && m.tournamentId !== overlayTournamentId) return;
        setScoreboardMode(m.mode);
        setTeamListAId(m.teamAId);
        setTeamListBId(m.teamBId);
      } else if (m.kind === "team-list-highlight") {
        if (m.tournamentId != null && m.tournamentId !== overlayTournamentId) return;
        setTeamListHighlight(m.highlight);
      }
    };
    channel.postMessage({ kind: "ping" } satisfies OverlayOutputBroadcast);
    return () => {
      channel.close();
    };
  }, [isPreview, overlayTournamentId]);

  /**
   * Clear the highlight any time the team list becomes invisible or swaps
   * rosters — a dangling highlight index would otherwise glow the wrong
   * player (or a nonexistent index) after the roster changes. The
   * `setTeamListHighlight(null)` here is local-only; broadcasting a null
   * highlight here would race with the dashboard's own resets.
   */
  useEffect(() => {
    if (scoreboardMode !== "teams") {
      setTeamListHighlight(null);
    }
  }, [scoreboardMode]);
  useEffect(() => {
    setTeamListHighlight(null);
  }, [teamListAId, teamListBId]);

  useEffect(() => {
    if (!isPreview) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { kind?: string; scene?: string } | null;
      if (!data || data.kind !== "matbeast-preview-scene") return;
      if (data.scene === "scoreboard" || data.scene === "bracket") {
        setPreviewScene(data.scene);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [isPreview]);

  useEffect(() => {
    if (isPreview) return;
    const prevBody = document.body.style.backgroundColor;
    const prevHtml = document.documentElement.style.backgroundColor;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.backgroundColor = OVERLAY_OUTPUT_CHROME_BG;
    document.documentElement.style.backgroundColor = OVERLAY_OUTPUT_CHROME_BG;
    /** Root layout uses `overflow-hidden`; transparent Electron windows can clip composited text. */
    document.body.style.overflow = "visible";
    document.documentElement.style.overflow = "visible";
    return () => {
      document.body.style.backgroundColor = prevBody;
      document.documentElement.style.backgroundColor = prevHtml;
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, [isPreview]);

  useEffect(() => {
    function fit() {
      const sx = window.innerWidth / W;
      const sy = window.innerHeight / H;
      const s = Math.min(sx, sy);
      /** Avoid scale(0) / NaN on odd first paints (Electron/OBS) which hides all overlay text. */
      setScale(Number.isFinite(s) && s > 0 ? s : 1);
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    if (isPreview) return;
    const prev = document.title;
    document.title = activeScene === "bracket" ? "BRACKETOVERLAY" : "SCOREBOARDOVERLAY";
    return () => {
      document.title = prev;
    };
  }, [isPreview, activeScene]);

  const scoreboardTimerLine = scoreboardTimerLineFromBoard(board ?? undefined);
  const scoreboardRoundLine = scoreboardSubclockRoundLabelFromBoard(board ?? undefined);
  /**
   * Scoreboard DOM text: previously gated on `currentRosterFileName !== "UNTITLED"`
   * as a first-launch convenience. That gate was too aggressive — it also
   * hid text any time the board's filename temporarily came back as
   * UNTITLED (new event tab, open-flow race). Show text whenever `board`
   * has loaded so OVERLAY LIVE always renders the current state.
   */
  const showScoreboardText = Boolean(board);

  if (typeof document === "undefined" || !document.body) {
    return null;
  }

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483646,
        fontFamily: OVERLAY_FONT_STACK,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: isPreview ? "#52525b" : OVERLAY_OUTPUT_CHROME_BG,
        /**
         * Inset teal frame is operator-confidence-only — broadcast viewers
         * via NDI must never see it. `isNdi` suppresses it on the offscreen
         * renderer; the visible scoreboard / bracket windows keep it so the
         * operator can verify capture extents at a glance.
         */
        ...(isPreview || isNdi ? {} : OVERLAY_OUTPUT_FRAME_STYLE),
      }}
    >
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          width: W,
          height: H,
          overflow: isPreview ? "hidden" : "visible",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          backgroundColor: isPreview ? "#52525b" : OVERLAY_OUTPUT_CHROME_BG,
        }}
      >
        {isPreview ? (
          <>
            {/* Preview-only: red background barn doors behind scoreboard content. */}
            <div
              style={{
                pointerEvents: "none",
                position: "absolute",
                left: 0,
                top: 0,
                width: "50%",
                height: "100%",
                zIndex: 0,
                backgroundColor: "#7f1d1d",
                transform: previewRedDoorOpen ? "translateX(-100%)" : "translateX(0)",
                transition: `transform ${OVERLAY_BARN_DOOR_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                willChange: "transform",
              }}
              aria-hidden
            />
            <div
              style={{
                pointerEvents: "none",
                position: "absolute",
                right: 0,
                top: 0,
                width: "50%",
                height: "100%",
                zIndex: 0,
                backgroundColor: "#7f1d1d",
                transform: previewRedDoorOpen ? "translateX(100%)" : "translateX(0)",
                transition: `transform ${OVERLAY_BARN_DOOR_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
                willChange: "transform",
              }}
              aria-hidden
            />
          </>
        ) : null}
        {/* Portaled to document.body so root layout `overflow-hidden` cannot clip the stage. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            width: "100%",
            height: "100%",
            clipPath: outputScoreboardVisible
              ? "inset(0 0 0 0)"
              : "inset(0 50% 0 50%)",
            transition: disableBarnDoor
              ? "none"
              : `clip-path ${OVERLAY_BARN_DOOR_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
            willChange: "clip-path",
          }}
        >
          {activeScene === "bracket" ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
              }}
            >
              <img
                src={bracketBackground}
                alt=""
                className="pointer-events-none"
                draggable={false}
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "fill",
                }}
              />
              <div
                className="pointer-events-none"
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 30,
                  color: "#d9d9d9",
                  backgroundColor: "rgba(0,0,0,0.02)",
                }}
              >
                <OverlayCanvasTextLayer
                  scene="bracket"
                  board={board}
                  timerLine=""
                  roundLine=""
                  bracketMode={bracketMode}
                  bracketSlots={bracketSlots}
                  fourTeamBoxes={fourTeamBoxes}
                  quarterBoxes={quarterBoxes}
                  eightSemiBoxes={eightSemiBoxes}
                  eightGrandSplitBoxes={eightGrandSplitBoxes}
                  bracketOverlayEventTitle={bracketOverlayEventTitle}
                  bracketHighlightMatchId={bracketHighlightMatchId}
                  bracketTeamFontSizePx={bracketTeamFontSizePx}
                  defaultTextColor={textColor}
                />
              </div>
            </div>
          ) : (
            <>
          {/**
           * Scoreboard-vs-teams crossfade wrapper. Both sub-layers stay mounted
           * whenever the scene is "scoreboard" so the opacity transition can
           * interpolate in both directions. The barn-door `clip-path` on the
           * ancestor wrapper still drives the OVERLAY LIVE / STOPPED motion
           * against whichever sub-layer is currently visible — the two
           * transitions compose cleanly. Fully transparent while OVERLAY is
           * stopped (barn doors closed) so nothing is shown on the output.
           */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: scoreboardMode === "scoreboard" ? 1 : 0,
              transition: "opacity 1000ms ease-in-out",
              willChange: "opacity",
            }}
          >
          {/* Background art — z-0 so dynamic text (z-10) always paints above the SVG in Electron/OBS. */}
          <img
            src="/scoreboard.svg"
            alt=""
            className="pointer-events-none"
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
            }}
          />

          {/* Dynamic layer — regions from SVG viewBox (see scoreboard-layout.ts) */}
          <div
            className="pointer-events-none"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 30,
              color: "#d9d9d9",
              backgroundColor: "rgba(0,0,0,0.02)",
            }}
          >
            {showScoreboardText ? (
              <>
            {/* Time + round — path252 center cell */}
            <div
              className="gap-0 overflow-hidden px-2"
              style={{
                ...vbRectToPercentStyle(CENTER_TIMER),
                position: "absolute",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                className={`shrink-0 px-1 text-center font-black leading-none tabular-nums drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)] ${
                  board?.timerRestMode
                    ? "text-amber-300"
                    : scoreboardOtRedTimerStyle(board ?? undefined)
                      ? "text-red-800"
                      : ""
                }`}
                style={{
                  /** Fixed px sizing on 1920 stage keeps preview/output identical. */
                  fontSize: "141px",
                  lineHeight: 1,
                  color: board?.timerRestMode
                    ? "#fcd34d"
                    : scoreboardOtRedTimerStyle(board ?? undefined)
                      ? SCOREBOARD_OT_MAIN_HEX
                      : "#e5e7eb",
                }}
              >
                {scoreboardTimerLine}
              </span>
              <span
                className={`w-full min-w-0 max-w-full text-center font-semibold uppercase leading-none drop-shadow-[0_2px_8px_black] ${
                  board?.timerRestMode
                    ? "text-amber-300"
                    : scoreboardOtRedTimerStyle(board ?? undefined)
                      ? "text-red-800"
                      : "text-zinc-200"
                }`}
                style={{
                  fontSize: "42px",
                  lineHeight: 1,
                  marginTop: "-0.18em",
                  color: board?.timerRestMode
                    ? "#fcd34d"
                    : scoreboardOtRedTimerStyle(board ?? undefined)
                      ? SCOREBOARD_OT_SUBLINE_HEX
                      : "#d9d9d9",
                }}
              >
                {scoreboardRoundLine}
              </span>
            </div>

            {/* OT readout — path300 strip */}
            {board && board.timerPhase === "OVERTIME" && (
              <div
                className="overflow-hidden"
                style={{
                  ...vbRectToPercentStyle(CENTER_OT_STRIP),
                  position: "absolute",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <span
                  className="text-center font-semibold tabular-nums text-amber-200 drop-shadow-[0_2px_6px_black]"
                  style={{ fontSize: "50px", color: "#fde68a" }}
                >
                  OT {board.overtimeIndex} · L{board.overtimeWinsLeft} R
                  {board.overtimeWinsRight}
                </span>
              </div>
            )}

            {/* Left upper strip: player last name, right-aligned toward center */}
            <div
              className="overflow-hidden text-right"
              style={{
                ...vbRectToPercentStyle(LEFT_PLAYER_STRIP),
                paddingRight: "3ch",
                position: "absolute",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              <div
                className={`max-w-full truncate font-bold leading-none drop-shadow-[0_2px_8px_black] ${
                  board?.finalSaved &&
                    (board.showFinalWinnerHighlight ?? true) &&
                    finalWinnerIsLeft(board.finalResultType)
                    ? "text-emerald-400"
                    : "text-zinc-200"
                }`}
                style={{
                  fontSize: "54.9px",
                  letterSpacing: "0.05em",
                  transform: "translateY(4px)",
                  color:
                    board?.finalSaved &&
                    (board.showFinalWinnerHighlight ?? true) &&
                    finalWinnerIsLeft(board.finalResultType)
                      ? "#34d399"
                      : "#d9d9d9",
                }}
              >
                {overlayFullName(board?.left)}
              </div>
            </div>

            {/* Left lower strip: team name, right-aligned toward center */}
            <div
              className="overflow-hidden text-right"
              style={{
                ...vbRectToPercentStyle(LEFT_TEAM_STRIP),
                paddingRight: "3ch",
                position: "absolute",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              <div
                className="max-w-full truncate font-medium leading-none text-zinc-200 drop-shadow-[0_2px_6px_black]"
                style={{
                  fontSize: "44px",
                  letterSpacing: "0.05em",
                  transform: "translateY(2px)",
                  color: "#d9d9d9",
                }}
              >
                {(board?.left?.teamName ?? "").toUpperCase()}
              </div>
            </div>

            {/* Right upper strip: player last name, left-aligned toward center */}
            <div
              className="overflow-hidden text-left"
              style={{
                ...vbRectToPercentStyle(RIGHT_PLAYER_STRIP),
                paddingLeft: "3ch",
                position: "absolute",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
              }}
            >
              <div
                className={`max-w-full truncate font-bold leading-none drop-shadow-[0_2px_8px_black] ${
                  board?.finalSaved &&
                    (board.showFinalWinnerHighlight ?? true) &&
                    finalWinnerIsRight(board.finalResultType)
                    ? "text-emerald-400"
                    : "text-zinc-200"
                }`}
                style={{
                  fontSize: "54.9px",
                  letterSpacing: "0.05em",
                  transform: "translateY(4px)",
                  color:
                    board?.finalSaved &&
                    (board.showFinalWinnerHighlight ?? true) &&
                    finalWinnerIsRight(board.finalResultType)
                      ? "#34d399"
                      : "#d9d9d9",
                }}
              >
                {overlayFullName(board?.right)}
              </div>
            </div>

            {/* Right lower strip: team name, left-aligned toward center */}
            <div
              className="overflow-hidden text-left"
              style={{
                ...vbRectToPercentStyle(RIGHT_TEAM_STRIP),
                paddingLeft: "3ch",
                position: "absolute",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
              }}
            >
              <div
                className="max-w-full truncate font-medium leading-none text-zinc-200 drop-shadow-[0_2px_6px_black]"
                style={{
                  fontSize: "44px",
                  letterSpacing: "0.05em",
                  transform: "translateY(2px)",
                  color: "#d9d9d9",
                }}
              >
                {(board?.right?.teamName ?? "").toUpperCase()}
              </div>
            </div>

          {/* Red X on built-in silhouette icons (g43 / g47), inner-first */}
          <SilhouetteCrosses
            side="left"
            crossed={board?.leftCrossedSilhouettes ?? []}
          />
          <SilhouetteCrosses
            side="right"
            crossed={board?.rightCrossedSilhouettes ?? []}
          />
              </>
            ) : null}
        </div>
          </div>
          {/**
           * Team-list sibling layer. Shares the same barn-door wrapper so
           * OVERLAY LIVE / STOPPED transitions apply identically; opacity
           * crossfades against the scoreboard graphic over 1 s whenever the
           * dashboard broadcasts a `scoreboard-mode` change.
           *
           * `pointerEvents` toggles with visibility so clicks only hit the
           * team list when it's actually on screen — while the team list is
           * faded out it must not intercept clicks intended for the
           * scoreboard below it (OBS / preview iframe alike). The individual
           * player spans inside opt back in via `pointer-events: auto` so
           * clicks that miss a name fall through this layer.
           */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: scoreboardMode === "teams" ? 1 : 0,
              transition: "opacity 1000ms ease-in-out",
              willChange: "opacity",
              pointerEvents: scoreboardMode === "teams" ? "auto" : "none",
            }}
          >
            <OverlayTeamListLayer
              teamA={teamListInputA}
              teamB={teamListInputB}
              highlight={teamListHighlight}
              onPlayerClick={(position: TeamListHighlightPosition) => {
                /**
                 * Click-to-glow semantics (2026-04-17):
                 * - Clicking the currently-highlighted name clears the
                 *   highlight (toggle off).
                 * - Clicking a different name replaces the selection —
                 *   both the outgoing and incoming spans animate their
                 *   1 s color / text-shadow transitions simultaneously so
                 *   the swap visually cross-fades.
                 * The broadcast drives every subscriber (this window's
                 *  local state updates when the echoed message arrives
                 *  via BroadcastChannel — no optimistic local write).
                 */
                const isSamePlayer =
                  teamListHighlight &&
                  teamListHighlight.team === position.team &&
                  teamListHighlight.playerIndex === position.playerIndex;
                postTeamListHighlight(
                  overlayTournamentId || null,
                  isSamePlayer ? null : position,
                );
              }}
            />
          </div>
            </>
          )}
        </div>

      </div>
    </div>,
    document.body,
  );
}
