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
import {
  findTournamentIdForFilePath,
  registerOpenEventFilePath,
} from "@/lib/matbeast-open-file-registry";
import { getEventDiskPath, setEventDiskPath } from "@/lib/matbeast-disk-path";
import { markTournamentClean, markTournamentDirty } from "@/lib/matbeast-document-dirty";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import type { QueryClient } from "@tanstack/react-query";
import { getAudioVolumePercent, setAudioVolumePercent } from "@/lib/audio-output";
import {
  markCloudReachable,
  markCloudUnreachable,
  probeCloud,
} from "@/lib/matbeast-cloud-online";
import { isMatbeastDemo } from "@/lib/matbeast-variant-client";

/**
 * On-disk extension for exported event envelopes (payload is JSON).
 * `.mat` is avoided: Windows often associates it with Microsoft Access (same as MATLAB’s issue).
 */
export const EVENT_FILE_EXTENSION = ".matb" as const;
const EVENT_FILENAME_EXT_RE = /\.(json|mat|matb)$/i;

export type EventTab = { id: string; name: string };

/**
 * If this cloud catalog id is already linked to a tournament that is open in
 * a tab, focus that tab and return true. No alerts — used before pull/import.
 */
export async function tryFocusExistingTabForCloudEvent(opts: {
  cloudEventId: string;
  openTabs: Array<{ id: string }>;
  selectTab: (id: string) => void;
  setShowHome?: (show: boolean) => void;
}): Promise<boolean> {
  const { cloudEventId, openTabs, selectTab, setShowHome } = opts;
  const trimmed = cloudEventId.trim();
  if (!trimmed || openTabs.length === 0) return false;
  try {
    const r = await fetch(
      `/api/cloud/events/linked-local?cloudEventId=${encodeURIComponent(trimmed)}`,
      { cache: "no-store" },
    );
    if (!r.ok) return false;
    const j = (await r.json()) as { tournamentId?: string | null };
    const tid = j.tournamentId?.trim();
    if (!tid || !openTabs.some((t) => t.id === tid)) return false;
    selectTab(tid);
    setShowHome?.(false);
    matbeastDebugLog(
      "file:import",
      "reuse open tab (cloud link)",
      tid,
      trimmed,
    );
    return true;
  } catch {
    return false;
  }
}

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

type OpenEventPick =
  | { ok: true; filePath: string; text: string }
  | { ok: false; canceled?: boolean; error?: string };

/**
 * Reads an event envelope from disk. Uses the native Electron open dialog when
 * `showOpenEventDialog` is available; otherwise falls back to a hidden file
 * input so File ▸ Restore / Open still works if the preload API is missing or
 * not exposed as a function (seen in some packaged builds).
 */
async function pickOpenedEventFileContents(): Promise<OpenEventPick> {
  const desk =
    typeof window !== "undefined" ? window.matBeastDesktop : undefined;
  if (typeof desk?.showOpenEventDialog === "function") {
    return desk.showOpenEventDialog();
  }
  if (typeof window === "undefined") {
    return { ok: false, error: "Not in a browser context." };
  }
  return pickOpenedEventFileViaHiddenInput();
}

function pickOpenedEventFileViaHiddenInput(): Promise<OpenEventPick> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".matb,.json,.mat,application/json";
    let settled = false;
    const finish = (r: OpenEventPick) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(r);
    };

    const onWindowFocus = () => {
      window.removeEventListener("focus", onWindowFocus);
      window.setTimeout(() => {
        if (settled) return;
        if (!input.files?.length) {
          finish({ ok: false, canceled: true });
        }
      }, 450);
    };
    window.addEventListener("focus", onWindowFocus);

    input.addEventListener("change", () => {
      window.removeEventListener("focus", onWindowFocus);
      const file = input.files?.[0];
      if (!file) {
        finish({ ok: false, canceled: true });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        finish({ ok: true, filePath: file.name, text });
      };
      reader.onerror = () => {
        finish({ ok: false, error: "Could not read file" });
      };
      reader.readAsText(file);
    });

    document.body.appendChild(input);
    input.click();
  });
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

export async function buildEnvelopeText(args: {
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
  let trainingMode = false;
  try {
    const boardRes = await matbeastFetch("/api/board");
    if (boardRes.ok) {
      const b = (await boardRes.json()) as { trainingMode?: boolean };
      trainingMode = Boolean(b.trainingMode);
    }
  } catch {
    /* ignore */
  }
  const envelope = wrapMatBeastEventFile(
    eventTitle,
    roster,
    bracket,
    getAudioVolumePercent(),
    rosterFileLabel,
    trainingMode,
  );
  return {
    text: JSON.stringify(envelope, null, 2),
    defaultFile: rosterLabelToDefaultDiskFilename(rosterFileLabel),
    displayName: eventTitle,
  };
}

/**
 * Builds an envelope for the currently-active tournament (whatever
 * `getMatBeastTournamentId()` returns). Used by cloud upload / force-push
 * dialogs where we don't want to round-trip through the save pipeline.
 *
 * NOTE: Requires matbeastFetch's tournament context to match `tabId`.
 * The cloud dialogs only act on the active tab, so this is safe.
 */
export async function buildEnvelopeTextForActiveTab(
  tabName: string,
): Promise<string> {
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
  const { text } = await buildEnvelopeText({
    eventTitle: tabName.trim() || "Untitled event",
    rosterFileName,
  });
  return text;
}

/**
 * Has the user already been warned that cloud sync is unavailable
 * in this session? We surface a single non-modal notice per app run
 * instead of popping an alert for every autosave — getting one
 * every two seconds while typing made the previous behaviour
 * actively hostile.
 */
let cloudNotConfiguredWarnedThisSession = false;

export async function matbeastSaveTabById(
  queryClient: QueryClient,
  selectTab: (id: string) => void,
  getOpenTabs: () => EventTab[],
  tabId: string,
  opts?: { silent?: boolean; allowPrompt?: boolean },
) {
  void allowPrompt_deprecated(opts?.allowPrompt);
  const silent = Boolean(opts?.silent);
  emitSaveStatus("start", tabId, { silent });

  const currentTid = getMatBeastTournamentId();
  // Silent autosave runs on the active tab: avoid selectTab() so we do
  // not run invalidateAndBroadcast (invalidates all matbeast queries),
  // which would refetch teams and disrupt unsaved roster form state.
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

  /**
   * Demo variant: skip the entire cloud pipeline. The user's edits
   * were already persisted to the local SQLite by the individual
   * mutation routes; "save" is a no-op beyond flipping the dirty
   * flag and letting the UI emit a success state. Running the cloud
   * pipeline in demo would issue `/api/cloud/events/push` calls
   * that always fail ("cloud not configured") and leave the status
   * badge stuck on "save failed".
   */
  if (isMatbeastDemo()) {
    markTournamentClean(tabId);
    emitSaveStatus("success", tabId, {
      silent,
      message: silent ? "" : "Saved",
    });
    return true;
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

  const { text } = await buildEnvelopeText({
    eventTitle,
    rosterFileName,
  });

  /**
   * Cloud-only save pipeline (v0.8.9+):
   *
   * The disk mirror was removed because it was causing more
   * problems than it solved:
   *   - On machines where `app.getPath("documents")` returned ""
   *     (OneDrive-redirected Documents, broken known-folder
   *     registry keys, etc.) autosave kept firing "Refusing to
   *     save to a relative path: 0417-1.matb" popups on every
   *     edit.
   *   - When the disk write failed, the user blamed the
   *     cloud sync even when the cloud push had actually
   *     succeeded.
   *   - "Backup copy to disk" is now an explicit File menu
   *     action, so writing to disk on every autosave is
   *     duplicative.
   *
   * The new flow:
   *   1. Look up whether this tab has a `CloudEventLink`.
   *   2. Linked → push to `/api/cloud/events/push`.
   *   3. Not linked, cloud configured → auto-upload via
   *      `/api/cloud/events/upload` under the current filename.
   *      The upload route creates the `CloudEventLink`, flipping
   *      the LOCAL_ONLY badge to SYNCED.
   *   4. Not linked, cloud not configured → warn once per
   *      session, mark the tab clean so the dirty-dot stops
   *      hounding the user, and return success. The user's
   *      recourse is File ▸ Backup copy to disk.
   */
  const linkedToCloud = await isTournamentLinkedToCloud(tid);
  const cloudConfigured = linkedToCloud
    ? true // no need to reprobe if we already have a link
    : await isCloudConfigured();

  let cloudOk = false;
  let cloudErrorMessage: string | null = null;

  if (linkedToCloud) {
    cloudOk = await pushToCloudSync(tabId, text);
    if (!cloudOk) cloudErrorMessage = "Cloud push failed";
  } else if (cloudConfigured) {
    // Auto-link: treat the first autosave of a LOCAL-ONLY event as
    // an implicit "File ▸ Upload to Cloud" so the user doesn't have
    // to hunt for a menu just to turn sync on. The name written to
    // the cloud is whatever the board currently says
    // (`currentRosterFileName`), falling back to an MMDD-N default
    // if the roster name is still "UNTITLED".
    const cloudName = await chooseAutoLinkCloudName(rosterFileName);
    cloudOk = await uploadEnvelopeAsNewCloudEvent(tabId, text, cloudName);
    if (!cloudOk) cloudErrorMessage = "Cloud upload failed";
  } else {
    // Cloud not configured. Notify once, clean up, succeed so the
    // "Saving..." indicator doesn't lie and autosave stops
    // re-firing "Autosave failed" on every keystroke.
    if (!cloudNotConfiguredWarnedThisSession && !silent) {
      cloudNotConfiguredWarnedThisSession = true;
      window.setTimeout(() => {
        window.alert(
          "Cloud sync is not configured on this machine, so changes are only " +
            "held in memory. Use File ▸ Backup copy to disk to export a .matb " +
            "file, or configure cloud sync under Options ▸ CLOUD SYNC…",
        );
      }, 0);
    }
    markTournamentClean(tabId);
    emitSaveStatus("success", tabId, {
      silent,
      message: silent ? "" : "No cloud configured",
    });
    return true;
  }

  if (cloudOk) {
    markTournamentClean(tabId);
    window.dispatchEvent(
      new CustomEvent("matbeast-cloud-sync-changed", {
        detail: { tournamentId: tabId },
      }),
    );
    emitSaveStatus("success", tabId, {
      silent,
      message: silent ? "Saved" : "Saved to cloud",
    });
    return true;
  }

  // Cloud path failed. Do NOT mark clean — badge stays NOT_SYNCED
  // so the operator knows edits are in flight locally. Silent
  // autosave just logs; an explicit save surfaces an alert.
  if (!silent && cloudErrorMessage) {
    window.setTimeout(() => {
      window.alert(
        `${cloudErrorMessage}. Your changes are preserved locally and will ` +
          `be retried on the next save.`,
      );
    }, 0);
  }
  emitSaveStatus("error", tabId, {
    silent,
    message: silent ? "Cloud sync pending" : (cloudErrorMessage ?? "Save failed"),
  });
  return false;
}

/** Deprecated shim: `allowPrompt` is obsolete under cloud-only saves. */
function allowPrompt_deprecated(_allowPrompt: boolean | undefined) {
  // intentionally empty
}

async function isTournamentLinkedToCloud(tournamentId: string): Promise<boolean> {
  try {
    const r = await fetch(
      `/api/cloud/events/status?tournamentId=${encodeURIComponent(tournamentId)}`,
      { cache: "no-store" },
    );
    if (!r.ok) return false;
    const j = (await r.json()) as { link?: { cloudEventId?: string } | null };
    return Boolean(j?.link?.cloudEventId);
  } catch {
    return false;
  }
}

async function isCloudConfigured(): Promise<boolean> {
  try {
    const r = await fetch("/api/cloud/config", { cache: "no-store" });
    if (!r.ok) return false;
    const j = (await r.json()) as { configured?: boolean };
    return Boolean(j.configured);
  } catch {
    return false;
  }
}

/**
 * Pick the cloud filename for an auto-link (the first cloud upload
 * of a previously local-only event). Falls back to the next free
 * `MMDD-N` when the board still holds the placeholder "UNTITLED",
 * so the homepage catalog never shows an event literally called
 * "UNTITLED".
 */
async function chooseAutoLinkCloudName(rosterFileName: string): Promise<string> {
  const trimmed = rosterFileName.trim();
  if (trimmed && trimmed.toUpperCase() !== "UNTITLED") return trimmed;
  try {
    const listRes = await fetch("/api/cloud/events", { cache: "no-store" });
    if (listRes.ok) {
      const list = (await listRes.json()) as { events?: Array<{ name: string }> };
      return pickNextDatedFilename((list.events ?? []).map((e) => e.name ?? ""));
    }
  } catch {
    /* fall through to date-only name */
  }
  return pickNextDatedFilename([]);
}

/**
 * Call `/api/cloud/events/upload` and, on success, PATCH the board
 * so `currentRosterFileName` matches the cloud filename. Triggers
 * a `matbeast-cloud-sync-changed` event so the badge refreshes
 * immediately.
 */
async function uploadEnvelopeAsNewCloudEvent(
  tournamentId: string,
  envelope: string,
  cloudName: string,
): Promise<boolean> {
  try {
    const upRes = await fetch("/api/cloud/events/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournamentId, envelope, name: cloudName }),
    });

    // 409 — a cloud event with this filename already exists. This
    // usually means the install was wiped or migrated but the cloud
    // event still lives on. Adopt it: bind the local tournament to
    // the existing cloud event and force-push the current bytes so
    // the user's in-flight edits land immediately. Without this
    // branch the save loop would 409 on every autosave forever and
    // the user's edits would never reach the cloud.
    if (upRes.status === 409) {
      const raw = await upRes.text().catch(() => "");
      let parsed: { conflictingId?: string; error?: string } = {};
      try {
        parsed = raw ? (JSON.parse(raw) as typeof parsed) : {};
      } catch {
        parsed = {};
      }
      const conflictingId = parsed.conflictingId?.trim();
      if (conflictingId) {
        matbeastDebugLog(
          "save:auto-link",
          "duplicate filename — adopting existing cloud event",
          conflictingId,
          cloudName,
        );
        const adoptRes = await fetch("/api/cloud/events/adopt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tournamentId,
            cloudEventId: conflictingId,
            envelope,
          }),
        });
        if (adoptRes.ok) {
          markCloudReachable();
          await matbeastFetch("/api/board", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-matbeast-tournament-id": tournamentId,
              "x-matbeast-skip-undo": "1",
            },
            body: JSON.stringify({ currentRosterFileName: cloudName }),
          });
          matbeastDebugLog(
            "save:auto-link",
            "adopted existing cloud event (silent)",
            conflictingId,
            cloudName,
          );
          return true;
        }
        const adoptBody = await adoptRes.text().catch(() => "");
        let adoptParsed: { error?: string; stage?: string } = {};
        try {
          adoptParsed = adoptBody
            ? (JSON.parse(adoptBody) as typeof adoptParsed)
            : {};
        } catch {
          adoptParsed = {};
        }
        matbeastDebugLog(
          "save:auto-link",
          "adopt failed",
          adoptRes.status,
          adoptParsed.stage ?? "?",
          adoptBody.slice(0, 200),
        );
        const detail =
          adoptParsed.error?.trim() ||
          adoptBody.trim().slice(0, 160) ||
          "no body";
        markCloudUnreachable(
          `Adopt-existing failed: HTTP ${adoptRes.status}${
            adoptParsed.stage ? ` @${adoptParsed.stage}` : ""
          } — ${detail.slice(0, 180)}`,
        );
        return false;
      }
      markCloudUnreachable(
        `Auto-link upload failed: HTTP 409 — ${
          parsed.error ?? (raw.slice(0, 160) || "duplicate filename")
        }`,
      );
      return false;
    }

    if (!upRes.ok) {
      const body = await upRes.text().catch(() => "");
      matbeastDebugLog(
        "save:auto-link",
        "cloud upload failed",
        upRes.status,
        body.slice(0, 200),
      );
      markCloudUnreachable(
        `Auto-link upload failed: HTTP ${upRes.status}${
          body.trim() ? ` — ${body.trim().slice(0, 180)}` : ""
        }`,
      );
      return false;
    }
    markCloudReachable();
    await matbeastFetch("/api/board", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-matbeast-tournament-id": tournamentId,
        "x-matbeast-skip-undo": "1",
      },
      body: JSON.stringify({ currentRosterFileName: cloudName }),
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    matbeastDebugLog("save:auto-link", "cloud upload threw", msg);
    markCloudUnreachable(`Auto-link upload error: ${msg.slice(0, 180)}`);
    return false;
  }
}

/**
 * Cloud push helper. Called after every successful save-to-disk. The
 * server decides whether to actually hit the cloud (only linked
 * tournaments) so the renderer doesn't need any cloud state of its own.
 *
 * Fires a `matbeast-cloud-sync-changed` event so the header badge can
 * refresh immediately rather than waiting for the next poll.
 */
/**
 * Synchronous cloud push. Returns `true` only when the masters service
 * accepted the envelope. Used by `matbeastSaveTabById` when the tab
 * is known to be cloud-linked, so a local write failure cannot silently
 * prevent the cloud copy from updating. On conflict (409), emits the
 * same `matbeast-cloud-conflict` event as `pushToCloudAfterSave` and
 * returns `false` so the caller treats this cycle as a failure.
 */
async function pushToCloudSync(
  tournamentId: string,
  envelope: string,
): Promise<boolean> {
  try {
    const r = await fetch("/api/cloud/events/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournamentId, envelope }),
    });
    if (r.status === 409) {
      const data = (await r.json().catch(() => ({}))) as {
        localVersion?: number;
        cloudVersion?: number;
      };
      window.dispatchEvent(
        new CustomEvent("matbeast-cloud-conflict", {
          detail: {
            tournamentId,
            localVersion: data.localVersion,
            cloudVersion: data.cloudVersion,
          },
        }),
      );
      // 409 is a legitimate server response (not a network failure),
      // so count the cloud as reachable even though this push
      // didn't land.
      markCloudReachable();
      return false;
    }
    if (r.ok) {
      markCloudReachable();
      return true;
    }
    // Non-2xx, non-409 → treat as unreachable (502 from the desktop
    // proxy when the masters host is down, 504 timeout, etc.).
    const body = await r.text().catch(() => "");
    markCloudUnreachable(
      `Cloud push failed: HTTP ${r.status}${
        body.trim() ? ` — ${body.trim().slice(0, 180)}` : ""
      }`,
    );
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markCloudUnreachable(`Cloud push error: ${msg.slice(0, 180)}`);
    return false;
  }
}

async function pushToCloudAfterSave(
  tournamentId: string,
  envelope: string,
): Promise<void> {
  try {
    const r = await fetch("/api/cloud/events/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournamentId, envelope }),
    });
    // 409 = conflict. Surface a one-time prompt via custom event; the
    // CloudSyncBadge listens and opens the conflict dialog. We don't
    // alert() here because silent autosaves shouldn't interrupt the user.
    if (r.status === 409) {
      const data = (await r.json().catch(() => ({}))) as {
        localVersion?: number;
        cloudVersion?: number;
      };
      window.dispatchEvent(
        new CustomEvent("matbeast-cloud-conflict", {
          detail: {
            tournamentId,
            localVersion: data.localVersion,
            cloudVersion: data.cloudVersion,
          },
        }),
      );
    }
  } catch {
    /* offline or ipc error; badge will reflect NOT_SYNCED on next poll */
  } finally {
    window.dispatchEvent(
      new CustomEvent("matbeast-cloud-sync-changed", {
        detail: { tournamentId },
      }),
    );
  }
}

/**
 * Format today's date as MMDD so new filenames are naturally sortable
 * by creation day. Uses the user's local clock (matches how they talk
 * about "today's" events).
 */
export function formatTodayMMDD(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${mm}${dd}`;
}

/**
 * Pick the next free date-sequenced filename for a brand-new event.
 *
 * Shape: `MMDD-N`, where MMDD is today's month+day (local) and N is
 * the first positive integer not already used among today's existing
 * filenames. So the first event created today is `0417-1`, the second
 * is `0417-2`, and so on. Holes are filled (deleting `0417-2` while
 * `0417-1` and `0417-3` exist yields `0417-2` next) so the sequence
 * stays tight.
 *
 * Any filename whose prefix doesn't match today's MMDD is ignored —
 * yesterday's `0416-5` has no influence on today's numbering.
 */
export function pickNextDatedFilename(
  existingNames: string[],
  now: Date = new Date(),
): string {
  const prefix = formatTodayMMDD(now);
  const used = new Set<number>();
  const re = /^(\d{4})-(\d+)$/;
  for (const raw of existingNames) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    if (m[1] !== prefix) continue;
    const n = parseInt(m[2]!, 10);
    if (Number.isFinite(n) && n > 0) used.add(n);
  }
  for (let i = 1; i < 10_000; i += 1) {
    if (!used.has(i)) return `${prefix}-${i}`;
  }
  return `${prefix}-${Date.now()}`;
}

/**
 * Back-compat export — older call sites still import the v0.8.2 name.
 * Forwards to the new date-sequenced picker so behavior changes
 * everywhere in one place.
 */
export function pickNextUntitledName(existingNames: string[]): string {
  return pickNextDatedFilename(existingNames);
}

/**
 * Best-effort attempt to mirror the freshly-created local tournament to
 * the cloud as an "UNTITLED"/"UNTITLED(N)" event. Falls back silently to
 * local-only when cloud isn't configured or the network is down — the
 * user can always upload manually later via File ▸ Upload Current to Cloud.
 *
 * Returns the chosen cloud name (so the caller can rename the tab to
 * match) when the upload succeeds; null otherwise.
 */
/**
 * Result shape for the cloud-upload leg of the "new event" flow.
 * `duplicate` is distinct from generic `error` so the renderer can
 * show a targeted "that filename is taken" message instead of the
 * silent no-op we used to do for all failure modes.
 */
type CreateCloudUntitledResult =
  | { status: "ok"; name: string }
  | { status: "duplicate" }
  | { status: "not-configured" }
  | { status: "error" };

async function createCloudUntitledForNewTab(
  tournamentId: string,
  preferredName?: string,
  opts?: {
    trainingMode?: boolean;
    /**
     * Display title (tab label) for the freshly-created tournament.
     *
     * v0.9.36 bug fix: this used to be omitted, and the cloud blob's
     * envelope was built with `cloudName` (the FILENAME, e.g.
     * `0428-1`) standing in for the display title — so
     * `wrapMatBeastEventFile` wrote the FILENAME into the envelope's
     * `eventName` field. On a later close + reopen-from-cloud, the
     * parser saw `eventName: "0428-1"` and created a new local
     * tournament whose display name was the filename instead of
     * whatever the user typed in the New Event dialog. Symptom: the
     * event name "occasionally" mutates into the filename across
     * app restarts, but only for events that were never autosaved
     * after creation (any subsequent autosave rebuilds the envelope
     * using `tabMeta?.name` and silently heals the cloud blob).
     *
     * Optional so older callers that don't have a display title
     * handy fall back to the filename — same as the old behaviour,
     * which is still wrong for those callers but was wrong before
     * v0.9.36 too. There are currently no such callers; the only
     * caller is `matbeastCreateNewEventTab`, and it always knows
     * the title.
     */
    displayName?: string;
  },
): Promise<CreateCloudUntitledResult> {
  try {
    const cfgRes = await fetch("/api/cloud/config", { cache: "no-store" });
    if (!cfgRes.ok) {
      matbeastDebugLog(
        "file:new-tab",
        "cloud upload skipped (config fetch failed)",
        cfgRes.status,
      );
      return { status: "error" };
    }
    const cfg = (await cfgRes.json()) as { configured?: boolean };
    if (!cfg.configured) {
      matbeastDebugLog(
        "file:new-tab",
        "cloud upload skipped (not configured)",
      );
      return { status: "not-configured" };
    }

    let cloudName: string;
    if (preferredName && preferredName.trim()) {
      cloudName = preferredName.trim();
    } else {
      const listRes = await fetch("/api/cloud/events", { cache: "no-store" });
      if (!listRes.ok) {
        matbeastDebugLog(
          "file:new-tab",
          "cloud upload skipped (list fetch failed)",
          listRes.status,
        );
        return { status: "error" };
      }
      const list = (await listRes.json()) as {
        events?: Array<{ name: string }>;
      };
      cloudName = pickNextDatedFilename(
        (list.events ?? []).map((e) => e.name ?? ""),
      );
    }

    /**
     * Use the display title for the envelope's `eventName` field, NOT
     * the cloud filename. When the caller doesn't pass a display title
     * we fall back to the filename to preserve the legacy shape — but
     * the only caller is `matbeastCreateNewEventTab`, which always
     * passes one (the same string the New Event dialog typed into the
     * `name` column of the SQLite tournament row).
     */
    const envelopeDisplayName = opts?.displayName?.trim() || cloudName;
    const envelope = await buildEnvelopeTextForActiveTab(envelopeDisplayName);
    const upRes = await fetch("/api/cloud/events/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tournamentId,
        envelope,
        name: cloudName,
        trainingMode: Boolean(opts?.trainingMode),
      }),
    });
    if (upRes.status === 409) {
      matbeastDebugLog(
        "file:new-tab",
        "cloud upload rejected duplicate",
        cloudName,
      );
      return { status: "duplicate" };
    }
    if (!upRes.ok) {
      const body = await upRes.text().catch(() => "");
      matbeastDebugLog(
        "file:new-tab",
        "cloud upload failed",
        upRes.status,
        body.slice(0, 200),
      );
      return { status: "error" };
    }
    return { status: "ok", name: cloudName };
  } catch (e) {
    matbeastDebugLog(
      "file:new-tab",
      "cloud upload threw",
      e instanceof Error ? e.message : String(e),
    );
    return { status: "error" };
  }
}

/** Creates a new server tournament and opens it as a new tab (desktop + web). */
export async function matbeastCreateNewEventTab(opts: {
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string, trainingMode?: boolean) => void;
  refreshTournaments: () => Promise<void>;
  /**
   * Lets us rename the tab once the cloud picks an "UNTITLED(N)" slot.
   * Optional so callers that don't want the cloud-default behavior (or
   * that don't have a rename callback handy) still work the same as before.
   */
  updateTabName?: (id: string, name: string) => void;
  /**
   * Optional explicit event title + filename, supplied by the
   * "Create new event" dialog. When present these override the
   * auto-generated defaults ("Untitled event" / next free
   * `MMDD-N`). When absent the legacy auto-flow runs unchanged so
   * callers that don't use the dialog still work.
   */
  eventName?: string;
  filename?: string;
  /** Training event files use the separate TrainingMaster* lists. */
  trainingMode?: boolean;
}) {
  const {
    queryClient,
    openEventInTab,
    refreshTournaments,
    updateTabName,
    eventName: requestedEventName,
    filename: requestedFilename,
    trainingMode: requestedTrainingMode,
  } = opts;

  /**
   * Pre-flight: refuse to create a new event unless the cloud is
   * reachable. Events are cloud-first in this build — creating an
   * event while offline would leave a permanently-LOCAL-ONLY
   * tournament on this install (no link to a cloud event, no
   * filename slot reserved, no catalog row). The user's recovery
   * path from that state is murky, so we'd rather block creation
   * up front with a clear message than produce a half-synced tab.
   *
   * The demo variant is always offline-by-design, so the probe
   * would always fail. We skip it entirely and the
   * `createCloudUntitledForNewTab` call later in this function is
   * similarly guarded so no cloud POST is ever issued.
   */
  const demoMode = isMatbeastDemo();
  if (!demoMode) {
    const probed = await probeCloud();
    if (!probed.online) {
      if (probed.reason === "not-configured") {
        window.alert(
          "Cloud sync is not configured on this machine. Configure it under " +
            "Options ▸ CLOUD SYNC… before creating a new event.",
        );
      } else {
        window.alert(
          "Can't reach the cloud right now, so a new event can't be created. " +
            "Check your internet connection and try again. Your existing open " +
            "events will keep working and re-sync when the connection returns.",
        );
      }
      return { ok: false } as const;
    }
  }

  const requestedName =
    (requestedEventName ?? "").trim() || "Untitled event";
  const res = await fetch("/api/tournaments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: requestedName,
      trainingMode: Boolean(requestedTrainingMode),
    }),
  });
  const j = (await res.json()) as {
    id?: string;
    name?: string;
    trainingMode?: boolean;
    error?: string;
  };
  if (!res.ok || !j.id) {
    window.alert(j.error ?? "Could not create event");
    return { ok: false } as const;
  }
  const initialLabel = (j.name ?? requestedName).trim() || requestedName;
  matbeastDebugLog("file:new-tab", "created tournament", j.id, initialLabel);
  openEventInTab(j.id, initialLabel, Boolean(j.trainingMode));
  setAudioVolumePercent(100);
  const placeholderFileName =
    (requestedFilename ?? "").trim() || `${formatTodayMMDD()}-1`;
  await matbeastFetch("/api/board", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-matbeast-tournament-id": j.id,
      "x-matbeast-skip-undo": "1",
    },
    // Temporary local placeholder until the cloud-first flow below
    // replaces it with the real `MMDD-N` slot (or leaves it alone when
    // cloud isn't configured). Using today's date here means an
    // offline-only event also ends up with a sensible filename.
    body: JSON.stringify({
      currentRosterFileName: placeholderFileName,
    }),
  });
  matbeastDebugLog("file:new-tab", "refreshTournaments + invalidate");
  await refreshTournaments();
  void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
  window.dispatchEvent(
    new CustomEvent("matbeast-tournament-changed", { detail: { id: j.id } }),
  );

  /**
   * Demo variant: no cloud to upload to, so we stop here with a
   * clean local-only tournament. The placeholder filename we PATCH'd
   * above is final. Returning `cloudSkipped: true` matches the same
   * shape the offline/unconfigured production path uses so the
   * caller (AppChrome's new-event dialog) doesn't need a
   * demo-specific branch.
   */
  if (demoMode) {
    return { ok: true, tournamentId: j.id, cloudSkipped: true } as const;
  }

  /**
   * Cloud-first new-event flow (added v0.8.2, dated in v0.8.5): if the
   * install is signed in, mirror the brand-new tournament to the cloud
   * immediately under the dialog-picked filename, or — when the caller
   * didn't use the dialog — a best-effort `MMDD-N` slot. Only the
   * filename side of the pair is rewritten here; the tournament's
   * display title (the tab label) stays at whatever the caller
   * requested. Best-effort: silently no-op offline / unconfigured so
   * the user is never blocked from creating a local event.
   */
  const cloudResult = await createCloudUntitledForNewTab(
    j.id,
    requestedFilename?.trim() || undefined,
    {
      trainingMode: Boolean(j.trainingMode ?? requestedTrainingMode),
      /**
       * Pass the just-created tournament's display title so the cloud
       * blob's envelope gets the correct `eventName`. `j.name` comes
       * straight from `prisma.tournament.create({ data: { name: ... }})`
       * via the `/api/tournaments` POST response and is the same
       * string the user typed into the dialog (or "Untitled event"
       * when blank). Falling back to `requestedName` covers the
       * theoretical case where the API response omitted `name`.
       */
      displayName: (j.name ?? requestedName).trim() || requestedName,
    },
  );
  if (cloudResult.status === "ok") {
    matbeastDebugLog(
      "file:new-tab",
      "cloud upload ok",
      j.id,
      cloudResult.name,
    );
    await matbeastFetch("/api/board", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-matbeast-tournament-id": j.id,
        "x-matbeast-skip-undo": "1",
      },
      body: JSON.stringify({ currentRosterFileName: cloudResult.name }),
    });
    void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    window.dispatchEvent(
      new CustomEvent("matbeast-cloud-sync-changed", {
        detail: { tournamentId: j.id },
      }),
    );
    return { ok: true, tournamentId: j.id } as const;
  }

  if (cloudResult.status === "duplicate") {
    // Roll the local tournament back so the user doesn't end up
    // with a stranded "Untitled event" tab that has no cloud row.
    // The renderer caller (typically the NewEventDialog submit
    // handler in AppChrome) reads `duplicate: true` off the result
    // and closes the tab before re-opening the dialog with the
    // user's typed values still intact.
    matbeastDebugLog(
      "file:new-tab",
      "rolling back local tournament after duplicate filename",
      j.id,
    );
    try {
      await fetch(`/api/tournaments/${encodeURIComponent(j.id)}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort */
    }
    await refreshTournaments();
    return { ok: false, duplicate: true, tournamentId: j.id } as const;
  }

  // "not-configured" or generic "error" — keep the local tournament
  // so the user can still edit and retry via File ▸ Home page ▸ Open
  // once cloud is up. The auto-link path in the save pipeline will
  // pick things up on the next successful save.
  return { ok: true, tournamentId: j.id, cloudSkipped: true } as const;
}

/** Imports JSON from disk into a new tournament tab. */
export async function matbeastImportOpenedEventFile(opts: {
  filePath: string;
  text: string;
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string, trainingMode?: boolean) => void;
  refreshTournaments: () => Promise<void>;
  /**
   * When the envelope has no boolean `trainingMode`, catalog metadata can
   * supply the flag (e.g. opening from cloud home for older files). When the
   * file includes `trainingMode: true|false`, the envelope always wins.
   */
  trainingModeOverride?: boolean;
  /**
   * When provided, opening the same `filePath` again focuses the existing
   * tab instead of creating another tournament (desktop + cloud synthetic paths).
   */
  openTabs?: EventTab[];
  selectTab?: (id: string) => void;
  setShowHome?: (show: boolean) => void;
  /**
   * When set (cloud home / open-from-cloud), focuses the tab already linked
   * to this catalog id via CloudEventLink — works across reloads; no duplicate
   * tournament or link conflict.
   */
  cloudEventId?: string;
  /**
   * v0.9.36 defensive override for the envelope's `eventName`. When the
   * caller has access to a more authoritative display title than what
   * is in the envelope itself — e.g. the cloud catalog row's
   * `eventName` column when opening from cloud — pass it here. Used
   * to heal events whose blob was uploaded with the v0.9.35 (and
   * earlier) bug where `createCloudUntitledForNewTab` wrote the
   * cloud filename into `eventName`. The catalog's `eventName` is
   * patched on every rename in `cloud/events/rename`, so it stays
   * correct even when the blob lags behind.
   *
   * Empty / null values are ignored — the parser's normal eventName
   * resolution still runs, including its filename-stem fallback.
   */
  displayNameOverride?: string | null;
}) {
  const {
    filePath,
    text,
    queryClient,
    openEventInTab,
    refreshTournaments,
    trainingModeOverride,
    openTabs,
    selectTab,
    setShowHome,
    cloudEventId,
    displayNameOverride,
  } = opts;

  if (cloudEventId?.trim() && openTabs?.length && selectTab) {
    const focused = await tryFocusExistingTabForCloudEvent({
      cloudEventId: cloudEventId.trim(),
      openTabs,
      selectTab,
      setShowHome,
    });
    if (focused) return;
  }

  const existingTid = findTournamentIdForFilePath(filePath);
  if (existingTid && openTabs?.some((t) => t.id === existingTid)) {
    selectTab?.(existingTid);
    setShowHome?.(false);
    matbeastDebugLog("file:import", "reuse open tab (same path)", existingTid, filePath);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    window.alert("Could not parse JSON file.");
    return;
  }
  const fallbackName =
    filePath.split(/[/\\]/).pop()?.replace(EVENT_FILENAME_EXT_RE, "") ?? "Imported event";
  const parsedRecord = parsed as Record<string, unknown> | null;
  const rootTraining = parsedRecord?.trainingMode;
  const envelopeHasTrainingModeBoolean =
    parsedRecord?.kind === "matbeast-event" && typeof rootTraining === "boolean";
  const {
    eventName: parsedEventName,
    document,
    bracket,
    audioVolumePercent,
    trainingMode: fileTrainingMode,
  } = parseMatBeastEventFileJson(parsed, fallbackName);
  /**
   * v0.9.36 defensive: when the caller passes `displayNameOverride`
   * (e.g. cloud-catalog `eventName` from `HomeCloudPanel.openCloudEvent`)
   * and it is non-empty, prefer it over whatever the envelope's parser
   * resolved. This heals events whose cloud blob was uploaded by an
   * older build with the filename mistakenly written into the
   * envelope's `eventName` field — the catalog row's `eventName` is
   * always rewritten on rename and on the upload route's
   * `prisma.tournament.findUnique` lookup, so it is the more
   * authoritative source for cloud-origin imports. For disk imports
   * the caller does not pass this field, so behaviour is unchanged.
   */
  const overrideTrim =
    typeof displayNameOverride === "string" ? displayNameOverride.trim() : "";
  const eventName = overrideTrim ? overrideTrim : parsedEventName;
  /**
   * Prefer the envelope's `trainingMode` whenever it is a boolean so the
   * opened tournament matches the file bytes (fixes stale cloud catalog
   * rows on other installs). Fall back to `trainingModeOverride` (cloud
   * home list) only when the key is absent — legacy saves before the field
   * existed.
   */
  const effectiveTrainingMode = envelopeHasTrainingModeBoolean
    ? (rootTraining as boolean)
    : trainingModeOverride !== undefined
      ? trainingModeOverride
      : Boolean(fileTrainingMode);
  const res = await fetch("/api/tournaments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: eventName,
      trainingMode: effectiveTrainingMode,
    }),
  });
  const j = (await res.json()) as {
    id?: string;
    name?: string;
    trainingMode?: boolean;
    error?: string;
  };
  if (!res.ok || !j.id) {
    window.alert(j.error ?? "Could not create event from file");
    return;
  }
  matbeastDebugLog("file:import", "open tab", j.id, j.name ?? eventName, {
    filePath,
  });
  openEventInTab(j.id, j.name ?? eventName, j.trainingMode ?? effectiveTrainingMode);
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
  registerOpenEventFilePath(j.id, filePath);
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

/**
 * Prompt the user for a disk location and write the envelope for a
 * specific tab id there. Used by the close-while-offline flow to let
 * the user rescue unsynced edits before destroying the tab. Returns
 * `true` if the file was actually written, `false` if the user
 * cancelled or the write failed.
 */
export async function matbeastBackupTabByIdToDisk(opts: {
  queryClient: QueryClient;
  selectTab: (id: string) => void;
  getOpenTabs: () => EventTab[];
  tabId: string;
}): Promise<boolean> {
  const { queryClient, selectTab, getOpenTabs, tabId } = opts;
  // The envelope builder reads from the currently-active tournament
  // context on the server side, so we have to make `tabId` the
  // active one before building.
  selectTab(tabId);
  // Give React + the desktop IPC a tick to propagate the selection.
  await new Promise<void>((r) => setTimeout(r, 60));

  const tabMeta = getOpenTabs().find((t) => t.id === tabId);
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
    if (!pick.ok || !pick.filePath) return false;
    const w = await desk.writeTextFile(pick.filePath, text);
    if (!w.ok) {
      window.alert(w.error ?? "Could not write file");
      return false;
    }
    // Don't remember the disk path here — a "backup before close"
    // isn't the new source of truth for the tab; the cloud still is.
    return true;
  }
  downloadEventFile(defaultFile, text);
  void queryClient;
  return true;
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
      registerOpenEventFilePath(tid, pick.filePath);
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

/**
 * Restore a backup from disk and push it straight to the cloud under
 * `<original>(recovered)` (or `<original>(recovered)(1)`, `(2)`… on
 * collision) so the restored copy never overwrites whatever is
 * currently in the cloud under the original filename.
 *
 * Flow:
 *   1. Pick a .matb/.json/.mat file via the native dialog.
 *   2. Parse the envelope.
 *   3. Create a fresh local tournament + import its roster/bracket
 *      (same pipeline as `matbeastImportOpenedEventFile`, without
 *      remembering the disk path — we don't want future saves to
 *      write back over the original backup).
 *   4. Pick a non-colliding cloud filename of the form
 *      `<stem>(recovered)` / `<stem>(recovered)(N)`.
 *   5. Upload the envelope to the cloud under that name, creating a
 *      `CloudEventLink` so subsequent saves sync correctly.
 *   6. Sync `currentRosterFileName` so the dashboard header, homepage
 *      catalog, and future saves all agree.
 *
 * Called from the "Restore copy from disk" File menu item.
 */
export async function matbeastRestoreFromDiskToCloud(opts: {
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string, trainingMode?: boolean) => void;
  refreshTournaments: () => Promise<void>;
}): Promise<void> {
  const pick = await pickOpenedEventFileContents();
  if (!pick.ok) {
    if (pick.error) window.alert(pick.error);
    return;
  }

  // Parse the picked file as an event envelope.
  let parsed: unknown;
  try {
    parsed = JSON.parse(pick.text) as unknown;
  } catch {
    window.alert("Could not parse the selected file as a Mat Beast event.");
    return;
  }
  const stem =
    pick.filePath.split(/[/\\]/).pop()?.replace(EVENT_FILENAME_EXT_RE, "") ??
    "Restored event";
  const { eventName, document, bracket, audioVolumePercent } =
    parseMatBeastEventFileJson(parsed, stem);

  // Create a brand-new tournament so the restored copy does not
  // clobber the user's current working event.
  const res = await fetch("/api/tournaments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: eventName }),
  });
  const j = (await res.json()) as { id?: string; name?: string; error?: string };
  if (!res.ok || !j.id) {
    window.alert(j.error ?? "Could not create tournament for restore");
    return;
  }
  opts.openEventInTab(j.id, j.name ?? eventName);

  const imp = await matbeastFetch("/api/tournament/import-roster", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-matbeast-skip-undo": "1",
    },
    body: JSON.stringify({ document, bracket }),
  });
  if (!imp.ok) {
    const ij = (await imp.json().catch(() => ({}))) as { error?: string };
    window.alert(ij.error ?? "Could not import the restored envelope");
    return;
  }
  if (typeof audioVolumePercent === "number") {
    setAudioVolumePercent(audioVolumePercent);
  }

  /**
   * Demo / local-only: import into SQLite and assign a unique on-app filename.
   * No cloud upload — the restore pipeline above is cloud-centric.
   */
  if (isMatbeastDemo()) {
    let existing: string[] = [];
    try {
      const rfRes = await fetch("/api/tournaments/roster-filenames", {
        cache: "no-store",
      });
      if (rfRes.ok) {
        const data = (await rfRes.json()) as { names?: string[] };
        existing = (data.names ?? []).map((n) => (n ?? "").trim()).filter(Boolean);
      }
    } catch {
      /* best-effort */
    }
    const localName = pickRecoveredCloudFilename(stem, existing);
    await matbeastFetch("/api/board", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-matbeast-tournament-id": j.id,
        "x-matbeast-skip-undo": "1",
      },
      body: JSON.stringify({ currentRosterFileName: localName }),
    });
    await opts.queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    await opts.refreshTournaments();
    markTournamentClean(j.id);
    return;
  }

  // Compute a non-colliding cloud filename of the form
  // "<stem>(recovered)" / "<stem>(recovered)(N)".
  let existing: string[] = [];
  try {
    const listRes = await fetch("/api/cloud/events", { cache: "no-store" });
    if (listRes.ok) {
      const data = (await listRes.json()) as { events?: Array<{ name: string }> };
      existing = (data.events ?? []).map((e) => (e.name ?? "").trim());
    }
  } catch {
    /* best-effort; collisions will just produce a slightly awkward name */
  }
  const cloudName = pickRecoveredCloudFilename(stem, existing);

  // Build an envelope from the freshly-imported state (so the bracket
  // and audio volume are included in the exact shape the rest of the
  // app will produce on its next save) and upload it. We deliberately
  // use `buildEnvelopeTextForActiveTab` so the logic stays centralized
  // — the new tournament is now active because `openEventInTab` ran.
  const envelope = await buildEnvelopeTextForActiveTab(j.name ?? eventName);
  const upRes = await fetch("/api/cloud/events/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tournamentId: j.id,
      envelope,
      name: cloudName,
    }),
  });
  if (!upRes.ok) {
    const body = await upRes.text().catch(() => "");
    matbeastDebugLog(
      "file:restore",
      "cloud upload failed",
      upRes.status,
      body.slice(0, 200),
    );
    window.alert(
      `Restored into a local tab, but the cloud upload failed (HTTP ${upRes.status}). ` +
        `Use File ▸ Home page and try again, or check your cloud configuration.`,
    );
    return;
  }
  matbeastDebugLog("file:restore", "cloud upload ok", j.id, cloudName);

  // Point the board at the new filename so the dashboard header and
  // homepage catalog reflect the "(recovered)" name.
  await matbeastFetch("/api/board", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-matbeast-tournament-id": j.id,
      "x-matbeast-skip-undo": "1",
    },
    body: JSON.stringify({ currentRosterFileName: cloudName }),
  });
  await opts.queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
  await opts.refreshTournaments();
  markTournamentClean(j.id);
  window.dispatchEvent(
    new CustomEvent("matbeast-cloud-sync-changed", {
      detail: { tournamentId: j.id },
    }),
  );
}

/**
 * Given a filename stem and the list of filenames already in the
 * cloud, returns the next free `<stem>(recovered)[(N)]` name.
 *
 * Examples (`existing` in parentheses):
 *   - "0417-1", [] → "0417-1(recovered)"
 *   - "0417-1", ["0417-1(recovered)"] → "0417-1(recovered)(1)"
 *   - "0417-1", ["0417-1(recovered)","0417-1(recovered)(1)"] → "0417-1(recovered)(2)"
 *
 * `stem` is stripped of any extension before composition.
 */
export function pickRecoveredCloudFilename(
  stem: string,
  existing: string[],
): string {
  const cleanStem = stem.replace(EVENT_FILENAME_EXT_RE, "").trim() || "event";
  const used = new Set(
    existing
      .map((s) => s.replace(EVENT_FILENAME_EXT_RE, "").trim())
      .filter(Boolean),
  );
  const base = `${cleanStem}(recovered)`;
  if (!used.has(base)) return base;
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base}(${i})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}(${Date.now()})`;
}

/** Open file dialog (desktop) or request the in-app picker (web). */
export async function matbeastOpenEventOrShowPicker(opts: {
  queryClient: QueryClient;
  openEventInTab: (id: string, name: string, trainingMode?: boolean) => void;
  refreshTournaments: () => Promise<void>;
  openTabs?: EventTab[];
  selectTab?: (id: string) => void;
  setShowHome?: (show: boolean) => void;
}) {
  const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
  const passThrough = {
    openTabs: opts.openTabs,
    selectTab: opts.selectTab,
    setShowHome: opts.setShowHome,
  };
  if (typeof desk?.showOpenEventDialog === "function") {
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
      ...passThrough,
    });
    return;
  }
  if (desk?.isDesktopApp) {
    const r = await pickOpenedEventFileViaHiddenInput();
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
      ...passThrough,
    });
    return;
  }
  window.dispatchEvent(new CustomEvent("matbeast-open-picker-request"));
}
