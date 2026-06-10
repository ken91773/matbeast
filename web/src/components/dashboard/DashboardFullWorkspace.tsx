"use client";

import { useOverlayOutputLiveControl } from "@/hooks/useOverlayOutputLiveControl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { createEventFileLayoutStorage } from "@/lib/dashboard-layout-storage";
import BracketPanel from "@/components/BracketPanel";
import ControlPanel from "@/components/ControlPanel";
import { RosterClient } from "@/app/roster/RosterClient";
import { DashboardTeamsPanel } from "@/components/dashboard/DashboardTeamsPanel";
import { NdiStatusPill } from "@/components/dashboard/NdiStatusPill";
import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import { normalizeEventFileKey } from "@/lib/event-file-key";
import { formatControlCardFinalHeader } from "@/lib/control-final-header";
import {
  MATBEAST_TOURNAMENT_HEADER,
  matbeastFetch,
} from "@/lib/matbeast-fetch";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { matbeastJson } from "@/lib/matbeast-query";
import {
  OVERLAY_APPLY_PROPAGATION_MS,
  postScoreboardMode,
} from "@/lib/overlay-output-broadcast";
import type { BoardPayload } from "@/types/board";
import { ResultsLogPanel, ResultsExportButton } from "@/components/ResultsLogPanel";
import { useQuery } from "@tanstack/react-query";

/** Fills parent panel; scroll inside */
const CARD_FRAME =
  "flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800/90 bg-[#161616] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]";

function SectionShell({
  id,
  title,
  titleHint,
  subtitle,
  headerActions,
  children,
  frameClass = CARD_FRAME,
}: {
  id?: string;
  title: string;
  titleHint?: string;
  subtitle?: string;
  headerActions?: ReactNode;
  children: ReactNode;
  frameClass?: string;
}) {
  return (
    <section id={id} className={frameClass}>
      <header className="shrink-0 border-b border-teal-950/40 bg-[#111] px-2 py-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 shrink items-center gap-2">
            <h2 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-teal-100/90">
              {title}
            </h2>
            {titleHint ? (
              <span className="min-w-0 truncate text-[10px] text-zinc-500">{titleHint}</span>
            ) : null}
          </div>
          {headerActions ? (
            <div className="flex min-w-0 flex-1 justify-end">{headerActions}</div>
          ) : null}
        </div>
        {subtitle ? (
          <p className="mt-0 text-[10px] leading-tight text-zinc-500">{subtitle}</p>
        ) : null}
      </header>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain text-[11px] leading-tight">
        {children}
      </div>
    </section>
  );
}

function ResultsBody() {
  return <ResultsLogPanel />;
}

function NeedEventPlaceholder() {
  return (
    <div className="flex flex-1 items-center justify-center p-4 text-[13px] text-zinc-500">
      Open or create new event
    </div>
  );
}

function ControlCardHeaderActions({ tournamentId }: { tournamentId: string }) {
  const { ready } = useEventWorkspace();
  const { data: board } = useQuery({
    queryKey: matbeastKeys.board(tournamentId),
    queryFn: async ({ signal }) => {
      const res = await matbeastFetch("/api/board", {
        cache: "no-store",
        signal,
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId },
      });
      if (!res.ok) {
        throw new Error(`${res.status}`);
      }
      return (await res.json()) as BoardPayload;
    },
    enabled: ready && !!tournamentId,
    refetchInterval: 1000,
  });
  const finalLine = board ? formatControlCardFinalHeader(board) : null;
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      {finalLine ? (
        <span
          className="min-w-0 truncate text-[11px] font-normal uppercase tracking-[0.1em] text-zinc-400"
          title={finalLine}
        >
          {finalLine}
        </span>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded border border-red-900/50 bg-red-950/35 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-200/95 hover:bg-red-900/40"
        onClick={() =>
          window.dispatchEvent(new CustomEvent("matbeast-control-full-match-reset"))
        }
      >
        Full match reset
      </button>
    </div>
  );
}

function BracketHeaderActions({ tournamentId }: { tournamentId: string | null }) {
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <button
        type="button"
        disabled={!tournamentId}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("matbeast-bracket-generate", {
              detail: { tournamentId },
            }),
          )
        }
        className="rounded bg-teal-600 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-black hover:bg-teal-500 disabled:opacity-50"
      >
        GENERATE BRACKET
      </button>
    </div>
  );
}

type ObsUrlEntry = {
  ip: string;
  label: string;
  /** Scoreboard scene (barn doors + SHOW TEAMS + audible cues). */
  url: string;
  /** Bracket scene — a separate browser source on the same or another PC. */
  bracketUrl: string;
};

/**
 * "Show OBS URL" — surfaces the exact Browser Source URL an operator pastes
 * into OBS (or any browser-source-capable streaming app) on a *different*
 * computer to pull this scoreboard overlay over the LAN.
 *
 *   Scoreboard: http://<LAN_IP>:<port>/overlay?outputScene=scoreboard&audio=1
 *   Bracket:    http://<LAN_IP>:<port>/overlay?outputScene=bracket
 *
 * - LAN IP(s) come from the NDI adapter enumeration (`getNdiState`), so no
 *   extra IPC is needed; routable Wi-Fi/Ethernet NICs are listed first and
 *   the operator picks the one on the same network as the OBS machine.
 * - Port is read live from `window.location.port` (the bundled server port —
 *   now the stable fixed port unless it had to fall back), so the URL always
 *   matches the running instance.
 * - `audio=1` enables the audible timer cues (10s warning + air horn) through
 *   the browser source; `ndi=1` is intentionally NOT included (that flag is
 *   only for the app's internal offscreen NDI feed).
 * - No `disableBarnDoor` flag: the remote overlay now replicates the live show
 *   (OVERLAY LIVE / barn doors, SHOW TEAMS swaps + fades) by polling the
 *   server-mirrored control state (`/api/overlay-control`).
 * - The URL deliberately carries **no `tournamentId`** so it stays constant
 *   across event re-opens / crashes / relaunches: the overlay follows whatever
 *   event the operator is currently driving (published to
 *   `/api/active-tournament`). Baking an id in would break on every reopen
 *   because opening an event file mints a new tournament row each time.
 */
function ShowObsUrlButton() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ObsUrlEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const overlayPort = (): string =>
    (typeof window !== "undefined" && window.location.port) || "47800";
  const buildUrl = (ip: string): string =>
    `http://${ip}:${overlayPort()}/overlay?outputScene=scoreboard&audio=1`;
  const buildBracketUrl = (ip: string): string =>
    `http://${ip}:${overlayPort()}/overlay?outputScene=bracket`;

  const togglePanel = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setCopied(null);
    setLoading(true);
    try {
      const state = await window.matBeastDesktop?.getNdiState?.();
      const adapters = state?.adapters ?? [];
      const routable = adapters.filter(
        (a) => a.isRoutable && !a.isLoopback && !a.isApipa && !a.isLikelyVirtual,
      );
      const chosen = routable.length ? routable : adapters;
      setEntries(
        chosen.map((a) => ({
          ip: a.ip,
          label: a.friendlyName || a.adapterName,
          url: buildUrl(a.ip),
          bracketUrl: buildBracketUrl(a.ip),
        })),
      );
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 2000);
    } catch {
      /* clipboard blocked — operator can still select the text manually */
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={togglePanel}
        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-200 hover:bg-zinc-700"
        title="Show the URL to paste into OBS / a browser source on another computer"
      >
        Show OBS URL
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-[28rem] max-w-[90vw] rounded-md border border-zinc-700 bg-[#1b1b1b] p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-zinc-200">
              OBS Browser Source URL
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              Close
            </button>
          </div>
          {loading ? (
            <p className="text-[11px] text-zinc-400">Finding network addresses…</p>
          ) : entries.length === 0 ? (
            <p className="text-[11px] text-zinc-400">
              No network addresses found. Make sure this PC is connected to the
              event network, then reopen this panel.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {entries.length > 1 ? (
                <p className="text-[10px] leading-snug text-zinc-500">
                  Pick the address on the same network as the OBS computer.
                </p>
              ) : null}
              {entries.map((e) => (
                <div
                  key={e.ip}
                  className="rounded border border-zinc-800 bg-[#141414] p-2"
                >
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    {e.label} · {e.ip}
                  </div>
                  <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                    Scoreboard
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={e.url}
                      onFocus={(ev) => ev.currentTarget.select()}
                      className="min-w-0 flex-1 rounded bg-black/40 px-2 py-1 text-[10px] text-zinc-300 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => copy(e.url)}
                      className="shrink-0 rounded bg-teal-600 px-2 py-1 text-[10px] font-semibold text-black hover:bg-teal-500"
                    >
                      {copied === e.url ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <div className="mb-0.5 mt-2 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                    Bracket (separate source)
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={e.bracketUrl}
                      onFocus={(ev) => ev.currentTarget.select()}
                      className="min-w-0 flex-1 rounded bg-black/40 px-2 py-1 text-[10px] text-zinc-300 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => copy(e.bracketUrl)}
                      className="shrink-0 rounded bg-teal-600 px-2 py-1 text-[10px] font-semibold text-black hover:bg-teal-500"
                    >
                      {copied === e.bracketUrl ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] leading-snug text-zinc-500">
            This URL is permanent — it follows whichever event you have open, so
            it keeps working after reopening an event or relaunching the app.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Split layouts are stored per saved event file name (`currentRosterFileName`),
 * not the DB tournament cuid. UNTITLED uses in-memory storage only (defaults for new events).
 */
function DashboardResizablePanels({
  tournamentId,
  layoutStorageKey,
}: {
  tournamentId: string | null;
  /** From board `currentRosterFileName`; null = UNTITLED / unsaved */
  layoutStorageKey: string | null;
}) {
  const storage = useMemo(
    () => createEventFileLayoutStorage(layoutStorageKey),
    [layoutStorageKey],
  );

  const mainLayout = useDefaultLayout({
    id: "matbeast-dashboard-main",
    storage,
    panelIds: ["main-left", "main-right"],
  });
  const leftLayout = useDefaultLayout({
    id: "matbeast-dashboard-left",
    storage,
    panelIds: ["left-teams", "left-roster", "left-results"],
  });
  const rightLayout = useDefaultLayout({
    id: "matbeast-dashboard-right",
    storage,
    panelIds: ["right-brackets", "right-control"],
  });

  return (
    <Group
      orientation="horizontal"
      id="matbeast-dashboard-main"
      className="min-h-0 flex-1"
      defaultLayout={mainLayout.defaultLayout}
      onLayoutChanged={mainLayout.onLayoutChanged}
    >
      <Panel
        id="main-left"
        defaultSize="34%"
        minSize="20%"
        maxSize="55%"
        className="min-h-0 min-w-0"
      >
        <Group
          orientation="vertical"
          id="matbeast-dashboard-left"
          className="h-full min-h-0"
          defaultLayout={leftLayout.defaultLayout}
          onLayoutChanged={leftLayout.onLayoutChanged}
        >
          <Panel
            id="left-teams"
            defaultSize="34%"
            minSize="12%"
            className="min-h-0 min-w-0"
          >
            <DashboardTeamsPanel />
          </Panel>
          <Separator className="dashboard-resize-h" />
          <Panel
            id="left-roster"
            defaultSize="38%"
            minSize="18%"
            className="min-h-0 min-w-0"
          >
            <SectionShell id="roster-input" title="Roster">
              {tournamentId ? (
                <RosterClient
                  key={tournamentId}
                  embed
                  dashboardPlayerCard
                  dashboardLiveTournamentId={tournamentId}
                  title=""
                  subtitle=""
                  shellClassName="scrollbar-thin min-h-0 border-0 bg-transparent p-2 shadow-none"
                />
              ) : (
                <NeedEventPlaceholder />
              )}
            </SectionShell>
          </Panel>
          <Separator className="dashboard-resize-h" />
          <Panel
            id="left-results"
            defaultSize="28%"
            minSize="12%"
            className="min-h-0 min-w-0"
          >
            <SectionShell
              id="results"
              title="Results"
              headerActions={tournamentId ? <ResultsExportButton /> : undefined}
            >
              {tournamentId ? <ResultsBody /> : <NeedEventPlaceholder />}
            </SectionShell>
          </Panel>
        </Group>
      </Panel>

      <Separator className="dashboard-resize-v" />

      <Panel
        id="main-right"
        defaultSize="66%"
        minSize="40%"
        className="min-h-0 min-w-0"
      >
        <Group
          orientation="vertical"
          id="matbeast-dashboard-right"
          className="h-full min-h-0"
          defaultLayout={rightLayout.defaultLayout}
          onLayoutChanged={rightLayout.onLayoutChanged}
        >
          <Panel
            id="right-brackets"
            defaultSize="52%"
            minSize="22%"
            className="min-h-0 min-w-0"
          >
            <SectionShell
              title="Brackets"
              titleHint="Click on match border for current match"
              frameClass={CARD_FRAME}
              headerActions={<BracketHeaderActions tournamentId={tournamentId} />}
            >
              {tournamentId ? <BracketPanel embed /> : <NeedEventPlaceholder />}
            </SectionShell>
          </Panel>
          <Separator className="dashboard-resize-h" />
          <Panel
            id="right-control"
            defaultSize="48%"
            minSize="22%"
            className="min-h-0 min-w-0"
          >
            <SectionShell
              id="control"
              title="Control - Scoreboard"
              frameClass={CARD_FRAME}
              headerActions={
                tournamentId ? <ControlCardHeaderActions tournamentId={tournamentId} /> : null
              }
            >
              {tournamentId ? (
                <div className="p-1">
                  <ControlPanel key={tournamentId} />
                </div>
              ) : (
                <NeedEventPlaceholder />
              )}
            </SectionShell>
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}

type OverlayTeamRow = {
  id: string;
  name: string;
  seedOrder: number;
};

/** Order-sensitive equality for the bracket current-match team-id tuples. */
function sameStringArray(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Small-font team picker used in the Overlay card header. Renders a native
 * `<select>` styled to match the surrounding mini buttons plus an inline ✕
 * clear button that resets the selection to the disabled "SELECT TEAM"
 * option. The `excludeId` prop drops the *other* dropdown's current pick
 * from this one's list so the user can't select the same team twice.
 */
function OverlayTeamPicker({
  label,
  value,
  onChange,
  teams,
  excludeId,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  teams: OverlayTeamRow[];
  excludeId: string;
}) {
  const options = useMemo(
    () => teams.filter((t) => !excludeId || t.id !== excludeId),
    [teams, excludeId],
  );
  return (
    <label className="flex items-center gap-1">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-5 rounded border border-zinc-600/60 bg-zinc-800/70 px-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-200 focus:border-teal-500/60 focus:outline-none"
      >
        <option value="" disabled>
          SELECT TEAM
        </option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name.toUpperCase()}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onChange("")}
        disabled={value === ""}
        aria-label={`Clear ${label}`}
        title={`Clear ${label}`}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] leading-none text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200 disabled:cursor-default disabled:text-zinc-700 disabled:hover:bg-transparent"
      >
        ×
      </button>
    </label>
  );
}

function OverlayStrip() {
  const { tournamentId } = useEventWorkspace();
  const [previewScale, setPreviewScale] = useState(0.4);
  const [previewScene, setPreviewScene] = useState<"scoreboard" | "bracket">("scoreboard");
  const [previewSceneSwitching, setPreviewSceneSwitching] = useState(false);
  /**
   * Iframe-based preview (re-adopted 2026-04-17). Replaced the 0.5.1
   * capture-based mirror so the preview can reflect scene / scoreboard-mode
   * toggles even while OVERLAY is STOPPED — `webContents.capturePage()` reads
   * the output window's clipped (empty) pixels when barn doors are closed, so
   * the mirror froze on scene changes. The iframe renders the `/overlay?preview=1`
   * page locally in the dashboard and reacts to the same BroadcastChannel
   * signals the output window listens to, so preview fidelity is decoupled
   * from the output window's live state. Roll back: re-introduce
   * `previewImageDataUrl` state + `captureOverlayPreview` interval and swap
   * the iframe for an <img> with the previous red-door overlays.
   */
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * Scoreboard content sub-mode (sticky within the scoreboard scene). Dashboard
   * state only — no DB, no event-file round-trip, no /api/board. Cold app start,
   * tab switch, and event reload all reset to `scoreboard`. Clicking SHOW TEAMS
   * opens the dropdowns immediately; APPLY commits the current selection to the
   * output window via BroadcastChannel and triggers a 1 s crossfade in the
   * scoreboard output window. SHOW SCOREBOARD is an instant revert (no APPLY
   * required).
   */
  const [overlayMode, setOverlayMode] = useState<"scoreboard" | "teams">("scoreboard");
  const [teamAId, setTeamAId] = useState<string>("");
  const [teamBId, setTeamBId] = useState<string>("");
  const [appliedTeamAId, setAppliedTeamAId] = useState<string>("");
  const [appliedTeamBId, setAppliedTeamBId] = useState<string>("");

  /**
   * CURRENT button: the two team ids of the match the operator highlighted in
   * gold in the Brackets panel, ordered [first/home, second/away]. Mirrored
   * from BracketPanel's `matbeast-bracket-selection` window event (same window,
   * sibling component). `null` = no match highlighted. The tap counter cycles
   * the dropdown population: 1 → TEAM A only, 2 → TEAM B only, 3 → both, 4 →
   * cleared, then repeats. Reset to 0 whenever the highlighted match changes or
   * the operator edits a dropdown by hand so CURRENT always starts a fresh cycle.
   */
  const [currentMatchTeamIds, setCurrentMatchTeamIds] = useState<string[] | null>(
    null,
  );
  const currentMatchTeamIdsRef = useRef<string[] | null>(null);
  const [currentTapCount, setCurrentTapCount] = useState(0);

  useEffect(() => {
    const onBracketSelection = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          tournamentId?: string | null;
          teamIds?: string[] | null;
        }>
      ).detail;
      if (!detail?.tournamentId || detail.tournamentId !== tournamentId) return;
      const ids = Array.isArray(detail.teamIds)
        ? detail.teamIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      const nextIds = ids.length > 0 ? ids : null;
      // Only restart the cycle when the *teams* actually change — BracketPanel
      // re-dispatches the same selection on every bracket data refetch, which
      // must not stomp a tap cycle the operator is in the middle of.
      if (!sameStringArray(currentMatchTeamIdsRef.current, nextIds)) {
        setCurrentTapCount(0);
      }
      currentMatchTeamIdsRef.current = nextIds;
      setCurrentMatchTeamIds(nextIds);
    };
    window.addEventListener("matbeast-bracket-selection", onBracketSelection);
    return () => {
      window.removeEventListener(
        "matbeast-bracket-selection",
        onBracketSelection,
      );
    };
  }, [tournamentId]);

  /**
   * Any time the user opens a different event (tournament id changes) the
   * ephemeral teams-mode state resets per spec. This also covers the "cold app
   * start" case since OverlayStrip remounts on fresh event load.
   */
  useEffect(() => {
    setOverlayMode("scoreboard");
    setTeamAId("");
    setTeamBId("");
    setAppliedTeamAId("");
    setAppliedTeamBId("");
    setCurrentMatchTeamIds(null);
    currentMatchTeamIdsRef.current = null;
    setCurrentTapCount(0);
    postScoreboardMode(tournamentId ?? null, "scoreboard", null, null);
  }, [tournamentId]);

  const { data: teamsPayload } = useQuery({
    queryKey: matbeastKeys.teams(tournamentId),
    queryFn: () =>
      matbeastJson<{ teams: OverlayTeamRow[] }>("/api/teams", {
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      }),
    enabled: !!tournamentId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  /** Dropdown list = named teams only (TBD/empty filtered out, per spec). */
  const namedTeams = useMemo(() => {
    const list = teamsPayload?.teams ?? [];
    return list
      .filter((t) => {
        const n = (t.name ?? "").trim();
        return n.length > 0 && n.toUpperCase() !== "TBD";
      })
      .slice()
      .sort((a, b) => a.seedOrder - b.seedOrder);
  }, [teamsPayload?.teams]);

  /** Auto-clear a selection whose team was deleted or renamed to TBD. */
  useEffect(() => {
    const ids = new Set(namedTeams.map((t) => t.id));
    if (teamAId && !ids.has(teamAId)) setTeamAId("");
    if (teamBId && !ids.has(teamBId)) setTeamBId("");
    if (appliedTeamAId && !ids.has(appliedTeamAId)) setAppliedTeamAId("");
    if (appliedTeamBId && !ids.has(appliedTeamBId)) setAppliedTeamBId("");
  }, [namedTeams, teamAId, teamBId, appliedTeamAId, appliedTeamBId]);

  const applyPending =
    overlayMode === "teams" &&
    (teamAId !== appliedTeamAId || teamBId !== appliedTeamBId) &&
    (teamAId !== "" || teamBId !== "");

  const handleShowTeamsToggle = () => {
    if (overlayMode === "scoreboard") {
      /** Entering teams mode: reveal the dropdowns (pre-populated with any
       *  previously entered picks — see the ephemeral-state spec: SHOW TEAMS ↔
       *  SHOW SCOREBOARD is a sticky toggle within a session, only cleared on
       *  event switch / app reload). If a prior selection was already APPLY'd,
       *  re-broadcast it so the output window crossfades back from the
       *  scoreboard to the same team list that was on-air before; with no
       *  previously-applied state, the output stays on scoreboard until APPLY. */
      setOverlayMode("teams");
      if (appliedTeamAId !== "" || appliedTeamBId !== "") {
        postScoreboardMode(
          tournamentId ?? null,
          "teams",
          appliedTeamAId || null,
          appliedTeamBId || null,
        );
      } else {
        /** No matchup applied yet: fade the scoreboard out to nothing now
         *  (blank) rather than leaving it on-air until APPLY. The overlay
         *  shows nothing until teams are picked and APPLY'd. */
        postScoreboardMode(tournamentId ?? null, "blank", null, null);
      }
      return;
    }
    /** SHOW SCOREBOARD click: instant revert — broadcast an immediate
     *  crossfade back to the scoreboard graphic, but preserve every
     *  team-related state variable so the next SHOW TEAMS click restores the
     *  same dropdown values and (if previously applied) re-emits the same
     *  team-list graphic. Only the cross-event reset in the `tournamentId`
     *  effect above clears this state. */
    setOverlayMode("scoreboard");
    postScoreboardMode(tournamentId ?? null, "scoreboard", null, null);
  };

  /**
   * Manual dropdown edits restart the CURRENT cycle so the next CURRENT tap
   * always begins at "TEAM A only" rather than resuming a stale phase.
   */
  const handleTeamAChange = (id: string) => {
    setTeamAId(id);
    setCurrentTapCount(0);
  };
  const handleTeamBChange = (id: string) => {
    setTeamBId(id);
    setCurrentTapCount(0);
  };

  /**
   * CURRENT: populate the dropdowns from the gold-highlighted bracket match,
   * cycling through both → TEAM A only → TEAM B only → cleared on successive
   * taps. With no highlighted match (or its slots aren't named teams), clear
   * both dropdowns and reset to the pre-selected (empty) state. CURRENT only
   * stages the dropdown selection; APPLY still commits it to the output.
   */
  const handleCurrent = () => {
    const ids = currentMatchTeamIds ?? [];
    const resolve = (id: string | undefined) =>
      id && namedTeams.some((t) => t.id === id) ? id : "";
    const firstId = resolve(ids[0]);
    const secondId = resolve(ids[1]);
    if (firstId === "" && secondId === "") {
      setTeamAId("");
      setTeamBId("");
      setCurrentTapCount(0);
      return;
    }
    const next = currentTapCount + 1;
    setCurrentTapCount(next);
    const phase = ((next - 1) % 4) + 1;
    if (phase === 1) {
      setTeamAId(firstId);
      setTeamBId(secondId);
    } else if (phase === 2) {
      setTeamAId(firstId);
      setTeamBId("");
    } else if (phase === 3) {
      setTeamAId("");
      setTeamBId(secondId);
    } else {
      setTeamAId("");
      setTeamBId("");
    }
  };

  const handleApply = () => {
    if (teamAId === "" && teamBId === "") {
      // APPLY with both dropdowns empty fades the team-list overlay out to
      // nothing (transparent) — NOT back to the scoreboard graphic. The overlay
      // stays live (barn doors open) but shows no content. The dropdowns stay
      // open (overlayMode remains "teams") so the operator can pick a new matchup.
      setAppliedTeamAId("");
      setAppliedTeamBId("");
      setCurrentTapCount(0);
      postScoreboardMode(tournamentId ?? null, "blank", null, null);
      return;
    }
    setAppliedTeamAId(teamAId);
    setAppliedTeamBId(teamBId);
    postScoreboardMode(
      tournamentId ?? null,
      "teams",
      teamAId || null,
      teamBId || null,
    );
    // When the overlay is stopped, APPLY also brings it LIVE with the barn-door
    // effect. Pause first so the overlay window picks up the team selection
    // before the doors open (mirrors the Control Panel Start/Rest go-live flow).
    if (!overlayOutputLive) {
      window.setTimeout(activateOverlay, OVERLAY_APPLY_PROPAGATION_MS);
    }
  };
  const previewBaseW = 1920;
  const previewBaseH = 1080;
  const previewFrameW = Math.max(1, Math.round(previewBaseW * previewScale));
  const previewFrameH = Math.max(1, Math.round(previewBaseH * previewScale));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  /**
   * Logical Y (in 1920×1080 canvas coordinates) that should sit at the visual
   * center of the preview card. The scoreboard graphic lives in the upper
   * portion of the canvas, so 420 centers it without forcing the user to
   * scroll. Bracket content spans the full canvas, so 540 (natural center)
   * is the right target for that scene.
   */
  const previewFocusY = previewScene === "scoreboard" ? 420 : 540;
  const { overlayOutputLive, toggleOverlayOutputLive, activateOverlay } =
    useOverlayOutputLiveControl();

  /**
   * Push the current preview scene (scoreboard ↔ bracket) into the iframe.
   * The iframe's overlay-client instance listens for
   * `{ kind: "matbeast-preview-scene", scene }` window messages and swaps
   * its own internal scene accordingly — this is independent of the output
   * window's scene, which is how the dashboard's preview can diverge from
   * what's on-air (same behavior as the 0.5.x capture-based preview).
   */
  useEffect(() => {
    const frame = previewIframeRef.current;
    const target = frame?.contentWindow;
    if (!target) return;
    try {
      target.postMessage(
        { kind: "matbeast-preview-scene", scene: previewScene },
        window.location.origin,
      );
    } catch {
      /* ignore — iframe not yet same-origin-ready; the onLoad handler will
         re-post once the document is mounted. */
    }
    /* End the "SWITCHING..." button lock once the scene has been pushed.
       Mirrors the old <img onLoad> debounce. */
    const t = window.setTimeout(() => setPreviewSceneSwitching(false), 150);
    return () => window.clearTimeout(t);
  }, [previewScene]);

  /**
   * Keep the overlay preview scrolled so the meaningful part of the scene
   * (scoreboard: y=420, bracket: y=540 in native 1920×1080 space) sits at the
   * visual center of the card. Reruns whenever the scene, scale, frame size,
   * or card size changes so the user never has to manually scroll.
   */
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const center = () => {
      const visibleH = el.clientHeight;
      const visibleW = el.clientWidth;
      if (visibleH <= 0 || visibleW <= 0) return;
      const targetY = previewFocusY * previewScale;
      const targetX = (previewBaseW / 2) * previewScale;
      const nextTop = Math.max(0, Math.min(previewFrameH - visibleH, targetY - visibleH / 2));
      const nextLeft = Math.max(0, Math.min(previewFrameW - visibleW, targetX - visibleW / 2));
      el.scrollTop = nextTop;
      el.scrollLeft = nextLeft;
    };
    center();
    const ro = new ResizeObserver(() => center());
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewScene, previewScale, previewFrameH, previewFrameW, previewFocusY]);

  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-col rounded-md border border-zinc-800/90 bg-[#161616] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-teal-950/40 bg-[#111] px-2 py-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-teal-100/90">
          Overlay
        </h2>
        <button
          type="button"
          onClick={toggleOverlayOutputLive}
          className={
            overlayOutputLive
              ? "rounded border border-red-700/60 bg-red-950/35 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400 hover:bg-red-900/40"
              : "rounded border border-zinc-600/60 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-700/50"
          }
        >
          {overlayOutputLive ? "OVERLAY LIVE" : "OVERLAY STOPPED"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (previewSceneSwitching) return;
            setPreviewSceneSwitching(true);
            setPreviewScene((s) => (s === "scoreboard" ? "bracket" : "scoreboard"));
            window.setTimeout(() => setPreviewSceneSwitching(false), 900);
          }}
          disabled={previewSceneSwitching}
          className="rounded border border-zinc-600/60 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-700/50"
          title="Switches the in-dashboard overlay preview only (scoreboard and bracket output windows stay separate)"
        >
          {previewSceneSwitching
            ? "SWITCHING..."
            : previewScene === "scoreboard"
              ? "SHOW BRACKET"
              : "SHOW SCOREBOARD"}
        </button>
        {/* SHOW TEAMS toggle + dropdowns only appear while the preview is on
            the scoreboard (hidden whenever the bracket preview is active, so
            the user can quickly swap scenes via SHOW BRACKET). */}
        {previewScene === "scoreboard" ? (
          <>
            <button
              type="button"
              onClick={handleShowTeamsToggle}
              className="rounded border border-zinc-600/60 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-700/50"
              title={
                overlayMode === "scoreboard"
                  ? "Reveal team-list controls. Output stays on scoreboard until APPLY."
                  : "Crossfade the output back to the scoreboard graphic."
              }
            >
              {overlayMode === "scoreboard" ? "SHOW TEAMS" : "SHOW SCOREBOARD"}
            </button>
            {overlayMode === "teams" ? (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px]">
                <OverlayTeamPicker
                  label="TEAM A"
                  value={teamAId}
                  onChange={handleTeamAChange}
                  teams={namedTeams}
                  excludeId={teamBId}
                />
                <OverlayTeamPicker
                  label="TEAM B"
                  value={teamBId}
                  onChange={handleTeamBChange}
                  teams={namedTeams}
                  excludeId={teamAId}
                />
                <button
                  type="button"
                  onClick={handleCurrent}
                  className="rounded border border-amber-600/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300 hover:bg-amber-900/40"
                  title="Fill the dropdowns from the match highlighted gold in Brackets. Tap to cycle: TEAM A → TEAM B → both → clear. APPLY to commit."
                >
                  CURRENT
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  className={
                    applyPending
                      ? "rounded border border-teal-500/70 bg-teal-900/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-200 hover:bg-teal-800/50"
                      : "rounded border border-zinc-600/60 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300 hover:bg-zinc-700/50"
                  }
                  title={
                    applyPending
                      ? "Commit the current team selection to the output overlay."
                      : "Commit the current team selection (or push the same selection) to the output overlay."
                  }
                >
                  APPLY
                </button>
                {/* Hint that the rendered team-list preview below is
                    interactive — clicking a player's name lights it up
                    with the breathing glow. Shown only while team-list
                    controls are visible so it doesn't clutter the header
                    in scoreboard / bracket modes where it wouldn't
                    apply. */}
                <span
                  className="text-[10px] italic text-zinc-400"
                  title="Click any player's name in the preview to toggle a yellow breathing highlight. Synced to the output window."
                >
                  Click name to highlight
                </span>
              </div>
            ) : null}
          </>
        ) : null}
        {/**
         * NDI status pill — v0.9.33+. Pushed right with `ml-auto` so it
         * sits in the trailing cluster alongside the preview-scale
         * slider regardless of how many scoreboard / bracket controls
         * are currently rendered to the left. The pill is the
         * authoritative on-screen indicator of which NIC NDI is bound
         * to (Wi-Fi / Ethernet / APIPA / virtual / not bound) so the
         * operator never has to interpret dotted-quad IPs. Click =
         * adapter picker; selecting an entry persists the choice and
         * prompts the operator to restart the app.
         */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ShowObsUrlButton />
          <NdiStatusPill />
        </div>
        {/* Preview-scale slider shrunk to ~half its previous footprint so
            the header has more breathing room for the SHOW TEAMS / APPLY
            / hint cluster. `min-w` guarantees the track is still wide
            enough to drag at low zoom; `basis` + `max-w` cap total width
            so this control never pushes the scoreboard cluster off the
            visible header on narrow window widths. */}
        <label className="flex min-w-[min(100%,6rem)] flex-1 basis-[5rem] items-center gap-2 sm:max-w-[10rem]">
          <span className="shrink-0 text-[10px] text-zinc-500">Preview scale</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={previewScale}
            onChange={(e) => setPreviewScale(Number(e.target.value))}
            className="h-1 min-w-0 flex-1 accent-teal-600"
            aria-valuemin={0.1}
            aria-valuemax={1}
            aria-valuenow={previewScale}
          />
          <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">
            {Math.round(previewScale * 100)}%
          </span>
        </label>
      </header>
      <div ref={scrollContainerRef} className="min-h-0 min-w-0 flex-1 overflow-auto p-2">
        <div
          className="relative mx-auto overflow-hidden shadow-lg"
          style={{
            width: previewFrameW,
            height: previewFrameH,
          }}
        >
          {/* Iframe-rendered preview: renders /overlay?preview=1 locally in the
              dashboard process. Its internal overlay component provides its
              own red barn-door effect, scoreboard / bracket / team-list
              crossfade, and BroadcastChannel live-state handling, so this
              parent only needs to forward scene toggles via postMessage.
              `key={tournamentId}` ensures a full remount when the active
              event switches (matches the previous capture reset behavior). */}
          {tournamentId ? (
            <iframe
              key={tournamentId}
              ref={previewIframeRef}
              src={`/overlay?preview=1&tournamentId=${encodeURIComponent(tournamentId)}`}
              title="Overlay preview"
              tabIndex={-1}
              width={previewFrameW}
              height={previewFrameH}
              onLoad={() => {
                /* Replay the current scene to the freshly-loaded iframe so it
                   doesn't briefly render the default scoreboard if the user
                   switched to bracket before first load. */
                const target = previewIframeRef.current?.contentWindow;
                if (!target) return;
                try {
                  target.postMessage(
                    { kind: "matbeast-preview-scene", scene: previewScene },
                    window.location.origin,
                  );
                } catch {
                  /* ignore */
                }
                setPreviewSceneSwitching(false);
              }}
              /**
               * Pointer events are intentionally ENABLED on the preview
               * iframe so clicks on interactive overlay elements (e.g.
               * team-list player names, which opt in via their own
               * `pointer-events: auto`) propagate into the iframe document.
               * All non-interactive overlay surfaces inside the iframe
               * keep `pointer-events: none`, so the iframe still feels
               * "read-only" for everything except the click-to-glow names.
               */
              className="relative z-10 block border-0 bg-transparent"
            />
          ) : (
            <div className="pointer-events-none relative z-10 flex h-full w-full items-center justify-center bg-zinc-700 text-[11px] text-zinc-200">
              Waiting for overlay preview...
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function DashboardFullWorkspace() {
  const { tournamentId, ready } = useEventWorkspace();
  const { data: board, isPending: boardPending } = useQuery({
    queryKey: matbeastKeys.board(tournamentId),
    queryFn: ({ signal }) =>
      matbeastJson<BoardPayload>("/api/board", {
        signal,
        headers: { [MATBEAST_TOURNAMENT_HEADER]: tournamentId! },
      }),
    enabled: ready && !!tournamentId,
  });

  const layoutStorageKey = useMemo(
    () => normalizeEventFileKey(board?.currentRosterFileName),
    [board?.currentRosterFileName],
  );

  const layoutStorage = useMemo(
    () => createEventFileLayoutStorage(layoutStorageKey),
    [layoutStorageKey],
  );

  const overlayStackLayout = useDefaultLayout({
    id: "matbeast-dashboard-overlay-stack",
    storage: layoutStorage,
    panelIds: ["overlay-stack-main", "overlay-stack-strip"],
  });

  if (ready && !tournamentId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[15px] font-medium text-zinc-500">
          Open or create new event
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {tournamentId && boardPending ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-zinc-500">
          Loading event…
        </div>
      ) : (
        <Group
          orientation="vertical"
          id="matbeast-dashboard-overlay-stack"
          className="min-h-0 flex-1"
          defaultLayout={overlayStackLayout.defaultLayout}
          onLayoutChanged={overlayStackLayout.onLayoutChanged}
        >
          <Panel
            id="overlay-stack-main"
            defaultSize="78%"
            minSize="35%"
            className="min-h-0 min-w-0 flex flex-col"
          >
            <DashboardResizablePanels
              key={`${layoutStorageKey ?? "untitled"}-${tournamentId ?? "none"}`}
              tournamentId={tournamentId}
              layoutStorageKey={layoutStorageKey}
            />
          </Panel>
          <Separator className="dashboard-resize-h" />
          <Panel
            id="overlay-stack-strip"
            defaultSize="22%"
            minSize="8%"
            maxSize="45%"
            className="flex min-h-0 min-w-0 flex-col"
          >
            <OverlayStrip />
          </Panel>
        </Group>
      )}
    </div>
  );
}
