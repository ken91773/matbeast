const { app, BrowserWindow, Menu, shell, ipcMain, dialog, screen } = require("electron");
const http = require("http");

/** Let timers, rAF, and Web Audio run while windows are in the background (timer sounds, board poll). */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const { isDemo } = require("./matbeast-variant.js");

const devAppUrl = process.env.MAT_BEAST_DESKTOP_URL || "http://localhost:3000";
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "..", "build", "icon.ico");

/** Default release repo (overridable via MAT_BEAST_GH_OWNER / MAT_BEAST_GH_REPO). */
const DEFAULT_GH_OWNER = "ken91773";
const DEFAULT_GH_REPO = "matbeast";

let githubUpdateConfig = null;

let mainWindow = null;
let scoreboardOverlayWindow = null;
let bracketOverlayWindow = null;
let overlayTournamentId = null;
function closeOverlayWindows() {
  const wins = [scoreboardOverlayWindow, bracketOverlayWindow];
  for (const win of wins) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  scoreboardOverlayWindow = null;
  bracketOverlayWindow = null;
}
/** Production default: keep scoreboard + bracket output windows enabled. */
const ENABLE_BRACKET_OVERLAY_WINDOW = true;
/** When the OS launches the app with a .matb / .mat / .json path (e.g. double-click in Explorer). */
let pendingOpenEventFilePath = null;
let isCheckingForUpdates = false;
let appUrl = devAppUrl;
let bundledServerProcess = null;
const DESKTOP_PREFERENCES_FILE = "desktop-preferences.json";
let desktopPreferences = {
  autoSaveEvery5Minutes: false,
};
let updateState = {
  status: "idle",
  message: "Ready",
  downloadedVersion: null,
};

function getDesktopPreferencesPath() {
  return path.join(app.getPath("userData"), DESKTOP_PREFERENCES_FILE);
}

function loadDesktopPreferences() {
  try {
    const filePath = getDesktopPreferencesPath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      desktopPreferences = {
        ...desktopPreferences,
        autoSaveEvery5Minutes: Boolean(parsed.autoSaveEvery5Minutes),
      };
    }
  } catch {
    // ignore
  }
}

function persistDesktopPreferences() {
  try {
    const filePath = getDesktopPreferencesPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(desktopPreferences, null, 2), "utf8");
  } catch {
    // ignore
  }
}

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

function matbeastDebugEnabled() {
  const v = String(process.env.MATBEAST_DEBUG || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Logs to the terminal / main process console when MATBEAST_DEBUG=1 */
function matbeastDebugLog(scope, ...parts) {
  if (!matbeastDebugEnabled()) return;
  console.log(`[matbeast] [${scope}]`, ...parts);
}

function isLikelyEventFilePath(p) {
  if (!p || typeof p !== "string") return false;
  const lower = p.toLowerCase();
  return (
    lower.endsWith(".matb") || lower.endsWith(".mat") || lower.endsWith(".json")
  );
}

/** First instance: file path after the executable (Windows file association). */
function findEventFileInArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith("-")) continue;
    if (!isLikelyEventFilePath(a)) continue;
    try {
      const resolved = path.resolve(a);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Windows `second-instance`: command line may be one string with quoted paths. */
function findEventFileInCommandLineString(commandLine) {
  if (!commandLine || typeof commandLine !== "string") return null;
  const re = /"([^"]+\.(?:matb|mat|json))"/gi;
  let m;
  let last = null;
  while ((m = re.exec(commandLine)) !== null) last = m[1];
  if (last) {
    try {
      const resolved = path.resolve(last);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* ignore */
    }
  }
  const parts = commandLine.split(/\s+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].replace(/^"/, "").replace(/"$/, "");
    if (!isLikelyEventFilePath(p)) continue;
    try {
      const resolved = path.resolve(p);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function enqueueOpenEventFile(filePath) {
  if (!filePath || typeof filePath !== "string") return;
  pendingOpenEventFilePath = path.resolve(filePath);
  matbeastDebugLog("open-file", "enqueue", pendingOpenEventFilePath);
  tryFlushPendingOpenEventFile();
}

function tryFlushPendingOpenEventFile() {
  const fp = pendingOpenEventFilePath;
  if (!fp) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const run = () => {
    if (!pendingOpenEventFilePath || pendingOpenEventFilePath !== fp) return;
    pendingOpenEventFilePath = null;
    sendFileMenuOpenRecent(fp);
  };
  const delayMs = 450;
  if (wc.isLoading()) {
    wc.once("did-finish-load", () => setTimeout(run, delayMs));
  } else {
    setTimeout(run, delayMs);
  }
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

/**
 * Recognize common "no internet / DNS down / host unreachable" patterns so the
 * renderer can show a dedicated offline status instead of a generic error.
 * electron-updater surfaces underlying Node/Chromium network errors verbatim.
 */
function isOfflineErrorMessage(rawMessage) {
  if (!rawMessage) return false;
  const msg = String(rawMessage);
  return (
    /ENOTFOUND/i.test(msg) ||
    /EAI_AGAIN/i.test(msg) ||
    /ECONNREFUSED/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /ETIMEDOUT/i.test(msg) ||
    /ENETUNREACH/i.test(msg) ||
    /EHOSTUNREACH/i.test(msg) ||
    /net::ERR_INTERNET_DISCONNECTED/i.test(msg) ||
    /net::ERR_NAME_NOT_RESOLVED/i.test(msg) ||
    /net::ERR_NETWORK_CHANGED/i.test(msg) ||
    /net::ERR_ADDRESS_UNREACHABLE/i.test(msg) ||
    /getaddrinfo/i.test(msg)
  );
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
    const rawMessage = error?.message || String(error ?? "");
    appendUpdaterLog(`${nowIso()}  event: error ${rawMessage}\n`);
    if (isOfflineErrorMessage(rawMessage)) {
      setUpdateState({
        status: "offline",
        message: "No internet connection — update check canceled.",
        downloadedVersion: null,
      });
      return;
    }
    setUpdateState({
      status: "error",
      message: `Update error: ${rawMessage || "Unknown updater error."}`,
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

  /**
   * Demo builds ship as a frozen snapshot and are not hooked up to
   * the production auto-update feed. Short-circuit both the user-
   * initiated "Check for Updates..." menu item and the deferred
   * startup check in `scheduleDeferredAutoUpdateCheck()` so the demo
   * never tries to pull a release manifest from the prod repo.
   */
  if (isDemo()) {
    setUpdateState({
      status: "disabled",
      message: "Updates are disabled in the demo build.",
      downloadedVersion: null,
    });
    return { ok: false, reason: "demo-variant" };
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
    const rawMessage = error?.message || "Unable to check for updates.";
    if (isOfflineErrorMessage(rawMessage)) {
      setUpdateState({
        status: "offline",
        message: "No internet connection — update check canceled.",
        downloadedVersion: null,
      });
      return { ok: false, reason: "offline" };
    }
    setUpdateState({
      status: "error",
      message: `Update error: ${rawMessage}`,
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

/** Hard cap so a single stuck error (e.g. Prisma P2022 spamming per poll)
 *  can't silently grow the log to hundreds of MB. When we cross the
 *  threshold the current log is rotated to `.old` (overwriting any
 *  previous rotation) and a fresh log starts. */
const BUNDLED_SERVER_LOG_MAX_BYTES = 8 * 1024 * 1024;

function rotateBundledServerLogIfTooLarge(logPath) {
  try {
    const st = fs.statSync(logPath);
    if (st.size < BUNDLED_SERVER_LOG_MAX_BYTES) return;
    const rotated = `${logPath}.old`;
    try {
      fs.rmSync(rotated, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.renameSync(logPath, rotated);
    } catch {
      /** Fallback if rename races a reader: truncate in place. */
      fs.writeFileSync(logPath, "", "utf8");
    }
  } catch {
    /* file doesn't exist yet — nothing to rotate */
  }
}

function appendBundledServerLog(text) {
  try {
    const logPath = path.join(app.getPath("userData"), "bundled-server.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateBundledServerLogIfTooLarge(logPath);
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
  if (isDemo()) {
    appendUpdaterLog(`${nowIso()}  Auto update check skipped (demo variant)\n`);
    return;
  }
  if (process.env.MAT_BEAST_SKIP_AUTO_UPDATE_CHECK === "1") {
    appendUpdaterLog(`${nowIso()}  Auto update check skipped (MAT_BEAST_SKIP_AUTO_UPDATE_CHECK=1)\n`);
    return;
  }
  const delayMs = 45000;
  appendUpdaterLog(`${nowIso()}  Auto update check scheduled in ${delayMs}ms\n`);
  setTimeout(() => {
    appendUpdaterLog(`${nowIso()}  Deferred checkForUpdates() starting\n`);
    autoUpdater.checkForUpdates().catch((err) => {
      const rawMessage = err?.message || String(err ?? "");
      appendUpdaterLog(`${nowIso()}  Deferred checkForUpdates error: ${rawMessage}\n`);
      if (isOfflineErrorMessage(rawMessage)) {
        setUpdateState({
          status: "offline",
          message: "No internet connection — update check canceled.",
          downloadedVersion: null,
        });
        return;
      }
      setUpdateState({
        status: "error",
        message: `Update error: ${rawMessage || "Unable to check for updates."}`,
        downloadedVersion: null,
      });
    });
  }, delayMs);
}

/**
 * Stable data folder (ASCII, no spaces). Prefer %LOCALAPPDATA% on Windows because
 * app.getPath("localUserData") can throw "Failed to get 'localUserData' path" on some installs.
 */
function resolveMatBeastDataRoot() {
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA;
    if (la && typeof la === "string" && la.trim()) {
      return path.join(la.trim(), "MatBeastScore");
    }
    const home = os.homedir();
    if (home) {
      return path.join(home, "AppData", "Local", "MatBeastScore");
    }
  }
  try {
    return path.join(app.getPath("localUserData"), "MatBeastScore");
  } catch {
    /* fall through */
  }
  try {
    return path.join(app.getPath("userData"), "MatBeastScore");
  } catch {
    return path.join(os.tmpdir(), "matbeastscore-data");
  }
}

/**
 * Writable SQLite under LocalAppData/MatBeastScore (ASCII path, no spaces).
 * Avoids SQLITE_CANTOPEN (14) with Prisma when userData lives under "Mat Beast Scoreboard".
 */
function ensureUserDatabaseFile() {
  const dataRoot = resolveMatBeastDataRoot();
  const userDbPath = path.join(dataRoot, "matbeast.db");
  const legacyPaths = [
    path.join(app.getPath("userData"), "data", "matbeast.db"),
    path.join(app.getPath("userData"), "matbeast.db"),
  ];
  const templatePath = path.join(process.resourcesPath, "default-data", "matbeast-template.db");
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    if (!fs.existsSync(userDbPath)) {
      let copied = false;
      for (const legacy of legacyPaths) {
        if (fs.existsSync(legacy)) {
          fs.copyFileSync(legacy, userDbPath);
          copied = true;
          break;
        }
      }
      if (!copied && fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, userDbPath);
      }
    }
  } catch (error) {
    appendBundledServerLog(
      `${nowIso()}  ensureUserDatabaseFile: ${error?.message || error}\n`
    );
  }
  return userDbPath;
}

/**
 * Additive columns that later schema revisions introduced. Every entry is
 * safe to `ALTER TABLE ADD COLUMN` on an older DB — i.e. either nullable
 * or has a literal DEFAULT so SQLite accepts the ADD on non-empty tables.
 *
 * When the Prisma schema gains a new optional column, add it here so
 * users upgrading from an older install don't hit P2022 ("column does
 * not exist") on the first query that reads it.
 */
const ADDITIVE_COLUMN_PATCHES = [
  { table: "Tournament", column: "trainingMode", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "Team", column: "overlayColor", ddl: "TEXT" },
  { table: "ResultLog", column: "tournamentId", ddl: "TEXT" },
  { table: "ResultLog", column: "leftTeamName", ddl: "TEXT" },
  { table: "ResultLog", column: "rightTeamName", ddl: "TEXT" },
  { table: "ResultLog", column: "isManual", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "ResultLog", column: "manualDate", ddl: "TEXT" },
  { table: "ResultLog", column: "manualTime", ddl: "TEXT" },
  { table: "ResultLog", column: "finalSummaryLine", ddl: "TEXT" },
  { table: "LiveScoreboardState", column: "sound10Enabled", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "LiveScoreboardState", column: "sound0Enabled", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "LiveScoreboardState", column: "sound10PlayNonce", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "LiveScoreboardState", column: "sound0PlayNonce", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // v0.7.0 cloud sync — link local master rows to their Mat Beast Masters
  // cloud counterparts. Both nullable so the ALTER is safe on existing DBs.
  { table: "MasterTeamName", column: "cloudId", ddl: "TEXT" },
  { table: "MasterPlayerProfile", column: "cloudId", ddl: "TEXT" },
  {
    table: "CloudConfig",
    column: "liveMastersPullFromCloud",
    ddl: "INTEGER NOT NULL DEFAULT 1",
  },
];

/**
 * New tables introduced after launch; created if missing before Prisma touches the DB.
 * Must stay aligned with `prisma/schema.prisma` (SQLite).
 */
const ENSURE_TRAINING_MASTER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "TrainingMasterPlayerProfile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "nickname" TEXT,
  "academyName" TEXT,
  "unofficialWeight" REAL,
  "heightFeet" INTEGER,
  "heightInches" INTEGER,
  "age" INTEGER,
  "beltRank" TEXT NOT NULL,
  "profilePhotoUrl" TEXT,
  "headShotUrl" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "TrainingMasterPlayerProfile_firstName_lastName_key"
  ON "TrainingMasterPlayerProfile"("firstName","lastName");
CREATE TABLE IF NOT EXISTS "TrainingMasterTeamName" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "TrainingMasterTeamName_name_key" ON "TrainingMasterTeamName"("name");
CREATE TABLE IF NOT EXISTS "AppSchemaMigration" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Structural drifts (PK renames, missing tables) that `ALTER TABLE ADD
 * COLUMN` *cannot* fix. If any of these are present the DB is too far
 * behind to patch additively, so we back it up and restore the bundled
 * seed template in its place (see {@link restoreSeedDbOverBrokenDb}).
 *
 * Each rule returns `true` if the drift IS present — i.e. the DB is
 * broken in that way.
 */
const STRUCTURAL_DRIFT_RULES = [
  {
    name: "LiveScoreboardState.tournamentId (PK) missing",
    check: (hasTable, hasColumn) =>
      hasTable("LiveScoreboardState") && !hasColumn("LiveScoreboardState", "tournamentId"),
  },
  {
    name: "MasterPlayerProfile table missing",
    check: (hasTable) => !hasTable("MasterPlayerProfile"),
  },
  {
    name: "MasterTeamName table missing",
    check: (hasTable) => !hasTable("MasterTeamName"),
  },
];

/**
 * The user's DB has drift that's too deep to fix with ALTER TABLE ADD
 * COLUMN. Move the broken file + its WAL/SHM sidecars aside to a
 * timestamped backup and let {@link ensureUserDatabaseFile} recopy the
 * bundled seed template on the next launch.
 *
 * The seed template (`resources/default-data/matbeast-template.db`) is
 * always rebuilt at package time against the current Prisma schema, so
 * this yields a clean, schema-current DB without shipping a migration
 * engine. Data loss is the cost — we keep the backup so the user can
 * export data manually if needed.
 */
function restoreSeedDbOverBrokenDb(userDbPath, reason) {
  try {
    const dir = path.dirname(userDbPath);
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const bak = path.join(dir, `matbeast.broken-${stamp}.db`);
    if (fs.existsSync(userDbPath)) fs.renameSync(userDbPath, bak);
    for (const sidecar of ["-wal", "-shm"]) {
      const p = `${userDbPath}${sidecar}`;
      if (fs.existsSync(p)) {
        try {
          fs.renameSync(p, `${bak}${sidecar}`);
        } catch {
          try {
            fs.rmSync(p, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }
    const templatePath = path.join(
      process.resourcesPath,
      "default-data",
      "matbeast-template.db"
    );
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, userDbPath);
      appendBundledServerLog(
        `${nowIso()}  restoreSeedDbOverBrokenDb: ${reason}. Backed up to ${bak}, restored seed template.\n`
      );
    } else {
      appendBundledServerLog(
        `${nowIso()}  restoreSeedDbOverBrokenDb: ${reason}. Backed up to ${bak}, BUT seed template missing at ${templatePath}. Next launch will initialize an empty DB.\n`
      );
    }
  } catch (e) {
    appendBundledServerLog(
      `${nowIso()}  restoreSeedDbOverBrokenDb failed: ${e?.message || e}\n`
    );
  }
}

/**
 * Existing installs copied `matbeast.db` before new Prisma columns existed.
 * `prisma db push` is not bundled with the desktop app, so apply critical
 * additive SQLite patches here before the Next server starts — and if we
 * detect non-additive drift (see {@link STRUCTURAL_DRIFT_RULES}), swap in
 * the bundled seed template instead.
 */
async function patchUserDatabaseSchemaAdditive(userDbPath, nodeCommand) {
  if (!userDbPath || !fs.existsSync(userDbPath)) return;

  const patchesJson = JSON.stringify(ADDITIVE_COLUMN_PATCHES);
  const driftRulesJson = JSON.stringify(
    STRUCTURAL_DRIFT_RULES.map((r) => ({ name: r.name, fn: r.check.toString() }))
  );

  /** Prefer Node's built-in SQLite (Node 22+) — handles WAL sidecars correctly.
   *  Stdout is a single JSON line: { applied:[...], drift:[...] }. */
  const nodeSqliteScript = `
import { DatabaseSync } from "node:sqlite";
const dbPath = ${JSON.stringify(userDbPath)};
const patches = ${patchesJson};
const driftRulesRaw = ${driftRulesJson};
const db = new DatabaseSync(dbPath);
const hasTable = (name) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .all(name).length > 0;
const hasColumn = (table, col) =>
  db
    .prepare(\`PRAGMA table_info("\${table}")\`)
    .all()
    .map((r) => String(r.name))
    .includes(col);
const applied = [];
for (const p of patches) {
  if (hasTable(p.table) && !hasColumn(p.table, p.column)) {
    try {
      db.exec(\`ALTER TABLE "\${p.table}" ADD COLUMN "\${p.column}" \${p.ddl}\`);
      applied.push(\`\${p.table}.\${p.column}\`);
    } catch (e) {
      applied.push(\`\${p.table}.\${p.column}=ERR:\${e.message}\`);
    }
  }
}
try {
  db.exec(${JSON.stringify(ENSURE_TRAINING_MASTER_SCHEMA_SQL)});
  applied.push("ensureTrainingTables");
} catch (e) {
  applied.push(\`ensureTrainingTables=ERR:\${e.message}\`);
}
const drift = [];
for (const r of driftRulesRaw) {
  let fn;
  try { fn = eval("(" + r.fn + ")"); } catch { continue; }
  try { if (fn(hasTable, hasColumn)) drift.push(r.name); } catch { /* ignore */ }
}
process.stdout.write(JSON.stringify({ applied, drift }));
process.exit(0);
`.trim();

  let applied = [];
  let drift = [];
  let patchedVia = null;

  try {
    const r = spawnSync(nodeCommand, ["--input-type=module", "-e", nodeSqliteScript], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    if (r.status === 0) {
      try {
        const parsed = JSON.parse(String(r.stdout || "").trim());
        applied = Array.isArray(parsed.applied) ? parsed.applied : [];
        drift = Array.isArray(parsed.drift) ? parsed.drift : [];
        patchedVia = "node:sqlite";
      } catch (parseErr) {
        appendBundledServerLog(
          `${nowIso()}  patchUserDatabaseSchemaAdditive: node:sqlite parse failed: ${parseErr?.message}\n`
        );
      }
    } else {
      const errText = `${r.stderr || ""}\n${r.stdout || ""}`.trim();
      appendBundledServerLog(
        `${nowIso()}  patchUserDatabaseSchemaAdditive: node:sqlite exit=${r.status}${
          errText ? ` msg=${errText.slice(0, 500)}` : ""
        }\n`
      );
    }
  } catch (e) {
    appendBundledServerLog(
      `${nowIso()}  patchUserDatabaseSchemaAdditive: node:sqlite spawn failed: ${e?.message || e}\n`
    );
  }

  /** Fallback: in-memory sql.js (older Node); OK for typical small Mat Beast DBs. */
  if (!patchedVia) {
    try {
      const initSqlJs = require("sql.js");
      const wasmDir = path.dirname(require.resolve("sql.js/package.json"));
      const wasmPath = path.join(wasmDir, "dist", "sql-wasm.wasm");
      const wasmBinary = fs.readFileSync(wasmPath);
      const SQL = await initSqlJs({ wasmBinary });
      const fileBuf = fs.readFileSync(userDbPath);
      const db = new SQL.Database(new Uint8Array(fileBuf));
      const hasTable = (name) =>
        db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}';`).length >
        0;
      const hasColumn = (table, col) => {
        const info = db.exec(`PRAGMA table_info("${table}");`);
        const colNames =
          info.length && info[0]?.values ? info[0].values.map((row) => String(row[1])) : [];
        return colNames.includes(col);
      };

      let changed = false;
      for (const p of ADDITIVE_COLUMN_PATCHES) {
        if (hasTable(p.table) && !hasColumn(p.table, p.column)) {
          try {
            db.run(`ALTER TABLE "${p.table}" ADD COLUMN "${p.column}" ${p.ddl};`);
            applied.push(`${p.table}.${p.column}`);
            changed = true;
          } catch (e) {
            applied.push(`${p.table}.${p.column}=ERR:${e?.message || e}`);
          }
        }
      }
      try {
        db.run(ENSURE_TRAINING_MASTER_SCHEMA_SQL);
        applied.push("ensureTrainingTables");
        changed = true;
      } catch (e) {
        applied.push(`ensureTrainingTables=ERR:${e?.message || e}`);
      }
      for (const rule of STRUCTURAL_DRIFT_RULES) {
        try {
          if (rule.check(hasTable, hasColumn)) drift.push(rule.name);
        } catch {
          /* ignore */
        }
      }
      if (changed) {
        const exported = db.export();
        db.close();
        fs.writeFileSync(userDbPath, Buffer.from(exported));
      } else {
        db.close();
      }
      patchedVia = "sql.js";
    } catch (e) {
      appendBundledServerLog(
        `${nowIso()}  patchUserDatabaseSchemaAdditive: sql.js fallback failed: ${e?.message || e}\n`
      );
    }
  }

  appendBundledServerLog(
    `${nowIso()}  patchUserDatabaseSchemaAdditive: via=${patchedVia || "none"}  applied=[${applied.join(
      ", "
    )}]  drift=[${drift.join(", ")}]  (${userDbPath})\n`
  );

  /** Non-additive drift detected: the additive patches can't rescue this
   *  DB. Back it up and let the next launch copy in the bundled seed. */
  if (drift.length > 0) {
    restoreSeedDbOverBrokenDb(userDbPath, `structural drift: ${drift.join("; ")}`);
  }
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
  /** ASCII-only path: forward slashes, no encoding needed for Prisma/SQLite. */
  const databaseUrl = "file:" + userDbPath.replace(/\\/g, "/");
  const tmpDir = path.join(resolveMatBeastDataRoot(), "tmp");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // ignore
  }

  appendBundledServerLog(
    `${nowIso()}  Starting bundled Next.js (bind ${bindHost}:${port}, open ${appUrl}) cwd=${standaloneRoot}\n` +
      `${nowIso()}  dataRoot=${resolveMatBeastDataRoot()} db=${userDbPath}\n`
  );

  const bundledNodePath = path.join(process.resourcesPath, "node-runtime", "matbeast-node.exe");
  const preferredNodePath = "C:\\Program Files\\nodejs\\node.exe";
  const nodeCommand = fs.existsSync(bundledNodePath)
    ? bundledNodePath
    : fs.existsSync(preferredNodePath)
      ? preferredNodePath
      : "node";

  await patchUserDatabaseSchemaAdditive(userDbPath, nodeCommand);

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
        SQLITE_TMPDIR: tmpDir,
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

function attachMainWindowCloseConfirm(win) {
  win._matbeastQuitAllowClose = false;
  win.on("close", async (e) => {
    if (win._matbeastQuitAllowClose || win.isDestroyed()) return;
    e.preventDefault();
    let dirty = false;
    try {
      dirty = Boolean(
        await win.webContents.executeJavaScript(
          "Boolean(window.__MATBEAST_HAS_UNSAVED_CHANGES__)",
          true,
        ),
      );
    } catch {
      dirty = false;
    }
    if (!dirty) {
      win._matbeastQuitAllowClose = true;
      win.close();
      return;
    }
    const r = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: "Mat Beast Scoreboard",
      message: "Save changes before closing?",
    });
    if (r.response === 2) return;
    if (r.response === 1) {
      win._matbeastQuitAllowClose = true;
      win.close();
      return;
    }
    let saved = false;
    try {
      saved = Boolean(
        await win.webContents.executeJavaScript(
          "window.__MATBEAST_SAVE_BEFORE_QUIT__ ? window.__MATBEAST_SAVE_BEFORE_QUIT__() : Promise.resolve(false)",
          true,
        ),
      );
    } catch {
      saved = false;
    }
    if (saved) {
      win._matbeastQuitAllowClose = true;
      win.close();
    }
  });
}

function createMainWindow() {
  const titleWithVersion = `Mat Beast Scoreboard v${app.getVersion()}`;
  mainWindow = new BrowserWindow({
    title: titleWithVersion,
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
      backgroundThrottling: false,
    },
  });

  /**
   * Next.js renders a <title> tag from metadata, which Chromium uses to
   * overwrite BrowserWindow.title after navigation. Intercept those updates
   * so the app version always shows in the window header.
   */
  mainWindow.webContents.on("page-title-updated", (event, renderedTitle) => {
    event.preventDefault();
    const base = typeof renderedTitle === "string" && renderedTitle.trim()
      ? renderedTitle.trim()
      : "Mat Beast Scoreboard";
    const suffix = ` v${app.getVersion()}`;
    const finalTitle = base.endsWith(suffix) ? base : `${base}${suffix}`;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setTitle(finalTitle);
  });

  mainWindow.loadURL(appUrl);
  attachMainWindowCloseConfirm(mainWindow);
  mainWindow.on("closed", () => {
    closeOverlayWindows();
    mainWindow = null;
  });
  tryFlushPendingOpenEventFile();
}

/** Native scoreboard graphic aspect (overlay page design size). */
const OVERLAY_NATIVE_W = 1920;
const OVERLAY_NATIVE_H = 1080;

function pickExternalDisplay() {
  try {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    if (displays.length < 2) return null;
    const ext = displays.find((d) => d.id !== primary.id);
    return ext ?? null;
  } catch {
    return null;
  }
}

/** 16:9 window like the scoreboard graphic, capped to work area. */
function computeOverlayBounds(display) {
  const wa = display.workArea || display.bounds;
  const maxW = Math.min(OVERLAY_NATIVE_W, wa.width);
  const maxH = Math.min(OVERLAY_NATIVE_H, wa.height);
  let width = maxW;
  let height = Math.round((width * 9) / 16);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * 16) / 9);
  }
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + (wa.height - height) / 2);
  return { x, y, width, height };
}

/** Park window just past the right edge of all displays — still painted for OBS, not on your monitors. */
const OVERLAY_OFFSCREEN_GAP_PX = 24;
function positionOverlayForObsCapture(win, width, height) {
  try {
    const displays = screen.getAllDisplays();
    if (!displays.length) return;
    let maxRight = -Infinity;
    let minTop = Infinity;
    for (const d of displays) {
      const b = d.bounds;
      maxRight = Math.max(maxRight, b.x + b.width);
      minTop = Math.min(minTop, b.y);
    }
    if (!Number.isFinite(maxRight)) return;
    win.setBounds({
      x: Math.round(maxRight + OVERLAY_OFFSCREEN_GAP_PX),
      y: Math.round(Number.isFinite(minTop) ? minTop : 0),
      width,
      height,
    });
  } catch {
    /* ignore */
  }
}

const OVERLAY_VERTICAL_STACK_PX = 36;

/**
 * Overlay output window(s). Scoreboard always; bracket only when {@link ENABLE_BRACKET_OVERLAY_WINDOW}.
 * Each loads `/overlay?outputScene=…` so dashboard preview never switches these via broadcast.
 */
function createOverlayWindowForRole(role) {
  const existing = role === "bracket" ? bracketOverlayWindow : scoreboardOverlayWindow;
  if (existing && !existing.isDestroyed()) {
    return;
  }

  const primary = screen.getPrimaryDisplay();
  const external = pickExternalDisplay();
  const targetDisplay = external ?? primary;
  const b0 = computeOverlayBounds(targetDisplay);
  const wa = targetDisplay.workArea || targetDisplay.bounds;
  const b =
    role === "bracket"
      ? {
          ...b0,
          y: Math.min(
            b0.y + OVERLAY_VERTICAL_STACK_PX,
            Math.max(wa.y, wa.y + wa.height - b0.height - 4),
          ),
        }
      : b0;

  const win = new BrowserWindow({
    title: role === "bracket" ? "BRACKETOVERLAY" : "SCOREBOARDOVERLAY",
    icon: appIconPath,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 640,
    minHeight: 360,
    transparent: true,
    frame: true,
    thickFrame: process.platform === "win32",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.removeMenu();
  const scene = role === "bracket" ? "bracket" : "scoreboard";
  const overlayQs = new URLSearchParams({ outputScene: scene });
  if (overlayTournamentId) {
    overlayQs.set("tournamentId", overlayTournamentId);
  }
  win.loadURL(`${appUrl}/overlay?${overlayQs.toString()}`, {
    extraHeaders: "pragma: no-cache\r\nCache-Control: no-cache\r\n",
  });

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    const td = pickExternalDisplay() ?? screen.getPrimaryDisplay();
    const bShow = computeOverlayBounds(td);
    const waShow = td.workArea || td.bounds;
    const bounds =
      role === "bracket"
        ? {
            ...bShow,
            y: Math.min(
              bShow.y + OVERLAY_VERTICAL_STACK_PX,
              Math.max(waShow.y, waShow.y + waShow.height - bShow.height - 4),
            ),
          }
        : bShow;
    win.setBounds(bounds);
    win.show();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      if (process.platform === "darwin" && typeof mainWindow.moveTop === "function") {
        try {
          mainWindow.moveTop();
        } catch {
          /* ignore */
        }
      }
    }
  });

  win.on("closed", () => {
    if (role === "bracket") {
      bracketOverlayWindow = null;
    } else {
      scoreboardOverlayWindow = null;
    }
  });

  if (role === "bracket") {
    bracketOverlayWindow = win;
  } else {
    scoreboardOverlayWindow = win;
  }
}

function createOverlayWindows() {
  createOverlayWindowForRole("scoreboard");
  if (ENABLE_BRACKET_OVERLAY_WINDOW) {
    createOverlayWindowForRole("bracket");
  }
}

/**
 * File menu → renderer. We inject a window CustomEvent from the main process so the
 * handler runs in the same JavaScript world as React. In some Electron builds,
 * webContents.send + preload ipcRenderer.on did not surface events to page listeners reliably.
 */
function sendFileMenuAction(action) {
  matbeastDebugLog("file-menu", "sendFileMenuAction", action, {
    hasMainWindow: Boolean(mainWindow && !mainWindow.isDestroyed()),
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const allowed = new Set([
    "new",
    "open",
    "load",
    "save",
    "saveAs",
    "openRecent",
    "openCloud",
    "uploadCloud",
    "home",
    "dashboard",
    "backupToDisk",
    "restoreFromDisk",
  ]);
  if (!allowed.has(action)) return;
  const json = JSON.stringify(action);
  const code = `window.dispatchEvent(new CustomEvent("matbeast-native-file",{detail:{source:"menu",action:${json}}}));`;
  mainWindow.webContents
    .executeJavaScript(code)
    .then(() => {
      matbeastDebugLog("file-menu", "executeJavaScript ok", action);
    })
    .catch((err) => {
      console.error("[matbeast] sendFileMenuAction failed:", err);
    });
}

/** Edit menu → renderer (undo / redo). Accelerators are display-only; the app handles Ctrl+Z / Ctrl+Y in the web layer. */
function sendEditMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const allowed = new Set(["undo", "redo"]);
  if (!allowed.has(action)) return;
  const json = JSON.stringify(action);
  const code = `window.dispatchEvent(new CustomEvent("matbeast-native-edit",{detail:{source:"menu",action:${json}}}));`;
  mainWindow.webContents.executeJavaScript(code).catch((err) => {
    console.error("[matbeast] sendEditMenuAction failed:", err);
  });
}

function sendFileMenuOpenRecent(filePath) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!filePath || typeof filePath !== "string") return;
  const payload = JSON.stringify({ source: "menu", action: "openRecent", filePath });
  const code = `window.dispatchEvent(new CustomEvent("matbeast-native-file",{detail:${payload}}));`;
  mainWindow.webContents.executeJavaScript(code).catch((err) => {
    console.error("[matbeast] sendFileMenuOpenRecent failed:", err);
  });
}

function sendOptionsMenuAction(action, extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const allowed = new Set(["audio-output", "autosave-5m", "cloud"]);
  if (!allowed.has(action)) return;
  const payload = JSON.stringify({ source: "menu", action, ...extra });
  const code = `window.dispatchEvent(new CustomEvent("matbeast-native-options",{detail:${payload}}));`;
  mainWindow.webContents.executeJavaScript(code).catch((err) => {
    console.error("[matbeast] sendOptionsMenuAction failed:", err);
  });
}

/**
 * Tracks which view the renderer is showing so the File menu's
 * first item can toggle between "Home page" and "Dashboard". Updated
 * via `app:set-workspace-view-state` IPC from
 * `DashboardClient` / `EventWorkspaceProvider`.
 */
const workspaceViewState = {
  showingHome: true,
  hasTabs: false,
};

function buildMenuTemplate() {
  /**
   * File menu toggle:
   *  - When the dashboard is showing → item is "Home page" and
   *    dispatches action `home` so the renderer sets
   *    `showHome = true` without closing any tabs.
   *  - When the home catalog is showing and at least one tab is
   *    open → item is "Dashboard" and dispatches `dashboard`
   *    which clears the override and returns to the last-active
   *    event.
   *  - When no tabs are open, the label stays "Home page" (the
   *    user is already there; clicking is a harmless no-op).
   */
  const canToggleToDashboard =
    workspaceViewState.showingHome && workspaceViewState.hasTabs;
  const homeToggle = canToggleToDashboard
    ? {
        label: "Dashboard",
        click: () => sendFileMenuAction("dashboard"),
      }
    : {
        label: "Home page",
        click: () => sendFileMenuAction("home"),
      };
  const demoMode = isDemo();
  return [
    {
      label: "File",
      submenu: [
        homeToggle,
        {
          label: "New event",
          click: () => sendFileMenuAction("new"),
        },
        { type: "separator" },
        {
          label: "Backup copy to disk",
          click: () => sendFileMenuAction("backupToDisk"),
        },
        {
          label: "Restore copy from disk",
          click: () => sendFileMenuAction("restoreFromDisk"),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrControl+Z",
          registerAccelerator: false,
          click: () => sendEditMenuAction("undo"),
        },
        {
          label: "Redo",
          accelerator: "CmdOrControl+Y",
          registerAccelerator: false,
          click: () => sendEditMenuAction("redo"),
        },
      ],
    },
    {
      label: "Options",
      submenu: [
        { label: "AUDIO OUTPUT", click: () => sendOptionsMenuAction("audio-output") },
        {
          label: "Auto-save on change",
          type: "checkbox",
          checked: Boolean(desktopPreferences.autoSaveEvery5Minutes),
          click: (menuItem) => {
            desktopPreferences.autoSaveEvery5Minutes = Boolean(menuItem.checked);
            persistDesktopPreferences();
            sendOptionsMenuAction("autosave-5m", {
              enabled: desktopPreferences.autoSaveEvery5Minutes,
            });
            refreshApplicationMenu();
          },
        },
        ...(demoMode
          ? []
          : [
              { type: "separator" },
              { label: "CLOUD SYNC...", click: () => sendOptionsMenuAction("cloud") },
            ]),
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "togglefullscreen" }],
    },
    {
      label: "Help",
      submenu: [
        ...(demoMode
          ? []
          : [
              {
                label: "Check for Updates…",
                click: () =>
                  mainWindow?.webContents?.send("matbeast-help-action", "check-updates"),
              },
              { type: "separator" },
            ]),
        {
          label: demoMode ? "Mat Beast Score Project (Demo build)" : "Mat Beast Score Project",
          click: async () => {
            await shell.openExternal(appUrl);
          },
        },
      ],
    },
  ];
}

function refreshApplicationMenu() {
  const menu = Menu.buildFromTemplate(buildMenuTemplate());
  Menu.setApplicationMenu(menu);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (!isLikelyEventFilePath(filePath)) return;
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
    } catch {
      return;
    }
    enqueueOpenEventFile(filePath);
  });

  app.on("second-instance", (event, argvOrCmdLine) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    let filePath = null;
    if (Array.isArray(argvOrCmdLine)) {
      filePath = findEventFileInArgv(argvOrCmdLine);
    } else if (typeof argvOrCmdLine === "string") {
      filePath = findEventFileInCommandLineString(argvOrCmdLine);
    }
    if (filePath) enqueueOpenEventFile(filePath);
  });

  app.whenReady().then(() => {
  ensureWindowsShellEnvironment();
  loadDesktopPreferences();
  const launchEventFile = findEventFileInArgv(process.argv);
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

  ipcMain.handle("overlay:open", () => {
    createOverlayWindows();
    return { ok: true };
  });
  ipcMain.handle("overlay:set-tournament-id", (_event, payload) => {
    const nextId =
      payload && typeof payload.tournamentId === "string"
        ? payload.tournamentId.trim() || null
        : null;
    if (nextId === overlayTournamentId) {
      return { ok: true };
    }
    overlayTournamentId = nextId;
    const updateWindow = (win, role) => {
      if (!win || win.isDestroyed()) return;
      const payloadJson = JSON.stringify({
        kind: "matbeast-overlay-tournament-id",
        tournamentId: overlayTournamentId,
      });
      const js = `window.dispatchEvent(new CustomEvent("matbeast-overlay-tournament-id",{detail:${payloadJson}}));`;
      win.webContents.executeJavaScript(js).catch(() => {
        /* ignore */
      });
    };
    updateWindow(scoreboardOverlayWindow, "scoreboard");
    updateWindow(bracketOverlayWindow, "bracket");
    return { ok: true };
  });
  ipcMain.handle("overlay:capture-preview", async (_event, payload) => {
    try {
      const scene = payload?.scene === "bracket" ? "bracket" : "scoreboard";
      const win = scene === "bracket" ? bracketOverlayWindow : scoreboardOverlayWindow;
      if (!win || win.isDestroyed()) {
        return { ok: false, error: "overlay-window-missing" };
      }
      const img = await win.webContents.capturePage();
      return { ok: true, dataUrl: img.toDataURL() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  /**
   * Demo-only IPC: list and read the .matb sample events bundled
   * into the installer via the `build/demo-seed/sample-events/` ->
   * `sample-events/` extraResource mapping. In a production build
   * the directory is either absent or empty (variant-prep.mjs wipes
   * it), so these handlers return an empty list and degrade
   * gracefully even if the renderer calls them accidentally.
   *
   * Path strategy:
   *   - Packaged: `<process.resourcesPath>/sample-events/`
   *   - Dev:      `<repo>/web/build/demo-seed/sample-events/`
   *
   * We only enumerate `.matb` files and never traverse
   * subdirectories; the envelope is a single-file JSON blob so a
   * nested layout would be a bug in variant-prep.mjs.
   */
  const resolveSampleEventsDir = () => {
    if (app.isPackaged && process.resourcesPath) {
      return path.join(process.resourcesPath, "sample-events");
    }
    return path.join(__dirname, "..", "build", "demo-seed", "sample-events");
  };

  ipcMain.handle("demo:list-sample-events", async () => {
    try {
      const dir = resolveSampleEventsDir();
      if (!fs.existsSync(dir)) {
        return { ok: true, events: [] };
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const events = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith(".matb")) continue;
        const full = path.join(dir, entry.name);
        let eventName = null;
        try {
          const text = fs.readFileSync(full, "utf8");
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.eventName === "string") {
            eventName = parsed.eventName;
          }
        } catch {
          // Unreadable/corrupt envelopes still get listed so the
          // user can see the file; the open flow will surface the
          // actual parse error downstream.
        }
        events.push({
          fileName: entry.name,
          eventName,
          sizeBytes: fs.statSync(full).size,
        });
      }
      events.sort((a, b) => a.fileName.localeCompare(b.fileName));
      return { ok: true, events };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("demo:read-sample-event", async (_event, payload) => {
    try {
      const fileName =
        payload && typeof payload.fileName === "string" ? payload.fileName : "";
      if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
        return { ok: false, error: "invalid-file-name" };
      }
      const full = path.join(resolveSampleEventsDir(), fileName);
      if (!fs.existsSync(full)) {
        return { ok: false, error: "not-found" };
      }
      const text = fs.readFileSync(full, "utf8");
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

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

  ipcMain.handle("app:show-open-event-dialog", async () => {
    const docs = app.getPath("documents");
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const r = await dialog.showOpenDialog(win, {
      title: "Open event file",
      defaultPath: docs,
      properties: ["openFile"],
      filters: [
        { name: "Mat Beast event", extensions: ["matb"] },
        { name: "Legacy .mat / .json", extensions: ["mat", "json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths?.[0]) {
      return { ok: false, canceled: true };
    }
    const filePath = r.filePaths[0];
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      app.addRecentDocument(filePath);
      refreshApplicationMenu();
      return { ok: true, filePath, text };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle("app:show-save-event-dialog", async (_event, opts) => {
    const docs = app.getPath("documents");
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const defaultName =
      opts && typeof opts.defaultName === "string" && opts.defaultName.trim()
        ? opts.defaultName.trim()
        : "event.matb";
    const r = await dialog.showSaveDialog(win, {
      title: "Save event file",
      defaultPath: path.join(docs, defaultName),
      filters: [
        { name: "Mat Beast event", extensions: ["matb"] },
        { name: "JSON (legacy)", extensions: ["json"] },
        { name: "Legacy .mat", extensions: ["mat"] },
      ],
    });
    if (r.canceled || !r.filePath) {
      return { ok: false, canceled: true };
    }
    return { ok: true, filePath: r.filePath };
  });

  /**
   * Default on-disk path for Save / autosave when the user has not chosen a path yet.
   * Uses the user's Documents folder (no extra subfolders). Writes are direct (no dialog).
   */
  ipcMain.handle("app:get-default-event-save-path", async (_event, opts) => {
    const docs = app.getPath("documents");
    const rawName =
      opts && typeof opts.defaultName === "string" && opts.defaultName.trim()
        ? opts.defaultName.trim()
        : "event.matb";
    const withExt = /\.(json|mat|matb)$/i.test(rawName) ? rawName : `${rawName}.matb`;
    const base = path.basename(withExt).replace(/[^a-zA-Z0-9\-_ .]+/g, "_").trim();
    const safe = base.length > 0 ? base : "event.matb";
    return { ok: true, filePath: path.join(docs, safe) };
  });

  /**
   * Write the event envelope to disk. Handles three historical failure
   * modes that used to bubble up as Electron's generic "Error invoking
   * remote method 'app:write-text-file'" alert:
   *
   *   1. A stored disk path inside `C:\Program Files\Mat Beast Scoreboard\`
   *      left over from a version that defaulted the save dialog to the
   *      install dir. Windows (correctly) denies that write with EPERM.
   *   2. A non-absolute `filePath` that Node would resolve against the
   *      Electron main process's cwd — which is the install dir when
   *      the user launched from the Start Menu, so again EPERM.
   *   3. Any other fs error (drive ejected, disk full, antivirus lock).
   *
   * In every case we now return `{ok:false, reason, error}` so the
   * renderer can surface a coherent message, release the "Saving..."
   * indicator, and (crucially) still push the envelope to the cloud.
   */
  ipcMain.handle("app:write-text-file", async (_event, payload) => {
    const filePath = payload?.filePath;
    const text = payload?.text;
    if (typeof filePath !== "string" || !filePath) {
      return { ok: false, reason: "bad-args", error: "filePath required" };
    }
    if (typeof text !== "string") {
      return { ok: false, reason: "bad-args", error: "text required" };
    }
    if (!path.isAbsolute(filePath)) {
      return {
        ok: false,
        reason: "not-absolute",
        error: `Refusing to save to a relative path: ${filePath}`,
      };
    }
    let installDir = "";
    try {
      installDir = path.dirname(app.getPath("exe"));
    } catch {
      installDir = "";
    }
    if (
      installDir &&
      filePath.toLowerCase().startsWith(installDir.toLowerCase() + path.sep)
    ) {
      return {
        ok: false,
        reason: "inside-install-dir",
        error:
          `Cannot save inside the app install folder (${installDir}). ` +
          `Choose a location in your Documents folder (File ▸ Save As…).`,
      };
    }
    try {
      await fs.promises.writeFile(filePath, text, "utf8");
    } catch (e) {
      const code = (e && typeof e === "object" && "code" in e) ? String(e.code) : "";
      return {
        ok: false,
        reason: code === "EPERM" || code === "EACCES" ? "permission" : "fs-error",
        error: String(e?.message || e),
      };
    }
    try { app.addRecentDocument(filePath); } catch { /* non-fatal */ }
    try { refreshApplicationMenu(); } catch { /* non-fatal */ }
    return { ok: true };
  });

  ipcMain.handle("app:read-text-file", async (_event, payload) => {
    const filePath = payload?.filePath;
    if (typeof filePath !== "string" || !filePath) {
      return { ok: false, error: "filePath required" };
    }
    try {
      const text = await fs.promises.readFile(filePath, "utf8");
      app.addRecentDocument(filePath);
      refreshApplicationMenu();
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle("app:add-recent-document", async (_event, payload) => {
    const filePath = payload?.filePath;
    if (typeof filePath !== "string" || !filePath) return { ok: false };
    app.addRecentDocument(filePath);
    refreshApplicationMenu();
    return { ok: true };
  });

  /**
   * Synchronous-from-renderer pull for desktop preferences.
   *
   * The push path (`sendOptionsMenuAction("autosave-5m", ...)` fired from
   * `did-finish-load`) can land before the React listener in `AppChrome` is
   * mounted, so the renderer misses the initial state and the autosave
   * interval never starts. This pull lets the renderer fetch the current
   * value on mount, closing the race without changing the menu push flow.
   */
  ipcMain.handle("options:get-preferences", async () => ({
    autoSaveEvery5Minutes: Boolean(desktopPreferences.autoSaveEvery5Minutes),
  }));

  /**
   * Renderer → main: publish current workspace view state so the File
   * menu's first item can swap between "Home page" and "Dashboard".
   * No-op when the reported state matches the cached state so we
   * don't pointlessly rebuild the native menu on every React render.
   */
  ipcMain.handle("app:set-workspace-view-state", async (_event, payload) => {
    const nextShowingHome = Boolean(payload?.showingHome);
    const nextHasTabs = Boolean(payload?.hasTabs);
    if (
      workspaceViewState.showingHome === nextShowingHome &&
      workspaceViewState.hasTabs === nextHasTabs
    ) {
      return { ok: true, changed: false };
    }
    workspaceViewState.showingHome = nextShowingHome;
    workspaceViewState.hasTabs = nextHasTabs;
    refreshApplicationMenu();
    return { ok: true, changed: true };
  });

  ipcMain.handle("app:focus-main-window", async () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    } catch {
      /* ignore */
    }
    return { ok: true };
  });

  refreshApplicationMenu();
  createMainWindow();
  if (launchEventFile) enqueueOpenEventFile(launchEventFile);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once("did-finish-load", () => {
      sendOptionsMenuAction("autosave-5m", {
        enabled: desktopPreferences.autoSaveEvery5Minutes,
      });
    });
  }
  createOverlayWindows();
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
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createOverlayWindows();
    }
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
  closeOverlayWindows();
  if (bundledServerProcess && !bundledServerProcess.killed) {
    bundledServerProcess.kill();
    bundledServerProcess = null;
  }
});
