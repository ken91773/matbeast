/**
 * Hardened preload entry. Runs in Electron's preload sandbox. Goal:
 *   - Always expose a status sentinel (`__matBeastPreloadStatus`) so the
 *     renderer can tell whether the preload ran at all and which step (if
 *     any) failed. This is what makes "the music IPC is missing" debuggable.
 *   - Never throw before the main `matBeastDesktop` bridge has been exposed.
 *     Any error in helper imports (e.g. variant detection) is caught and
 *     reported via the sentinel rather than aborting the whole preload.
 */
let __matBeastPreloadError = null;
const __matBeastPreloadStartedAt = Date.now();

let contextBridge;
let ipcRenderer;
try {
  ({ contextBridge, ipcRenderer } = require("electron"));
} catch (err) {
  __matBeastPreloadError = `require(electron) threw: ${String(err?.message || err)}`;
}

let getVariantSafe = () => "production";
try {
  ({ getVariant: getVariantSafe } = require("./matbeast-variant.js"));
} catch (err) {
  __matBeastPreloadError = (__matBeastPreloadError ? __matBeastPreloadError + " | " : "")
    + `require(matbeast-variant) threw: ${String(err?.message || err)}`;
  getVariantSafe = () => "production";
}

/**
 * Expose the status sentinel FIRST, before the main `matBeastDesktop`
 * bridge. Even if the rest of the preload throws, the renderer can still
 * read `window.__matBeastPreloadStatus` to report what happened.
 */
try {
  if (contextBridge) {
    contextBridge.exposeInMainWorld("__matBeastPreloadStatus", {
      ran: true,
      startedAt: __matBeastPreloadStartedAt,
      hasContextBridge: typeof contextBridge === "object",
      hasIpcRenderer: typeof ipcRenderer === "object",
      preloadError: __matBeastPreloadError,
      preloadVersion: "with-bracket-music-v2",
    });
  }
} catch (err) {
  __matBeastPreloadError = (__matBeastPreloadError ? __matBeastPreloadError + " | " : "")
    + `expose(__matBeastPreloadStatus) threw: ${String(err?.message || err)}`;
}

// File → app: main process uses webContents.executeJavaScript to dispatch
// `matbeast-native-file` on window (see electron/main.js). Preload no longer
// listens on ipcRenderer to avoid duplicate events and delivery issues.

if (!contextBridge || !ipcRenderer) {
  // Bridge primitives unavailable — the status sentinel above already
  // captured why. There's nothing meaningful we can expose here.
} else try {
  contextBridge.exposeInMainWorld("matBeastDesktop", {
  isDesktopApp: true,
  /**
   * Build variant: "production" or "demo". The renderer uses this to
   * hide cloud UI and render a different Home panel (bundled sample
   * events instead of the cloud catalog). Read once at preload
   * initialization; does not change mid-session.
   */
  variant: getVariantSafe(),
  /** Demo-only: list bundled sample event files (filename + eventName). */
  listSampleEvents: () => ipcRenderer.invoke("demo:list-sample-events"),
  /** Demo-only: read a bundled sample event's .matb text by filename. */
  readSampleEvent: (fileName) =>
    ipcRenderer.invoke("demo:read-sample-event", { fileName }),
  openScoreboardOverlayWindow: () => ipcRenderer.invoke("overlay:open"),
  setOverlayTournamentId: (tournamentId) =>
    ipcRenderer.invoke("overlay:set-tournament-id", { tournamentId }),
  captureOverlayPreview: (scene) =>
    ipcRenderer.invoke("overlay:capture-preview", { scene }),
  showOpenEventDialog: () => ipcRenderer.invoke("app:show-open-event-dialog"),
  showSaveEventDialog: (opts) => ipcRenderer.invoke("app:show-save-event-dialog", opts),
  getDefaultEventSavePath: (opts) =>
    ipcRenderer.invoke("app:get-default-event-save-path", opts),
  /**
   * Always resolve to a `{ok, ...}` shape — including for unexpected IPC
   * rejections — so renderer `await desk.writeTextFile(...)` calls
   * never escape the `emitSaveStatus("error")` path in the save flow.
   * Prior behaviour let EPERM throw up the chain, leaving the header
   * "Saving..." indicator stuck forever.
   */
  writeTextFile: (filePath, text) =>
    ipcRenderer
      .invoke("app:write-text-file", { filePath, text })
      .catch((e) => ({ ok: false, reason: "ipc-rejected", error: String(e?.message || e) })),
  readTextFile: (filePath) => ipcRenderer.invoke("app:read-text-file", { filePath }),
  addRecentDocument: (filePath) =>
    ipcRenderer.invoke("app:add-recent-document", { filePath }),
  getDesktopPreferences: () => ipcRenderer.invoke("options:get-preferences"),
  /**
   * Publishes the dashboard/home-view state to the main process so the
   * File menu's first item can toggle between "Home page" and
   * "Dashboard" without the renderer also owning menu templating.
   * Swallows rejections so a transient IPC hiccup can't throw out of
   * the React effect that reports state.
   */
  setWorkspaceViewState: (state) =>
    ipcRenderer
      .invoke("app:set-workspace-view-state", state)
      .catch(() => ({ ok: false })),
  /** Bring the main dashboard window to the foreground (keyboard focus). */
  focusMainWindow: () => ipcRenderer.invoke("app:focus-main-window"),
  /**
   * v1.2.9: First-launch password gate persistence. Stored in a small
   * JSON file under `userData/` rather than `localStorage`, because
   * the bundled Next server picks a different loopback port every
   * launch (`getFreeIpv4Port`), which changes the renderer origin and
   * silently invalidates origin-keyed `localStorage`. The IPC pair
   * survives port changes.
   */
  getFirstLaunchPasswordUnlocked: () =>
    ipcRenderer
      .invoke("app:get-first-launch-password-unlocked")
      .catch(() => ({ ok: false, unlocked: false })),
  setFirstLaunchPasswordUnlocked: (unlocked) =>
    ipcRenderer
      .invoke("app:set-first-launch-password-unlocked", { unlocked: Boolean(unlocked) })
      .catch(() => ({ ok: false })),
  /** Nudge `webContents.focus()` without requiring a window deactivation (fixes dead inputs after overlay/bracket work). */
  restoreWebKeyboardFocus: () =>
    ipcRenderer.invoke("app:restore-web-keyboard-focus"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  checkForUpdatesWithDebug: () => ipcRenderer.invoke("app:check-for-updates-debug"),
  getRuntimeInfo: () => ipcRenderer.invoke("app:get-runtime-info"),
  showUpdateDebugDialog: (logs) => ipcRenderer.invoke("app:show-update-debug-dialog", logs),
  getUpdateState: () => ipcRenderer.invoke("app:get-update-state"),
  installDownloadedUpdate: () => ipcRenderer.invoke("app:install-downloaded-update"),
  onUpdateStateChange: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("app:update-state", listener);
    return () => {
      ipcRenderer.removeListener("app:update-state", listener);
    };
  },
  onFileMenu: (cb) => {
    const listener = (e) => {
      const d = e.detail;
      if (d && d.source === "menu" && typeof d.action === "string") {
        cb(d.action);
      }
    };
    window.addEventListener("matbeast-native-file", listener);
    return () => {
      window.removeEventListener("matbeast-native-file", listener);
    };
  },
  onHelpMenu: (cb) => {
    const listener = (_event, action) => {
      if (typeof action === "string") cb(action);
    };
    ipcRenderer.on("matbeast-help-action", listener);
    return () => {
      ipcRenderer.removeListener("matbeast-help-action", listener);
    };
  },
  /**
   * Bracket overlay music — operator picks a host audio file that loops
   * silently on the bracket overlay window so it can be paired with the
   * bracket video as a single NDI source. State (file path, play/stop,
   * monitor on/off) is owned by main and pushed to every renderer via
   * `bracket-music:state` so the dashboard UI and the bracket overlay's
   * audio engine never drift.
   */
  getBracketMusicState: () => ipcRenderer.invoke("bracket-music:get-state"),
  chooseBracketMusicFile: () => ipcRenderer.invoke("bracket-music:choose-file"),
  clearBracketMusicFile: () => ipcRenderer.invoke("bracket-music:clear-file"),
  /** Switch to the bundled DEFAULT track shipped with the installer. */
  useBracketMusicDefault: () => ipcRenderer.invoke("bracket-music:use-default"),
  setBracketMusicPlaying: (playing) =>
    ipcRenderer.invoke("bracket-music:set-playing", { playing: Boolean(playing) }),
  setBracketMusicMonitor: (monitor) =>
    ipcRenderer.invoke("bracket-music:set-monitor", { monitor: Boolean(monitor) }),
  onBracketMusicStateChange: (cb) => {
    const listener = (_event, state) => {
      if (state && typeof state === "object") cb(state);
    };
    ipcRenderer.on("bracket-music:state", listener);
    return () => {
      ipcRenderer.removeListener("bracket-music:state", listener);
    };
  },
  /**
   * NDI network-binding bridge (v0.9.33). The dashboard's Overlay-card
   * status pill reads `getNdiState()` once on mount and then subscribes
   * via `onNdiStateChange` for live pushes (binding changes from the
   * NDI menu, feed start/stop, periodic OS-NIC refresh).
   *
   * `setNdiBinding(payload)` accepts the shape `desktopPreferences
   * .ndiBindAdapter` understands:
   *   - `{ kind: "auto" }`
   *   - `{ kind: "ip", ip: "192.168.0.20" }`
   *   - `{ kind: "adapter", adapterName: "Ethernet" }`
   * Resolves to `{ ok, willTakeEffectAfterRestart, snapshot }`. The
   * pill calls `relaunchForNdiBinding()` when the operator confirms
   * the restart prompt.
   */
  getNdiState: () => ipcRenderer.invoke("ndi:get-state"),
  setNdiBinding: (preference) =>
    ipcRenderer.invoke("ndi:set-binding", preference),
  relaunchForNdiBinding: () =>
    ipcRenderer.invoke("ndi:relaunch-for-binding"),
  onNdiStateChange: (cb) => {
    const listener = (_event, state) => {
      if (state && typeof state === "object") cb(state);
    };
    ipcRenderer.on("matbeast:ndi:state", listener);
    return () => {
      ipcRenderer.removeListener("matbeast:ndi:state", listener);
    };
  },
  /**
   * v0.9.34: NDI audio bridge. The offscreen NDI bracket renderer
   * captures PCM via an AudioWorklet PCM tap and pushes 1024-sample
   * planar Float32 frames here, which forward to the main process and
   * on into grandiose's `sender.audio()`.
   *
   * Channel: `ndi-audio:push` (one-way, fire-and-forget). Audio is a
   * stream — we don't want acknowledgements that could pile up under
   * back-pressure and stall the renderer's audio thread. If the
   * sender for that scene isn't running on the main side, the IPC
   * handler silently drops the frame (verified safe; receivers
   * tolerate gaps).
   *
   * Payload shape:
   *   { sampleRate: number, numChannels: number, numSamples: number,
   *     planar: ArrayBuffer (numChannels * numSamples * 4 bytes,
   *     channel-major Float32) }
   *
   * `ipcRenderer.send` performs a structured-clone of the payload,
   * which preserves the ArrayBuffer contents efficiently. We send
   * one message per ~21.3 ms of audio at 48 kHz / 1024-sample
   * frames — about 47 messages/sec, ~8 KB each → ~376 KB/sec. Well
   * within Electron's IPC budget.
   */
  pushNdiAudio: (scene, payload) => {
    try {
      ipcRenderer.send("ndi-audio:push", { scene, payload });
    } catch {
      /* swallow — see comment above; audio is best-effort */
    }
  },
});
} catch (err) {
  /**
   * If the main bridge expose fails for any reason (rare — usually a
   * Chromium policy override or a renderer with `contextIsolation: false`),
   * patch the status sentinel with the error so the renderer's
   * diagnostic hint can surface what went wrong.
   */
  __matBeastPreloadError = (__matBeastPreloadError ? __matBeastPreloadError + " | " : "")
    + `expose(matBeastDesktop) threw: ${String(err?.message || err)}`;
  try {
    contextBridge.exposeInMainWorld("__matBeastPreloadStatus", {
      ran: true,
      startedAt: __matBeastPreloadStartedAt,
      hasContextBridge: typeof contextBridge === "object",
      hasIpcRenderer: typeof ipcRenderer === "object",
      preloadError: __matBeastPreloadError,
      preloadVersion: "with-bracket-music-v2",
    });
  } catch {
    /* nothing more we can do here. */
  }
}
