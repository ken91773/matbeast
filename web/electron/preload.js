const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("matBeastDesktop", {
  isDesktopApp: true,
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
});
