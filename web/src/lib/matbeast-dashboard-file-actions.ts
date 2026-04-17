"use client";

import { matbeastDebugLog } from "@/lib/matbeast-debug-log";
import { getMatBeastTournamentId, matbeastFetch } from "@/lib/matbeast-fetch";
import {
  buildRosterDocumentFromTeamsApi,
  wrapMatBeastEventFile,
  type TeamsApiForExport,
} from "@/lib/roster-export-build";
import { parseMatBeastEventFileJson } from "@/lib/roster-file-parse";
import { normalizeEventFileKey } from "@/lib/event-file-key";
import { getEventDiskPath, setEventDiskPath } from "@/lib/matbeast-disk-path";
import { markTournamentClean, markTournamentDirty } from "@/lib/matbeast-document-dirty";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import type { QueryClient } from "@tanstack/react-query";
import { getAudioVolumePercent, setAudioVolumePercent } from "@/lib/audio-output";

/**
 * On-disk extension for exported event envelopes (payload is JSON).
 * `.mat` is avoided: Windows often associates it with Microsoft Access (same as MATLAB’s issue).
 */
export const EVENT_FILE_EXTENSION = ".matb" as const;
const EVENT_FILENAME_EXT_RE = /\.(json|mat|matb)$/i;

export type EventTab = { id: string; name: string };
type SaveStatusKind = "start" | "success" | "error";
type BracketApiForExport = {
  quarterFinals: Array<{
    bracketIndex: number;
    homeTeam: { seedOrder: number };
    awayTeam: { seedOrder: number };
    winnerTeam: { seedOrder: number } | null;
  }>;
  semiFinals: Array<{
    bracketIndex: number;
    homeTeam: { seedOrder: number };
    awayTeam: { seedOrder: number };
    winnerTeam: { seedOrder: number } | null;
  }>;
  grandFinal: {
    bracketIndex: number;
    homeTeam: { seedOrder: number };
    awayTeam: { seedOrder: number };
    winnerTeam: { seedOrder: number } | null;
  } | null;
};

function sanitizeFileName(name: string) {
  const s = name.replace(/[^\w\- .]+/g, "_").trim();
  return (s.length > 0 ? s : "event").slice(0, 80);
}

export function eventNameFromPath(filePath: string) {
  const base = filePath.split(/[/\\]/).pop() ?? "";
  const noExt = base.replace(EVENT_FILENAME_EXT_RE, "");
  return noExt.trim() || "Untitled event";
}

function downloadEventFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const name = EVENT_FILENAME_EXT_RE.test(filename) ? filename : `${filename}${EVENT_FILE_EXTENSION}`;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function rosterLabelToDefaultDiskFilename(rosterFileLabel: string) {
  return `${sanitizeFileName(rosterFileLabel)}${EVENT_FILE_EXTENSION}`;
}

function emitSaveStatus(
  kind: SaveStatusKind,
  tabId: string,
  opts?: { silent?: boolean; message?: string },
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("matbeast-save-status", {
      detail: {
        source: "save",
        kind,
        tabId,
        silent: Boolean(opts?.silent),
        message: opts?.message,
      },
    }),
  );
}

async function syncBoardFileName(
  queryClient: QueryClient,
  fileName: string,
  explicitTournamentId?: string | null,
) {
  const tid = explicitTournamentId ?? getMatBeastTournamentId();
  if (!tid) return;
  await matbeastFetch("/api/board", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-matbeast-tournament-id": tid,
      "x-matbeast-skip-undo": "1",
    },
    body: JSON.stringify({
      currentRosterFileName: fileName.trim() || "UNTITLED",
    }),
  });
  void queryClient.invalidateQueries({
    queryKey: matbeastKeys.board(tid),
  });
}

async function buildEnvelopeText(args: {
  /** Tab / UI event name (stored in JSON only; does not choose disk path). */
  eventTitle: string;
  /** Board `currentRosterFileName` — drives default filename, disk map key, and `eventFileKey` in JSON. */
  rosterFileName: string;
}) {
  const eventTitle = args.eventTitle.trim() || "Untitled event";
  const rf = args.rosterFileName.trim();
  const rosterFileLabel =
    !rf || rf.toUpperCase() === "UNTITLED" ? "UNTITLED" : rf;
  const resTeams = await matbeastFetch("/api/teams");
  if (!resTeams.ok) {
    throw new Error("Could not load teams for export");
  }
  const data = (await resTeams.json()) as TeamsApiForExport;
  const roster = buildRosterDocumentFromTeamsApi(data);
  let bracket:
    | {
        version: 1;
        matches: Array<{
          round: "QUARTER_FINAL" | "SEMI_FINAL" | "GRAND_FINAL";
          bracketIndex: number;
          homeSeedOrder: number;
          awaySeedOrder: number;
          winnerSeedOrder: number | null;
        }>;
      }
    | undefined;
  try {
    const resBracket = await matbeastFetch("/api/bracket");
    if (resBracket.ok) {
      const b = (await resBracket.json()) as BracketApiForExport;
      bracket = {
        version: 1,
        matches: [
          ...(b.quarterFinals ?? []).map((m) => ({
            round: "QUARTER_FINAL" as const,
            bracketIndex: m.bracketIndex,
            homeSeedOrder: m.homeTeam.seedOrder,
            awaySeedOrder: m.awayTeam.seedOrder,
            winnerSeedOrder: m.winnerTeam?.seedOrder ?? null,
          })),
          ...(b.semiFinals ?? []).map((m) => ({
            round: "SEMI_FINAL" as const,
            bracketIndex: m.bracketIndex,
            homeSeedOrder: m.homeTeam.seedOrder,
            awaySeedOrder: m.awayTeam.seedOrder,
            winnerSeedOrder: m.winnerTeam?.seedOrder ?? null,
          })),
          ...(b.grandFinal
            ? [
                {
                  round: "GRAND_FINAL" as const,
                  bracketIndex: b.grandFinal.bracketIndex,
                  homeSeedOrder: b.grandFinal.homeTeam.seedOrder,
                  awaySeedOrder: b.grandFinal.awayTeam.seedOrder,
                  winnerSeedOrder: b.grandFinal.winnerTeam?.seedOrder ?? null,
                },
              ]
            : []),
        ],
      };
    }
  } catch {
    // Keep save robust if bracket read fails.
  }
  const envelope = wrapMatBeastEventFile(
    eventTitle,
    roster,
    bracket,
    getAudioVolumePercent(),
    rosterFileLabel,
  );
  return {
    text: JSON.stringify(envelope, null, 2),
    defaultFile: rosterLabelToDefaultDiskFilename(rosterFileLabel),
    displayName: eventTitle,
  };
}

export async function matbeastSaveTabById(
  queryClient: QueryClient,
  selectTab: (id: string) => void,
  getOpenTabs: () => EventTab[],
  tabId: string,
  opts?: { silent?: boolean; allowPrompt?: boolean },
) {
  const silent = Boolean(opts?.silent);
  const allowPrompt = opts?.allowPrompt ?? true;
  emitSaveStatus("start", tabId, { silent });
  const currentTid = getMatBeastTournamentId();
  // Silent autosave runs on the active tab: avoid selectTab() so we do not run
  // invalidateAndBroadcast (invalidates all matbeast queries), which refetches
  // teams and can disrupt unsaved roster form state.
  if (!silent || currentTid !== tabId) {
    selectTab(tabId);
  }
  const tabMeta = getOpenTabs().find((t) => t.id === tabId);
  const eventTitle = (tabMeta?.name ?? "Untitled event").trim();

  const tid = getMatBeastTournamentId();
  if (!tid) {
    if (!silent) window.alert("Open or create an event before saving.");
    emitSaveStatus("error", tabId, { silent, message: "Save failed" });
    return false;
  }

  let rosterFileName = "UNTITLED";
  try {
    const boardRes = await matbeastFetch("/api/board");
    if (boardRes.ok) {
      const b = (await boardRes.json()) as { currentRosterFileName?: string };
      rosterFileName = b.currentRosterFileName?.trim() || "UNTITLED";
    }
  } catch {
    /* keep UNTITLED */
  }

  const { text, defaultFile } = await buildEnvelopeText({
    eventTitle,
    rosterFileName,
  });
  const diskKey = normalizeEventFileKey(rosterFileName) ?? tid;
  const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
  if (desk?.showSaveEventDialog && desk?.writeTextFile) {
    let diskPath = getEventDiskPath(diskKey, tid);
    if (!diskPath) {
      const def = desk.getDefaultEventSavePath
        ? await desk.getDefaultEventSavePath({ defaultName: defaultFile })
        : null;
      if (def?.ok && def.filePath) {
        diskPath = def.filePath;
        setEventDiskPath(diskKey, diskPath);
      } else if (!allowPrompt) {
        emitSaveStatus("error", tabId, { silent, message: "Save failed" });
        return false;
      } else {
        const pick = await desk.showSaveEventDialog({ defaultName: defaultFile });
        if (!pick.ok || !pick.filePath) {
          emitSaveStatus("error", tabId, { silent, message: "Save cancelled" });
          return false;
        }
        diskPath = pick.filePath;
        setEventDiskPath(diskKey, diskPath);
      }
    }
    const w = await desk.writeTextFile(diskPath, text);
    if (!w.ok && !silent) window.alert(w.error ?? "Could not write file");
    if (w.ok) {
      await syncBoardFileName(queryClient, eventNameFromPath(diskPath));
      markTournamentClean(tabId);
      emitSaveStatus("success", tabId, { silent, message: "File saved" });
      return true;
    }
    emitSaveStatus("error", tabId, {
      silent,
      message: !silent ? "Save failed" : "Autosave failed",
    });
    return false;
  } else {
    if (!allowPrompt) {
      emitSaveStatus("error", tabId, { silent, message: "Save failed" });
      return false;
    }
    downloadEventFile(defaultFile, text);
    await syncBoardFileName(queryClient, defaultFile.replace(EVENT_FILENAME_EXT_RE, ""));
    markTournamentClean(tabId);
    emitSaveStatus("success", tabId, { silent, message: "File saved" });
    return true;
  }
}

/** Creates a new server tournament and opens it as a new tab (desktop + web). */
export async function matbeastCreateNewEventTab(opts: {
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string) => void;
  refreshTournaments: () => Promise<void>;
}) {
  const { queryClient, openEventInTab, refreshTournaments } = opts;
  const name = "Untitled event";
  const res = await fetch("/api/tournaments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const j = (await res.json()) as { id?: string; name?: string; error?: string };
  if (!res.ok || !j.id) {
    window.alert(j.error ?? "Could not create event");
    return;
  }
  const label = (j.name ?? name).trim() || name;
  matbeastDebugLog("file:new-tab", "created tournament", j.id, label);
  openEventInTab(j.id, label);
  setAudioVolumePercent(100);
  await matbeastFetch("/api/board", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-matbeast-tournament-id": j.id,
      "x-matbeast-skip-undo": "1",
    },
    body: JSON.stringify({ currentRosterFileName: "UNTITLED" }),
  });
  matbeastDebugLog("file:new-tab", "refreshTournaments + invalidate");
  await refreshTournaments();
  void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
  window.dispatchEvent(
    new CustomEvent("matbeast-tournament-changed", { detail: { id: j.id } }),
  );
}

/** Imports JSON from disk into a new tournament tab. */
export async function matbeastImportOpenedEventFile(opts: {
  filePath: string;
  text: string;
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string) => void;
  refreshTournaments: () => Promise<void>;
}) {
  const { filePath, text, queryClient, openEventInTab, refreshTournaments } = opts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    window.alert("Could not parse JSON file.");
    return;
  }
  const fallbackName =
    filePath.split(/[/\\]/).pop()?.replace(EVENT_FILENAME_EXT_RE, "") ?? "Imported event";
  const { eventName, document, bracket, audioVolumePercent } = parseMatBeastEventFileJson(
    parsed,
    fallbackName,
  );
  const res = await fetch("/api/tournaments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: eventName }),
  });
  const j = (await res.json()) as { id?: string; name?: string; error?: string };
  if (!res.ok || !j.id) {
    window.alert(j.error ?? "Could not create event from file");
    return;
  }
  matbeastDebugLog("file:import", "open tab", j.id, j.name ?? eventName, {
    filePath,
  });
  openEventInTab(j.id, j.name ?? eventName);
  const fileKey = normalizeEventFileKey(eventName) ?? j.id;
  /**
   * `x-matbeast-skip-undo: "1"` is critical here.
   *
   * Without it, this POST would hit `shouldCaptureUndo === true` and fire
   * `markTournamentDirty(j.id)` the moment the response lands. That in turn
   * wakes the autosave subscriber in `AppChrome` which calls
   * `matbeastSaveTabById(...)` in parallel with the rest of this open flow —
   * _before_ `syncBoardFileName` (a few lines below) has had a chance to
   * write the real filename onto the board. The parallel autosave then:
   *   1. reads `board.currentRosterFileName` as "UNTITLED" (the default for
   *      a just-created tournament);
   *   2. writes a stray `Documents/UNTITLED.matb` file via the
   *      `getDefaultEventSavePath` fallback;
   *   3. races with the correct `syncBoardFileName(... displayFile ...)`
   *      PATCH below, often landing _after_ it and stomping the header back
   *      to "UNTITLED".
   *
   * The user-visible symptoms were: header shows "UNTITLED" after opening
   * a valid event file, and Save-As defaults to "UNTITLED" even though the
   * tab label is correct. Skipping undo capture here keeps the tournament
   * clean until the explicit `markTournamentDirty(j.id)` at the end of this
   * function, which runs _after_ `syncBoardFileName` and so triggers an
   * autosave against the correct filename.
   */
  const imp = await matbeastFetch("/api/tournament/import-roster", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-matbeast-skip-undo": "1",
    },
    body: JSON.stringify({ document, bracket }),
  });
  if (!imp.ok) {
    const ij = (await imp.json()) as { error?: string };
    window.alert(ij.error ?? "Could not import roster from file");
    return;
  }
  if (typeof audioVolumePercent === "number") {
    setAudioVolumePercent(audioVolumePercent);
  }
  setEventDiskPath(fileKey, filePath);
  const displayFile = eventNameFromPath(filePath);
  await syncBoardFileName(queryClient, displayFile, j.id);
  matbeastDebugLog("file:import", "syncBoardFileName", displayFile);
  await queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
  await refreshTournaments();
  /** Imported in-memory state is not yet written to disk from this session. */
  markTournamentDirty(j.id);
  matbeastDebugLog("file:import", "done");
}

export async function matbeastSaveActiveTab(opts: {
  queryClient: QueryClient;
  selectTab: (id: string) => void;
  getOpenTabs: () => EventTab[];
}) {
  const tid = getMatBeastTournamentId();
  if (!tid) {
    window.alert("Open or create an event before saving.");
    return;
  }
  try {
    await matbeastSaveTabById(opts.queryClient, opts.selectTab, opts.getOpenTabs, tid);
  } catch (e) {
    window.alert(e instanceof Error ? e.message : "Save failed");
  }
}

export async function matbeastSaveActiveTabAs(opts: {
  queryClient: QueryClient;
  selectTab: (id: string) => void;
  getOpenTabs: () => EventTab[];
}) {
  const tid = getMatBeastTournamentId();
  if (!tid) {
    window.alert("Open or create an event before saving.");
    return;
  }
  try {
    opts.selectTab(tid);
    const tabMeta = opts.getOpenTabs().find((t) => t.id === tid);
    const eventTitle = (tabMeta?.name ?? "Untitled event").trim();
    let rosterFileName = "UNTITLED";
    try {
      const boardRes = await matbeastFetch("/api/board");
      if (boardRes.ok) {
        const b = (await boardRes.json()) as { currentRosterFileName?: string };
        rosterFileName = b.currentRosterFileName?.trim() || "UNTITLED";
      }
    } catch {
      /* keep UNTITLED */
    }
    const { text, defaultFile } = await buildEnvelopeText({
      eventTitle,
      rosterFileName,
    });
    const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (desk?.showSaveEventDialog && desk?.writeTextFile) {
      const pick = await desk.showSaveEventDialog({ defaultName: defaultFile });
      if (!pick.ok || !pick.filePath) return;
      const pickedName = eventNameFromPath(pick.filePath);
      const pickedKey = normalizeEventFileKey(pickedName) ?? tid;
      setEventDiskPath(pickedKey, pick.filePath);
      const w = await desk.writeTextFile(pick.filePath, text);
      if (!w.ok) window.alert(w.error ?? "Could not write file");
      if (w.ok) {
        await syncBoardFileName(opts.queryClient, pickedName);
        markTournamentClean(tid);
      }
    } else {
      downloadEventFile(defaultFile, text);
      await syncBoardFileName(
        opts.queryClient,
        defaultFile.replace(EVENT_FILENAME_EXT_RE, ""),
      );
      markTournamentClean(tid);
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : "Save failed");
  }
}

/** Open file dialog (desktop) or request the in-app picker (web). */
export async function matbeastOpenEventOrShowPicker(opts: {
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string) => void;
  refreshTournaments: () => Promise<void>;
}) {
  const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
  if (desk?.showOpenEventDialog) {
    const r = await desk.showOpenEventDialog();
    if (!r.ok) {
      if (r.error) window.alert(r.error);
      return;
    }
    await matbeastImportOpenedEventFile({
      filePath: r.filePath,
      text: r.text,
      queryClient: opts.queryClient,
      openEventInTab: opts.openEventInTab,
      refreshTournaments: opts.refreshTournaments,
    });
    return;
  }
  window.dispatchEvent(new CustomEvent("matbeast-open-picker-request"));
}
