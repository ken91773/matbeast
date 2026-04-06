const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { autoUpdater } = require("electron-updater");

const devAppUrl = process.env.MAT_BEAST_DESKTOP_URL || "http://localhost:3000";
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "..", "build", "icon.ico");

/** Default release repo (overridable via MAT_BEAST_GH_OWNER / MAT_BEAST_GH_REPO). */
const DEFAULT_GH_OWNER = "ken91773";
const DEFAULT_GH_REPO = "matbeast";

let githubUpdateConfig = null;

let mainWindow = null;
let overlayWindow = null;
let isCheckingForUpdates = false;
let appUrl = devAppUrl;
let bundledServerProcess = null;
let updateState = {
  status: "idle",
  message: "Ready",
  downloadedVersion: null,
};

function ensureWindowsShellEnvironment() {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const cmdPath = path.join(systemRoot, "System32", "cmd.exe");
  const system32Path = path.join(systemRoot, "System32");
  // Some machines have malformed ComSpec values (e.g. cmdexe) causing ENOENT spawn failures.
  process.env.ComSpec = cmdPath;
  process.env.COMSPEC = cmdPath;
  process.env.comspec = cmdPath;
  if (!process.env.SystemRoot) {
    process.env.SystemRoot = systemRoot;
  }
  if (!process.env.WINDIR) {
    process.env.WINDIR = systemRoot;
  }
  const pathKey = Object.prototype.hasOwnProperty.call(process.env, "Path") ? "Path" : "PATH";
  const currentPath = process.env[pathKey] || "";
  if (!currentPath.toLowerCase().includes(system32Path.toLowerCase())) {
    process.env[pathKey] = `${system32Path};${currentPath}`;
  }
  // Ensure .EXE resolution is valid when tools spawn through the shell.
  if (!process.env.PATHEXT || !process.env.PATHEXT.toUpperCase().includes(".EXE")) {
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function broadcastUpdateState() {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send("app:update-state", updateState);
    }
  }
}

function setUpdateState(nextState) {
  updateState = {
    ...updateState,
    ...nextState,
  };
  broadcastUpdateState();
}

function resolveGithubUpdateConfig() {
  const owner = process.env.MAT_BEAST_GH_OWNER?.trim() || DEFAULT_GH_OWNER;
  const repo = process.env.MAT_BEAST_GH_REPO?.trim() || DEFAULT_GH_REPO;
  return { owner, repo };
}

function configureAutoUpdater() {
  githubUpdateConfig = resolveGithubUpdateConfig();

  if (!app.isPackaged) {
    setUpdateState({
      status: "disabled",
      message: "Updater is only available in packaged builds.",
      downloadedVersion: null,
    });
    return;
  }

  appendUpdaterLog(
    `${nowIso()}  configureAutoUpdater: GitHub ${githubUpdateConfig.owner}/${githubUpdateConfig.repo} (app v${app.getVersion()})\n`
  );

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({
    provider: "github",
    owner: githubUpdateConfig.owner,
    repo: githubUpdateConfig.repo,
    private: false,
  });

  autoUpdater.on("checking-for-update", () => {
    isCheckingForUpdates = true;
    appendUpdaterLog(`${nowIso()}  event: checking-for-update\n`);
    setUpdateState({
      status: "checking",
      message: "Checking for updates...",
      downloadedVersion: null,
    });
  });

  autoUpdater.on("update-available", (info) => {
    appendUpdaterLog(
      `${nowIso()}  event: update-available v${info?.version || "?"}${info?.releaseNotes ? " (has notes)" : ""}\n`
    );
    setUpdateState({
      status: "downloading",
      message: `Downloading version ${info.version}...`,
      downloadedVersion: null,
    });
  });

  autoUpdater.on("download-progress", (progressObj) => {
    const percent = Math.max(0, Math.min(100, Math.round(progressObj.percent)));
    setUpdateState({
      status: "downloading",
      message: `Downloading update... ${percent}%`,
      downloadedVersion: null,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    isCheckingForUpdates = false;
    appendUpdaterLog(
      `${nowIso()}  event: update-not-available (running v${app.getVersion()}${info?.version ? `, remote ${info.version}` : ""})\n`
    );
    setUpdateState({
      status: "up-to-date",
      message: "You are on the latest version.",
      downloadedVersion: null,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    isCheckingForUpdates = false;
    appendUpdaterLog(`${nowIso()}  event: update-downloaded v${info?.version || "?"}\n`);
    setUpdateState({
      status: "downloaded",
      message: `Version ${info.version} is ready to install.`,
      downloadedVersion: info.version,
    });
  });

  autoUpdater.on("error", (error) => {
    isCheckingForUpdates = false;
    appendUpdaterLog(`${nowIso()}  event: error ${error?.message || error}\n`);
    setUpdateState({
      status: "error",
      message: `Update error: ${error?.message || "Unknown updater error."}`,
      downloadedVersion: null,
    });
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdateState({
      status: "disabled",
      message: "Updater is only available in packaged builds.",
      downloadedVersion: null,
    });
    return { ok: false, reason: "not-packaged" };
  }

  if (isCheckingForUpdates) {
    setUpdateState({
      status: "checking",
      message: "Already checking for updates...",
      downloadedVersion: null,
    });
    return { ok: false, reason: "already-checking" };
  }

  setUpdateState({
    status: "checking",
    message: "Checking for updates...",
    downloadedVersion: null,
  });

  try {
    const timeoutMs = 20000;
    const result = await Promise.race([
      autoUpdater.checkForUpdates(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Update check timed out.")), timeoutMs);
      }),
    ]);

    const latestVersion = result?.updateInfo?.version;
    const currentVersion = app.getVersion();
    if (latestVersion && latestVersion === currentVersion) {
      isCheckingForUpdates = false;
      setUpdateState({
        status: "up-to-date",
        message: `You are on the latest version (${currentVersion}).`,
        downloadedVersion: null,
      });
    } else if (latestVersion && latestVersion !== currentVersion && updateState.status === "checking") {
      setUpdateState({
        status: "downloading",
        message: `Update ${latestVersion} found. Downloading...`,
        downloadedVersion: null,
      });
    }

    return { ok: true };
  } catch (error) {
    isCheckingForUpdates = false;
    const message = `Update error: ${error?.message || "Unable to check for updates."}`;
    setUpdateState({
      status: "error",
      message,
      downloadedVersion: null,
    });
    return { ok: false, reason: "check-failed" };
  }
}

async function checkForUpdatesWithDebug() {
  const logs = [];
  const pushLog = (line) => {
    logs.push(`${nowIso()}  ${line}`);
  };

  pushLog("Update check started.");
  pushLog(`Packaged app: ${app.isPackaged ? "yes" : "no"}`);
  pushLog(`Current version: ${app.getVersion()}`);
  const gh = githubUpdateConfig || resolveGithubUpdateConfig();
  pushLog(`GitHub repo: ${gh.owner}/${gh.repo}`);
  pushLog(`Updater log file: ${path.join(app.getPath("userData"), "updater.log")}`);

  const eventLogs = [];
  const onChecking = () => eventLogs.push("Event: checking-for-update");
  const onAvailable = (info) => eventLogs.push(`Event: update-available (${info?.version || "unknown"})`);
  const onNotAvailable = () => eventLogs.push("Event: update-not-available");
  const onDownloaded = (info) => eventLogs.push(`Event: update-downloaded (${info?.version || "unknown"})`);
  const onError = (error) => eventLogs.push(`Event: error (${error?.message || "unknown"})`);

  autoUpdater.on("checking-for-update", onChecking);
  autoUpdater.on("update-available", onAvailable);
  autoUpdater.on("update-not-available", onNotAvailable);
  autoUpdater.on("update-downloaded", onDownloaded);
  autoUpdater.on("error", onError);

  try {
    const result = await checkForUpdates();
    pushLog(`checkForUpdates() returned ok=${result.ok}${result.reason ? ` reason=${result.reason}` : ""}`);
    const finalState = updateState;
    pushLog(`Final state: ${finalState.status} | ${finalState.message}`);
    if (eventLogs.length === 0) {
      pushLog("No updater events captured during check window.");
    } else {
      for (const eventLine of eventLogs) {
        pushLog(eventLine);
      }
    }
    const updaterTail = readUpdaterLogTail(4500);
    if (updaterTail.trim()) {
      pushLog("--- updater.log (tail) ---");
      for (const line of updaterTail.trim().split(/\r?\n/)) {
        pushLog(line);
      }
    }
    return { ok: result.ok, reason: result.reason, logs, state: finalState };
  } catch (error) {
    pushLog(`Exception: ${error?.message || "Unknown exception"}`);
    return { ok: false, reason: "exception", logs, state: updateState };
  } finally {
    autoUpdater.removeListener("checking-for-update", onChecking);
    autoUpdater.removeListener("update-available", onAvailable);
    autoUpdater.removeListener("update-not-available", onNotAvailable);
    autoUpdater.removeListener("update-downloaded", onDownloaded);
    autoUpdater.removeListener("error", onError);
  }
}

function navigateMain(routePath) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(`${appUrl}${routePath}`);
}

function getFreeIpv4Port() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      srv.close(() => {
        if (port) resolve(port);
        else reject(new Error("Could not allocate a free TCP port."));
      });
    });
  });
}

function appendBundledServerLog(text) {
  try {
    const logPath = path.join(app.getPath("userData"), "bundled-server.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, text, "utf8");
  } catch {
    // ignore logging failures
  }
}

/** Phase 2: persistent log for electron-updater (GitHub Releases); separate from bundled-server.log. */
function appendUpdaterLog(text) {
  try {
    const logPath = path.join(app.getPath("userData"), "updater.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, text, "utf8");
  } catch {
    // ignore
  }
}

function readUpdaterLogTail(maxChars = 6000) {
  try {
    const logPath = path.join(app.getPath("userData"), "updater.log");
    if (!fs.existsSync(logPath)) return "";
    const raw = fs.readFileSync(logPath, "utf8");
    return raw.length <= maxChars ? raw : raw.slice(-maxChars);
  } catch {
    return "";
  }
}

/**
 * One automatic update check after startup (packaged only) so operators get updates without opening Home.
 * Set MAT_BEAST_SKIP_AUTO_UPDATE_CHECK=1 to disable (e.g. lab / air-gapped PCs).
 */
function scheduleDeferredAutoUpdateCheck() {
  if (!app.isPackaged) return;
  if (process.env.MAT_BEAST_SKIP_AUTO_UPDATE_CHECK === "1") {
    appendUpdaterLog(`${nowIso()}  Auto update check skipped (MAT_BEAST_SKIP_AUTO_UPDATE_CHECK=1)\n`);
    return;
  }
  const delayMs = 45000;
  appendUpdaterLog(`${nowIso()}  Auto update check scheduled in ${delayMs}ms\n`);
  setTimeout(() => {
    appendUpdaterLog(`${nowIso()}  Deferred checkForUpdates() starting\n`);
    autoUpdater.checkForUpdates().catch((err) => {
      appendUpdaterLog(`${nowIso()}  Deferred checkForUpdates error: ${err?.message || err}\n`);
      setUpdateState({
        status: "error",
        message: `Update error: ${err?.message || "Unable to check for updates."}`,
        downloadedVersion: null,
      });
    });
  }, delayMs);
}

/** Writable SQLite DB under userData (Program Files install is read-only). */
function ensureUserDatabaseFile() {
  const userData = app.getPath("userData");
  const userDbPath = path.join(userData, "matbeast.db");
  const templatePath = path.join(process.resourcesPath, "default-data", "matbeast-template.db");
  try {
    fs.mkdirSync(userData, { recursive: true });
    if (!fs.existsSync(userDbPath) && fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, userDbPath);
    }
  } catch (error) {
    appendBundledServerLog(
      `${nowIso()}  ensureUserDatabaseFile: ${error?.message || error}\n`
    );
  }
  return userDbPath;
}

function readBundledServerLogTail(maxChars = 4000) {
  try {
    const logPath = path.join(app.getPath("userData"), "bundled-server.log");
    if (!fs.existsSync(logPath)) return "";
    const raw = fs.readFileSync(logPath, "utf8");
    return raw.length <= maxChars ? raw : raw.slice(-maxChars);
  } catch {
    return "";
  }
}

/**
 * Wait until something accepts TCP on host:port (more reliable than HTTP for localhost).
 * Avoids allocating the same port ourselves immediately before bind (TIME_WAIT issues on Windows).
 */
function throwIfChildExited(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Bundled server exited before ready (code ${child.exitCode ?? "null"}, signal ${
        child.signalCode ?? "none"
      })`
    );
  }
}

async function waitForLocalPortOpen(port, host = "127.0.0.1", timeoutMs = 90000, child = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfChildExited(child);
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host, family: 4 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for bundled server to start.");
}

/** Optional: confirm HTTP responds (Next sometimes needs a moment after TCP accept). */
async function waitForHttpOk(url, timeoutMs = 15000, child = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfChildExited(child);
    const ready = await new Promise((resolve) => {
      const req = http.get(
        url,
        {
          timeout: 3000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode !== undefined && res.statusCode < 500);
        }
      );
      req.on("error", () => resolve(false));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Server accepted TCP but did not respond to HTTP in time.");
}

async function startBundledNextServer() {
  const standaloneRoot = path.join(process.resourcesPath, "standalone");
  const standaloneServerScript = path.join(standaloneRoot, "server.js");
  /** Bind all interfaces so Windows loopback is reliable; UI still uses 127.0.0.1. */
  const bindHost = "0.0.0.0";
  const loopbackHost = "127.0.0.1";
  const port =
    process.env.MAT_BEAST_PORT && /^\d+$/.test(String(process.env.MAT_BEAST_PORT).trim())
      ? parseInt(String(process.env.MAT_BEAST_PORT).trim(), 10)
      : await getFreeIpv4Port();
  appUrl = `http://${loopbackHost}:${port}`;

  const userDbPath = ensureUserDatabaseFile();
  /** Prisma requires a valid file URL; userData includes spaces (productName "Mat Beast Scoreboard"). */
  const databaseUrl = pathToFileURL(userDbPath).href;
  const tmpDir = path.join(app.getPath("userData"), "tmp");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // ignore
  }

  appendBundledServerLog(
    `${nowIso()}  Starting bundled Next.js (bind ${bindHost}:${port}, open ${appUrl}) cwd=${standaloneRoot}\n`
  );

  const bundledNodePath = path.join(process.resourcesPath, "node-runtime", "matbeast-node.exe");
  const preferredNodePath = "C:\\Program Files\\nodejs\\node.exe";
  const nodeCommand = fs.existsSync(bundledNodePath)
    ? bundledNodePath
    : fs.existsSync(preferredNodePath)
      ? preferredNodePath
      : "node";

  // Let any ephemeral port from getFreeIpv4Port() leave TIME_WAIT before the child binds.
  await new Promise((resolve) => setTimeout(resolve, 400));

  bundledServerProcess = await new Promise((resolve, reject) => {
    const child = spawn(nodeCommand, [standaloneServerScript], {
      cwd: standaloneRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: bindHost,
        DATABASE_URL: databaseUrl,
        TMP: tmpDir,
        TEMP: tmpDir,
        // Avoid corporate proxies breaking localhost checks in child or deps.
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    child.once("error", (error) => {
      reject(
        new Error(
          `${error.message} (command: ${nodeCommand}, serverScript: ${standaloneServerScript})`
        )
      );
    });
    const logChunk = (buf) => {
      const s = buf.toString();
      if (s) appendBundledServerLog(s);
    };
    child.stdout.on("data", logChunk);
    child.stderr.on("data", logChunk);
    child.once("spawn", () => resolve(child));
  });

  bundledServerProcess.on("exit", (code, signal) => {
    appendBundledServerLog(
      `${nowIso()}  Bundled server exit code=${code ?? "null"} signal=${signal ?? "null"}\n`
    );
    if (code !== 0 && !app.isQuitting) {
      const logPath = path.join(app.getPath("userData"), "bundled-server.log");
      dialog.showErrorBox(
        "Bundled Server Exited",
        `Bundled server exited unexpectedly (code ${code ?? "unknown"}).\n\nDetails are appended to:\n${logPath}`
      );
    }
  });

  try {
    await waitForLocalPortOpen(port, loopbackHost, 90000, bundledServerProcess);
    await waitForHttpOk(`${appUrl}/`, 20000, bundledServerProcess);
  } catch (error) {
    appendBundledServerLog(`${nowIso()}  startBundledNextServer failed: ${error?.message || error}\n`);
    const tail = readBundledServerLogTail();
    throw new Error(
      `${error?.message || "Bundled server failed to start."}${
        tail ? `\n\n--- bundled-server.log (tail) ---\n${tail}` : ""
      }`
    );
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: `Mat Beast Scoreboard v${app.getVersion()}`,
    icon: appIconPath,
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#111827",
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(appUrl);
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus();
    return;
  }

  overlayWindow = new BrowserWindow({
    title: "Mat Beast Scoreboard Overlay Output",
    icon: appIconPath,
    width: 1920,
    height: 1080,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.removeMenu();
  overlayWindow.loadURL(`${appUrl}/overlay`);
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function buildMenuTemplate() {
  return [
    {
      label: "File",
      submenu: [
        {
          label: "Home",
          click: () => navigateMain("/"),
        },
        {
          label: "Open Overlay Output Window",
          click: () => createOverlayWindow(),
        },
        {
          label: "Check for Updates",
          click: async () => {
            const debugResult = await checkForUpdatesWithDebug();
            const lines =
              debugResult.logs && debugResult.logs.length > 0
                ? debugResult.logs
                : ["No debug logs returned."];
            await dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "Update Check Debug",
              message: "Update diagnostics",
              detail: lines.join("\n"),
              buttons: ["OK"],
            });
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Tabs",
      submenu: [
        { label: "Roster Hub", click: () => navigateMain("/roster") },
        { label: "Blue Belt Roster", click: () => navigateMain("/roster/blue-belt") },
        { label: "Purple/Brown Roster", click: () => navigateMain("/roster/purple-brown") },
        { label: "Control", click: () => navigateMain("/control") },
        { label: "Overlay", click: () => navigateMain("/overlay") },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "togglefullscreen" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Mat Beast Score Project",
          click: async () => {
            await shell.openExternal(appUrl);
          },
        },
      ],
    },
  ];
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
  ensureWindowsShellEnvironment();
  let startupWarning = "";
  const boot = app.isPackaged
    ? startBundledNextServer().catch((error) => {
        startupWarning = `Bundled server failed to start. Fallback URL: ${devAppUrl}\n\nError: ${
          error?.message || "Unknown error"
        }\n\nSee: ${path.join(app.getPath("userData"), "bundled-server.log")}`;
        appUrl = devAppUrl;
      })
    : Promise.resolve();

  boot.finally(() => {
  configureAutoUpdater();

  ipcMain.handle("app:check-for-updates", async () => checkForUpdates());
  ipcMain.handle("app:check-for-updates-debug", async () => checkForUpdatesWithDebug());
  ipcMain.handle("app:get-runtime-info", async () => {
    return {
      version: app.getVersion(),
      executablePath: process.execPath,
      isPackaged: app.isPackaged,
    };
  });
  ipcMain.handle("app:show-update-debug-dialog", async (_event, logs) => {
    const lines = Array.isArray(logs) ? logs : [];
    const body = lines.join("\n");
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Check Debug",
      message: "Update diagnostics",
      detail: body || "No debug logs were returned.",
      buttons: ["OK"],
    });
    return { ok: true };
  });
  ipcMain.handle("app:get-update-state", async () => updateState);
  ipcMain.handle("app:install-downloaded-update", async () => {
    if (updateState.status !== "downloaded") {
      return { ok: false, reason: "no-downloaded-update" };
    }
    setUpdateState({
      status: "installing",
      message: "Installing update and restarting...",
      downloadedVersion: updateState.downloadedVersion,
    });
    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 500);
    return { ok: true };
  });

  const menu = Menu.buildFromTemplate(buildMenuTemplate());
  Menu.setApplicationMenu(menu);
  createMainWindow();
  if (startupWarning) {
    void dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Startup Fallback",
      message: "Bundled server startup failed",
      detail: startupWarning,
      buttons: ["OK"],
    });
  }

  scheduleDeferredAutoUpdateCheck();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (bundledServerProcess && !bundledServerProcess.killed) {
    bundledServerProcess.kill();
    bundledServerProcess = null;
  }
});
