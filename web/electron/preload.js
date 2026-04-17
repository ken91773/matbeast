const { contextBridge, ipcRenderer } = require("electron");

// File → app: main process uses webContents.executeJavaScript to dispatch
// `matbeast-native-file` on window (see electron/main.js). Preload no longer
// listens on ipcRenderer to avoid duplicate events and delivery issues.

contextBridge.exposeInMainWorld("matBeastDesktop", {
  isDesktopApp: true,
  openScoreboardOverlayWindow: () => ipcRenderer.invoke("overlay:open"),
  setOverlayTournamentId: (tournamentId) =>
    ipcRenderer.invoke("overlay:set-tournament-id", { tournamentId }),
  captureOverlayPreview: (scene) =>
    ipcRenderer.invoke("overlay:capture-preview", { scene }),
  showOpenEventDialog: () => ipcRenderer.invoke("app:show-open-event-dialog"),
  showSaveEventDialog: (opts) => ipcRenderer.invoke("app:show-save-event-dialog", opts),
  getDefaultEventSavePath: (opts) =>
    ipcRenderer.invoke("app:get-default-event-save-path", opts),
  writeTextFile: (filePath, text) =>
    ipcRenderer.invoke("app:write-text-file", { filePath, text }),
  readTextFile: (filePath) => ipcRenderer.invoke("app:read-text-file", { filePath }),
  addRecentDocument: (filePath) =>
    ipcRenderer.invoke("app:add-recent-document", { filePath }),
  getDesktopPreferences: () => ipcRenderer.invoke("options:get-preferences"),
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
});
