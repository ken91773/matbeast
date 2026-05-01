const {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  screen,
  session,
  protocol,
  net: electronNet,
} = require("electron");
const http = require("http");

/** Let timers, rAF, and Web Audio run while windows are in the background (timer sounds, board poll). */
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
/** Cap Chromium HTTP disk cache under userData (otherwise Cache/ can grow to hundreds of MB). */
app.commandLine.appendSwitch(
  "disk-cache-size",
  String(100 * 1024 * 1024),
);

/**
 * `mat-beast-asset://` is the renderer's only window onto the host filesystem
 * for media playback. It is registered as a privileged scheme so the
 * `<audio>` element can stream the file the operator picked for the bracket
 * overlay music loop. `stream: true` enables Range request handling for
 * looping playback; `corsEnabled` lets the renderer fetch it cross-origin
 * from the http://localhost:port page the bundled Next server serves.
 *
 * Must be called *before* `app.ready`; the protocol handler is wired in
 * after `app.whenReady()` (see `registerBracketMusicProtocol`).
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mat-beast-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const { isDemo } = require("./matbeast-variant.js");
const { runOffscreenSmokeTest } = require("./ndi-smoke.js");
const ndiFeed = require("./ndi-feed.js");
const ndiTestPattern = require("./ndi-test-pattern.js");
const ndiAdapters = require("./ndi-adapters.js");
const ndiConfig = require("./ndi-config.js");

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
  /**
   * Bracket overlay music: a path to an audio file on the host machine that
   * loops on the bracket output window. `null` means no track selected.
   * `bracketMusicPlaying` is the operator's PLAY/STOP toggle (defaults on so
   * a configured track auto-loops on app launch). `bracketMusicMonitor` lets
   * the operator hear the track locally for sound-check; off by default so
   * the music goes only to the bracket NDI source / capture target.
   */
  bracketMusicFilePath: null,
  bracketMusicPlaying: true,
  bracketMusicMonitor: false,
  /**
   * NDI network-adapter binding (v0.9.33+). Determines which NIC NDI
   * announces / streams on. Same payload shape `ndi-adapters.resolveBinding`
   * understands:
   *
   *   - `{ kind: "auto" }` (default) → app picks Ethernet > Wi-Fi > any
   *     routable adapter at startup. Reflects whatever DHCP gave us
   *     this session — when the operator plugs in the tournament router
   *     and Ethernet gets a real IP, "auto" picks Ethernet over Wi-Fi
   *     automatically without operator action.
   *   - `{ kind: "ip", ip: "10.0.0.20" }` → pin to a specific IP. Used
   *     when the operator clicks a specific adapter in the menu.
   *   - `{ kind: "adapter", adapterName: "Ethernet" }` → pin to a named
   *     adapter regardless of its current IP. Useful when DHCP changes
   *     the IP between sessions but the adapter name is stable.
   *
   * The resolved IP is written to a private `ndi-config.v1.json` under
   * `<userData>/ndi-config/` and `NDI_CONFIG_DIR` is set so NDI's
   * runtime reads our config instead of the system-wide one. See
   * `electron/ndi-config.js` for the file-format details.
   */
  ndiBindAdapter: { kind: "auto" },
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
      const rawMusicPath =
        typeof parsed.bracketMusicFilePath === "string" &&
        parsed.bracketMusicFilePath.trim()
          ? parsed.bracketMusicFilePath
          : null;
      desktopPreferences = {
        ...desktopPreferences,
        autoSaveEvery5Minutes: Boolean(parsed.autoSaveEvery5Minutes),
        /**
         * If the previously stored audio file no longer exists (moved /
         * deleted between sessions) treat it as "no track" rather than
         * silently failing on first play. The operator will see the
         * dashboard report `NONE` and can pick a new track.
         */
        bracketMusicFilePath:
          rawMusicPath && fs.existsSync(rawMusicPath) ? rawMusicPath : null,
        bracketMusicPlaying:
          typeof parsed.bracketMusicPlaying === "boolean"
            ? parsed.bracketMusicPlaying
            : true,
        bracketMusicMonitor: Boolean(parsed.bracketMusicMonitor),
        ndiBindAdapter: normalizeNdiBindAdapter(parsed.ndiBindAdapter),
      };
    }
  } catch {
    // ignore
  }
}

/**
 * Validate / coerce a stored `ndiBindAdapter` payload. Anything we
 * don't recognise collapses to `{ kind: "auto" }` so a corrupted JSON
 * file can't brick the NDI feature.
 */
function normalizeNdiBindAdapter(value) {
  if (!value || typeof value !== "object") return { kind: "auto" };
  if (value.kind === "auto") return { kind: "auto" };
  if (value.kind === "ip" && typeof value.ip === "string" && value.ip.length > 0) {
    return { kind: "ip", ip: value.ip };
  }
  if (
    value.kind === "adapter" &&
    typeof value.adapterName === "string" &&
    value.adapterName.length > 0
  ) {
    return { kind: "adapter", adapterName: value.adapterName };
  }
  return { kind: "auto" };
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

/**
 * Bracket overlay music — host filesystem audio loop.
 *
 * The bracket overlay's renderer plays the file via a chrome-less <audio>
 * element. The renderer never sees the absolute path; it requests
 * `mat-beast-asset://music/track` and the protocol handler streams whatever
 * file is currently configured. That keeps the renderer side stateless and
 * avoids leaking arbitrary host paths through the renderer sandbox boundary.
 *
 * State changes are pushed to *every* live BrowserWindow via
 * `webContents.send("bracket-music:state", …)` so both the dashboard
 * (operator UI) and the bracket overlay (audio engine) stay in sync without
 * either polling.
 */
const BRACKET_MUSIC_STATE_CHANNEL = "bracket-music:state";
const BRACKET_MUSIC_AUDIO_FILTERS = [
  {
    name: "Audio files",
    extensions: ["mp3", "m4a", "aac", "ogg", "oga", "wav", "flac", "webm", "opus"],
  },
  { name: "All files", extensions: ["*"] },
];
/** Display name for the bundled "DEFAULT" track in the dashboard popover. */
const BRACKET_MUSIC_DEFAULT_DISPLAY_NAME = "DEFAULT";

/**
 * Resolve the absolute path to the bundled default bracket-music track.
 *
 * - **Packaged build:** the file lives under `<resources>/default-music/tale.mp3`
 *   thanks to the `extraResources` entry in `package.json`'s `build` block.
 * - **Dev (`desktop:dev`):** `process.resourcesPath` is Electron's bundle
 *   directory, which doesn't have our default-music folder. Fall back to
 *   the project source path so the feature still works during local
 *   development. The `__dirname` is `electron/`, so the project root is
 *   one level up.
 *
 * Returns `null` if no usable file is found in either location, so the
 * IPC handler can degrade gracefully (treat "use default" as "no track")
 * instead of putting a broken path into preferences.
 */
function getBundledDefaultBracketMusicPath() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "default-music", "tale.mp3"));
  }
  candidates.push(path.join(__dirname, "..", "build", "default-music", "tale.mp3"));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Whether the currently-configured bracket-music path matches the bundled
 * default. Used to render the dashboard's CHOOSE MUSIC label as
 * "DEFAULT" instead of the raw `tale.mp3` filename so operators
 * understand they're on the bundled track.
 */
function isCurrentBracketMusicTheDefault() {
  const current = desktopPreferences.bracketMusicFilePath;
  const def = getBundledDefaultBracketMusicPath();
  if (!current || !def) return false;
  return path.resolve(current) === path.resolve(def);
}

function bracketMusicSnapshot() {
  const filePath = desktopPreferences.bracketMusicFilePath;
  const isDefault = isCurrentBracketMusicTheDefault();
  return {
    filePath: typeof filePath === "string" && filePath ? filePath : null,
    fileName:
      typeof filePath === "string" && filePath
        ? isDefault
          ? BRACKET_MUSIC_DEFAULT_DISPLAY_NAME
          : path.basename(filePath)
        : null,
    /** Bumped on every persisted change so the renderer can cache-bust the
     * `<audio>` src and force a reload when the underlying file changes
     * even though the URL (`mat-beast-asset://music/track`) stays stable. */
    revision:
      typeof bracketMusicSnapshot.revision === "number"
        ? bracketMusicSnapshot.revision
        : 0,
    playing: Boolean(desktopPreferences.bracketMusicPlaying),
    monitor: Boolean(desktopPreferences.bracketMusicMonitor),
  };
}
bracketMusicSnapshot.revision = 0;

function broadcastBracketMusicState() {
  bracketMusicSnapshot.revision += 1;
  const snapshot = bracketMusicSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(BRACKET_MUSIC_STATE_CHANNEL, snapshot);
    } catch {
      /* ignore */
    }
  }
}

/**
 * NDI status broadcast (v0.9.33+).
 *
 * Channel `matbeast:ndi:state` carries a single snapshot describing the
 * NDI binding the operator should care about: which adapter is in use,
 * its friendly name (Wi-Fi / Ethernet / etc.), and whether each scene's
 * NDI source is currently broadcasting. The dashboard consumes this in
 * the Overlay-card header (status pill) so the operator can see at a
 * glance whether NDI is configured for cross-PC delivery.
 *
 * Push triggers (any of):
 *   - Adapter binding changed via `Options ▸ NDI ▸ Network adapter`.
 *   - A feed started or stopped (`toggleNdiFeed`).
 *   - Periodic refresh (every NDI_STATE_REFRESH_MS) so the pill catches
 *     OS-level NIC changes (cable unplugged, Wi-Fi reconnected, DHCP
 *     gave us a new IP) without the operator having to interact with
 *     a menu.
 */
const NDI_STATE_CHANNEL = "matbeast:ndi:state";
const NDI_STATE_REFRESH_MS = 5000;
let ndiStateRefreshTimer = null;

/**
 * Build the snapshot. Cheap (under 1 ms on dev hardware): just an
 * `os.networkInterfaces()` walk plus a few feature checks. Safe to
 * call from inside an IPC handler or on a 5 s timer without throttling.
 */
function buildNdiStateSnapshot() {
  const adapters = ndiAdapters.enumerateAdapters();
  const preference = desktopPreferences.ndiBindAdapter || { kind: "auto" };
  const resolved = ndiAdapters.resolveBinding(adapters, preference);
  /** Feed running state — read directly from `ndi-feed.js` so we never
   *  drift from the actual sender lifecycle (e.g. if a feed crashed). */
  const scoreboardRunning = ndiFeed.isFeedRunning("scoreboard");
  const bracketRunning = ndiFeed.isFeedRunning("bracket");
  return {
    /** "auto" or operator's pinned choice — what's saved in prefs. */
    preference,
    /** The adapter / IP the binding currently resolves to, or null if
     *  nothing routable is available (NDI will fall back to default
     *  multi-NIC mDNS announce). */
    resolved: resolved
      ? {
          adapterName: resolved.adapterName,
          friendlyName: resolved.friendlyName,
          ip: resolved.ip,
          type: resolved.type,
          isApipa: resolved.isApipa,
          isLoopback: resolved.isLoopback,
          isLikelyVirtual: resolved.isLikelyVirtual,
          isRoutable: resolved.isRoutable,
        }
      : null,
    /** All routable+APIPA adapters, sorted by preferenceRank. The menu
     *  and the status dialog use this to draw the picker. */
    adapters: adapters.map((a) => ({
      adapterName: a.adapterName,
      friendlyName: a.friendlyName,
      ip: a.ip,
      type: a.type,
      isApipa: a.isApipa,
      isLoopback: a.isLoopback,
      isLikelyVirtual: a.isLikelyVirtual,
      isRoutable: a.isRoutable,
    })),
    feeds: {
      scoreboard: { running: scoreboardRunning },
      bracket: { running: bracketRunning },
    },
    /** Echo of NDI_CONFIG_DIR so the operator can copy the path into
     *  Explorer if they want to inspect the active config file. */
    configDir: process.env.NDI_CONFIG_DIR || null,
  };
}

function broadcastNdiState() {
  const snapshot = buildNdiStateSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(NDI_STATE_CHANNEL, snapshot);
    } catch {
      /* ignore — renderer not ready yet */
    }
  }
  return snapshot;
}

/**
 * Apply the saved binding preference to the NDI runtime config file
 * and the `NDI_CONFIG_DIR` env var. Idempotent — safe to call on every
 * preference change. MUST run before `grandiose` is required for the
 * first time so `NDIlib_initialize()` reads our `ndi-config.v1.json`.
 */
function applySavedNdiBinding() {
  try {
    const adapters = ndiAdapters.enumerateAdapters();
    const resolved = ndiAdapters.resolveBinding(
      adapters,
      desktopPreferences.ndiBindAdapter || { kind: "auto" },
    );
    const result = ndiConfig.applyBinding({
      userDataDir: app.getPath("userData"),
      ip: resolved ? resolved.ip : null,
    });
    return { result, resolved };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

function startNdiStateRefreshTimer() {
  if (ndiStateRefreshTimer) return;
  ndiStateRefreshTimer = setInterval(() => {
    broadcastNdiState();
  }, NDI_STATE_REFRESH_MS);
  if (typeof ndiStateRefreshTimer.unref === "function") {
    ndiStateRefreshTimer.unref();
  }
}

/**
 * Wire `mat-beast-asset://music/track` to the currently configured audio
 * file. Uses `electronNet.fetch(file:// …)` so Electron's net stack handles
 * Range requests, MIME sniffing, and streaming — Chromium's `<audio>`
 * element seeks reliably during loop playback without any custom buffering.
 */
function registerBracketMusicProtocol() {
  if (typeof protocol.handle !== "function") return;
  try {
    protocol.handle("mat-beast-asset", async (request) => {
      let url;
      try {
        url = new URL(request.url);
      } catch {
        return new Response("Bad URL", { status: 400 });
      }
      if (url.hostname !== "music" || url.pathname !== "/track") {
        return new Response("Not found", { status: 404 });
      }
      const filePath = desktopPreferences.bracketMusicFilePath;
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response("No track selected", { status: 404 });
      }
      const { pathToFileURL } = require("url");
      const fileUrl = pathToFileURL(filePath).toString();
      try {
        return await electronNet.fetch(fileUrl, {
          headers: request.headers,
          /** Forward Range so seeking inside a long track works for the
           * renderer's <audio> element. */
          method: request.method || "GET",
        });
      } catch (err) {
        return new Response(`Read failed: ${String(err?.message || err)}`, {
          status: 500,
        });
      }
    });
  } catch (err) {
    console.error("[matbeast] registerBracketMusicProtocol failed:", err);
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

const RENDERER_CACHE_VERSION_MARKER = ".renderer-cache-version";
const MAX_USERDATA_BACKUP_FOLDERS = 2;
const MAX_BROKEN_DB_COPIES = 2;

/**
 * After each app update, drop stale HTTP + V8 code caches so Roaming profile
 * does not retain hundreds of MB of obsolete compiled assets.
 */
async function maybeClearStaleRendererCachesOnUpgrade() {
  if (!app.isPackaged) return;
  try {
    const markerPath = path.join(
      app.getPath("userData"),
      RENDERER_CACHE_VERSION_MARKER,
    );
    const ver = app.getVersion();
    let prev = "";
    if (fs.existsSync(markerPath)) {
      prev = fs.readFileSync(markerPath, "utf8").trim();
    }
    if (prev && prev !== ver) {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({ urls: [] });
    }
    fs.writeFileSync(markerPath, ver, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Recovery folders from manual DB moves (`_backup-*`) can be huge; keep the
 * newest few and remove older ones so AppData does not grow without bound.
 */
function pruneOldUserDataBackupFolders() {
  try {
    const root = app.getPath("userData");
    if (!fs.existsSync(root)) return;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && /^_backup-/.test(e.name))
      .map((e) => {
        const full = path.join(root, e.name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = MAX_USERDATA_BACKUP_FOLDERS; i < dirs.length; i += 1) {
      fs.rmSync(dirs[i].full, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Structural-drift recovery leaves `matbeast.broken-*.db` (+ wal/shm); retain
 * only the newest copies for forensics.
 */
function pruneOldBrokenDatabaseCopies() {
  try {
    const dir = resolveMatBeastDataRoot();
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    const mains = entries.filter((n) => /^matbeast\.broken-.+\.db$/.test(n));
    const withStat = mains
      .map((n) => {
        const p = path.join(dir, n);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = MAX_BROKEN_DB_COPIES; i < withStat.length; i += 1) {
      const base = withStat[i].p;
      fs.rmSync(base, { force: true });
      fs.rmSync(`${base}-wal`, { force: true });
      fs.rmSync(`${base}-shm`, { force: true });
    }
  } catch {
    /* ignore */
  }
}

function pruneStaleUserDataArtifacts() {
  if (!app.isPackaged) return;
  pruneOldUserDataBackupFolders();
  pruneOldBrokenDatabaseCopies();
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
  {
    table: "LiveScoreboardState",
    column: "otPlayDirection",
    ddl: "INTEGER NOT NULL DEFAULT 1",
  },
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

  /** Master-scope resolver logs (`masters-training-mode.ts`); default on for desktop, opt out with MATBEAST_DEBUG_MASTER_SCOPE=0. */
  const masterScopeDebugRaw = String(process.env.MATBEAST_DEBUG_MASTER_SCOPE ?? "").trim().toLowerCase();
  const matbeastDebugMasterScope =
    masterScopeDebugRaw === "0" || masterScopeDebugRaw === "false" ? "0" : "1";

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
        MATBEAST_DEBUG_MASTER_SCOPE: matbeastDebugMasterScope,
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

/**
 * Windows: the HWND can be foreground while Chromium never receives keyboard
 * routing — inputs look focused but keys are dead until Alt+Tab. Nudging
 * `webContents.focus()` after the OS activation pass fixes title-bar clicks
 * that otherwise never reach the renderer.
 */
function scheduleMainWebContentsKeyboardFocus() {
  setImmediate(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.isFocused()) return;
      mainWindow.webContents.focus();
    } catch {
      /* ignore */
    }
  });
}

/** Like {@link scheduleMainWebContentsKeyboardFocus} but skips `isFocused()` so the renderer can recover keyboard routing while the window already appears active (Windows dead-keys bug). */
function forceMainWebContentsKeyboardFocus() {
  setImmediate(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.focus();
    } catch {
      /* ignore */
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

  mainWindow.on("focus", scheduleMainWebContentsKeyboardFocus);
  mainWindow.on("move", scheduleRepositionOverlayOutputs);
  mainWindow.on("resize", scheduleRepositionOverlayOutputs);

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

/**
 * Place overlay output windows on the **primary** display at native broadcast
 * resolution (1920×1080). Operators run the dashboard wherever they want; the
 * scoreboard / bracket capture targets stay on the main screen so frame
 * subscription / external capture always finds them at a known position and
 * resolution. Operators Alt+Tab between scoreboard and bracket overlay since
 * both windows occupy the same 1920×1080 region.
 */
function pickTargetDisplayForOverlays() {
  try {
    return screen.getPrimaryDisplay();
  } catch {
    return screen.getPrimaryDisplay();
  }
}

let overlayRepositionTimer = null;
function scheduleRepositionOverlayOutputs() {
  if (overlayRepositionTimer) clearTimeout(overlayRepositionTimer);
  overlayRepositionTimer = setTimeout(() => {
    overlayRepositionTimer = null;
    repositionAllOverlayWindows();
  }, 200);
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

/**
 * Scoreboard + bracket overlays both occupy the same broadcast-native
 * **physical** 1920×1080 region on the primary display. They overlap fully —
 * the operator Alt+Tabs between them.
 *
 * Electron sizes BrowserWindows in DIPs (Device Independent Pixels), so on a
 * Windows display running 150% scaling (typical on 2560×1600+ laptops) a
 * naive `width: 1920` renders as 1920×1.5 = 2880 *physical* pixels and the
 * window doesn't fit on the screen. Dividing by `display.scaleFactor` makes
 * the *physical* backing surface land on exactly 1920×1080, which is also
 * what `webContents.beginFrameSubscription` emits to NDI: pixel-accurate
 * broadcast resolution regardless of the operator's display DPI.
 *
 * The renderer's CSS viewport then becomes `1920/sf × 1080/sf` (e.g.
 * 1280×720 at 150%); the existing `transform: scale()` in `overlay-client.tsx`
 * fits the 1920×1080 design canvas inside it, and `devicePixelRatio = sf`
 * handles glyph / SVG rasterization at full physical resolution so quality
 * doesn't degrade.
 */
function getScoreboardAndBracketBounds(display) {
  const bounds = display.bounds;
  const sf = display.scaleFactor || 1;
  const widthDIP = Math.max(1, Math.round(OVERLAY_NATIVE_W / sf));
  const heightDIP = Math.max(1, Math.round(OVERLAY_NATIVE_H / sf));
  const x = Math.round(bounds.x + Math.max(0, (bounds.width - widthDIP) / 2));
  const y = Math.round(bounds.y + Math.max(0, (bounds.height - heightDIP) / 2));
  const win = { x, y, width: widthDIP, height: heightDIP };
  return {
    scoreboard: { ...win },
    bracket: ENABLE_BRACKET_OVERLAY_WINDOW ? { ...win } : null,
  };
}

function repositionAllOverlayWindows() {
  try {
    const td = pickTargetDisplayForOverlays();
    const layout = getScoreboardAndBracketBounds(td);
    const sb = scoreboardOverlayWindow;
    if (sb && !sb.isDestroyed()) {
      sb.setBounds(layout.scoreboard);
      if (typeof sb.showInactive === "function") sb.showInactive();
      else sb.show();
    }
    if (ENABLE_BRACKET_OVERLAY_WINDOW && layout.bracket) {
      const br = bracketOverlayWindow;
      if (br && !br.isDestroyed()) {
        br.setBounds(layout.bracket);
        if (typeof br.showInactive === "function") br.showInactive();
        else br.show();
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Send the main dashboard window back to the top of the z-order. Called after
 * showing / repositioning an overlay output window so the operator's UI stays
 * visually in front. Deferred via `setTimeout(0)` because Chromium is still
 * resolving focus / paint state from the overlay's `showInactive()` and a
 * synchronous `moveTop()` can race with that and strand keyboard input on
 * the dashboard until Alt+Tab. `forceMainWebContentsKeyboardFocus()` recovers
 * the renderer-side focus afterward.
 */
function ensureMainWindowOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setTimeout(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (typeof mainWindow.moveTop === "function") {
        mainWindow.moveTop();
      }
      forceMainWebContentsKeyboardFocus();
    } catch {
      /* ignore */
    }
  }, 0);
}

/**
 * Overlay output window(s). Scoreboard always; bracket only when {@link ENABLE_BRACKET_OVERLAY_WINDOW}.
 * Each loads `/overlay?outputScene=…` so dashboard preview never switches these via broadcast.
 */
function createOverlayWindowForRole(role) {
  const existing = role === "bracket" ? bracketOverlayWindow : scoreboardOverlayWindow;
  if (existing && !existing.isDestroyed()) {
    return;
  }

  const targetDisplay = pickTargetDisplayForOverlays();
  const layout = getScoreboardAndBracketBounds(targetDisplay);
  const b =
    role === "bracket" && layout.bracket ? layout.bracket : layout.scoreboard;

  /**
   * Per-role chrome:
   *
   * - **Scoreboard** is **transparent** so the graphic preserves alpha for
   *   future built-in NDI capture and external compositors / chroma key
   *   workflows. Windows does not support `transparent: true` together with
   *   `frame: true` (the layered client area suppresses native chrome), so
   *   the scoreboard window is necessarily chrome-less. The renderer paints
   *   its own visible inset frame via `OVERLAY_OUTPUT_FRAME_STYLE`.
   *
   * - **Bracket** is **opaque** with the standard Windows title bar and a
   *   black background. The bracket graphic is fully solid so transparency
   *   buys nothing, and the visible Windows frame (title, minimize, close)
   *   is friendlier for the operator.
   *
   * Both windows are focusable (default) and listed in the taskbar /
   * Alt+Tab. `showInactive()` (below) and `ensureMainWindowOnTop()` keep
   * them behind the dashboard at open / reposition time so the operator
   * stays in their primary UI.
   */
  const isScoreboard = role !== "bracket";
  const win = new BrowserWindow({
    title: role === "bracket" ? "BRACKETOVERLAY" : "SCOREBOARDOVERLAY",
    icon: appIconPath,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 640,
    minHeight: 360,
    transparent: isScoreboard,
    frame: !isScoreboard,
    thickFrame: !isScoreboard && process.platform === "win32",
    backgroundColor: isScoreboard ? undefined : "#000000",
    autoHideMenuBar: true,
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      /**
       * Output overlay windows never receive user clicks (they exist behind
       * the dashboard for capture / NDI). Without this flag Chromium's
       * autoplay policy blocks the bracket music loop until a gesture
       * occurs in that window — which never happens. The scoreboard window
       * gets it too so future timer-cue audio can autoplay when the audio
       * engine moves into that overlay (per the planned Option A).
       */
      autoplayPolicy: "no-user-gesture-required",
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

  /**
   * Same as the main window: Next metadata sets document title to "Mat Beast Scoreboard",
   * which Chromium forwards to the native title — both output windows looked identical.
   * Keep stable, scene-specific titles for Alt+Tab / NDI source lists.
   */
  const overlayLockedTitle =
    role === "bracket" ? "Mat Beast — Bracket output" : "Mat Beast — Scoreboard output";
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    if (win.isDestroyed()) return;
    win.setTitle(overlayLockedTitle);
  });

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    repositionAllOverlayWindows();
    if (typeof win.showInactive === "function") {
      win.showInactive();
    } else {
      win.show();
    }
    /**
     * Keep the dashboard visually on top after opening an overlay so the
     * operator stays in their primary UI. `ensureMainWindowOnTop()` defers
     * `moveTop()` to next tick to avoid the historical Chromium focus race
     * where `<input>` fields on the dashboard could lose keyboard routing
     * until Alt+Tab.
     */
    ensureMainWindowOnTop();
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
 * NDI offscreen-rendering smoke test. Builds an offscreen `BrowserWindow` for
 * the scoreboard scene, captures ~5 seconds of frames at 30 fps, and writes
 * sampled PNGs to `<userData>/ndi-test/<timestamp>/`. Used to validate the
 * offscreen → frame-subscription path independent of any NDI library before
 * v0.9.22 wires up `grandiose`. See `electron/ndi-smoke.js`.
 *
 * Surfaces a dialog at the end so the operator confirms the capture without
 * hunting through DevTools.
 */
async function runNdiOffscreenSmokeTest() {
  if (!appUrl) {
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "NDI smoke test",
      message: "Bundled server URL is not ready yet.",
      detail: "Wait for the dashboard to finish loading and try again.",
      buttons: ["OK"],
    });
    return;
  }
  const userDataDir = app.getPath("userData");
  const preloadPath = path.join(__dirname, "preload.js");
  appendUpdaterLog(`${nowIso()}  ndi-smoke: starting (appUrl=${appUrl})\n`);
  let result;
  try {
    result = await runOffscreenSmokeTest({
      appUrl,
      userDataDir,
      preloadPath,
      onLog: (line) => appendUpdaterLog(`${nowIso()}  ${line}\n`),
    });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }
  appendUpdaterLog(`${nowIso()}  ndi-smoke: finished ${JSON.stringify(result)}\n`);
  if (result.ok) {
    void dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "NDI smoke test complete",
      message: `Captured ${result.framesCaptured} frames in ${result.recordingDurationMs} ms (${result.observedFps} fps)`,
      detail:
        `Frames during warmup: ${result.framesDuringWarmup}\n` +
        `PNGs written: ${result.pngsWritten}\n` +
        `Output folder: ${result.outputDir}\n\n` +
        "The folder should already be open in Explorer. Open any frame-NN.png " +
        "to verify the offscreen renderer produced a 1920×1080 scoreboard frame.",
      buttons: ["OK"],
    });
  } else {
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "NDI smoke test failed",
      message: "Offscreen capture did not complete.",
      detail: result.error || "Unknown error",
      buttons: ["OK"],
    });
  }
}

/**
 * Start the live NDI feed for a scene (currently only "scoreboard"; the
 * bracket feed is scaffolded in `ndi-feed.js` but not wired to a menu
 * item until v0.9.30). Surfaces success/failure via a dialog so the
 * operator gets immediate feedback in NDI Studio Monitor or vMix.
 *
 * Called from the menu and (in v0.9.30+) from auto-start at boot when
 * `desktopPreferences.ndiAutoStart[scene]` is true. Today no auto-start —
 * operator toggles each session manually.
 */
async function toggleNdiFeed(scene) {
  if (!appUrl) {
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "NDI",
      message: "Bundled server URL is not ready yet.",
      detail: "Wait for the dashboard to finish loading and try again.",
      buttons: ["OK"],
    });
    return;
  }
  const log = (line) => appendUpdaterLog(`${nowIso()}  ${line}\n`);
  const isRunning = ndiFeed.isFeedRunning(scene);
  if (isRunning) {
    log(`ndi-feed: stopping ${scene}`);
    const stopResult = ndiFeed.stopNdiFeed(scene, log);
    log(`ndi-feed: stop result ${JSON.stringify(stopResult)}`);
    refreshApplicationMenu();
    broadcastNdiState();
    void dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "NDI source stopped",
      message: `"${ndiFeed.getDefaultSourceName(scene)}" is no longer broadcasting.`,
      detail: "Receivers (NDI Studio Monitor, OBS, vMix, etc.) will lose the source within ~3 seconds.",
      buttons: ["OK"],
    });
    return;
  }
  log(`ndi-feed: starting ${scene}`);
  const preloadPath = path.join(__dirname, "preload.js");
  let result;
  try {
    result = await ndiFeed.startNdiFeed({
      scene,
      appUrl,
      preloadPath,
      userDataDir: app.getPath("userData"),
      onLog: log,
    });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }
  log(`ndi-feed: start result ${JSON.stringify(result)}`);
  refreshApplicationMenu();
  broadcastNdiState();
  if (result.ok) {
    void dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "NDI source running",
      message: `"${ndiFeed.getDefaultSourceName(scene)}" is now broadcasting.`,
      detail:
        "Open NDI Studio Monitor (or vMix / OBS) on this network and the source " +
        "should appear within ~3 seconds. Use the same menu entry to stop it.\n\n" +
        `NDI runtime: ${ndiFeed.getAllStatuses().ndi.ndiVersion || "unknown"}`,
      buttons: ["OK"],
    });
  } else {
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "NDI source failed to start",
      message: "Could not start the NDI sender.",
      detail:
        (result.error || "Unknown error") +
        (result.ndiStatus
          ? `\n\nNDI status: ${JSON.stringify(result.ndiStatus, null, 2)}`
          : ""),
      buttons: ["OK"],
    });
  }
}

/**
 * v0.9.32: Launch the BGRA test-pattern sender.
 *
 * v0.9.31 diagnostics confirmed every layer of our scoreboard / bracket
 * pipeline is healthy — buffers contain real BGRA pixel data, sender
 * accepts every frame, sources appear in receivers' source lists — yet
 * receivers display BLACK when subscribing. To isolate whether the bug
 * is in (a) our React content / Electron BGRA conventions or (b) the
 * NDI runtime / firewall / network layer, this entry skips both the
 * offscreen window and React entirely. It generates a synthetic 8-bar
 * SMPTE color pattern with a moving white square at full opacity
 * (alpha=255 everywhere, no premultiplied-alpha math) and pushes it
 * through `sender.video()` via grandiose at 30 fps for 30 seconds
 * under the source name "Mat Beast Test Pattern".
 *
 * Outcome → diagnosis:
 *   - Receivers show the bars + moving square → bug is specific to our
 *     React-rendered content (premultiplied alpha is the leading
 *     hypothesis; `transparent: true` on the offscreen `BrowserWindow`
 *     hands us premultiplied BGRA, NDI may treat that as straight alpha
 *     and double-multiply).
 *   - Receivers still show nothing → bug is below the buffer layer.
 *     Almost certainly Windows Firewall blocking NDI's TCP video-
 *     delivery channel, or the NDI 5.5.2.0 runtime in grandiose has a
 *     known incompatibility with current NDI Tools / OBS NDI plugin.
 *
 * The dialog informs the operator what to look for so they can answer
 * us in one round-trip.
 */
async function runNdiTestPattern() {
  if (ndiTestPattern.isTestPatternRunning()) {
    void dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "NDI test pattern",
      message: "The test pattern is already running.",
      detail:
        "It will stop automatically after 30 seconds. Use this menu entry " +
        "again afterwards to start a fresh run.",
      buttons: ["OK"],
    });
    return;
  }
  void dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "NDI test pattern starting",
    message: "Sending an 8-bar SMPTE BGRA test pattern for 30 seconds.",
    detail:
      'Open NDI Studio Monitor (or OBS / vMix), pick "Mat Beast Test Pattern" ' +
      "from the source list, and report back:\n\n" +
      "  - If you see vertical color bars (white, yellow, cyan, green, magenta, " +
      "red, blue, black) with a white square sliding across the bottom, the NDI " +
      "pipeline works end-to-end. The scoreboard / bracket bug is specific to " +
      "our React content (likely premultiplied-alpha BGRA) and we'll fix it next.\n\n" +
      "  - If you see nothing (or only the source name with a black preview), " +
      "the issue is below our pipeline — Windows Firewall blocking NDI's TCP " +
      "delivery, an NDI runtime version mismatch, or a multi-NIC binding " +
      "issue. Different fix path.",
    buttons: ["OK"],
  });
  const log = (line) => appendUpdaterLog(`${nowIso()}  ${line}\n`);
  log("ndi-test-pattern: launching");
  let result;
  try {
    result = await ndiTestPattern.runTestPattern({ onLog: log, durationMs: 30_000 });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }
  log(`ndi-test-pattern: finished ${JSON.stringify(result)}`);
  void dialog.showMessageBox(mainWindow, {
    type: result.ok ? "info" : "error",
    title: "NDI test pattern complete",
    message: result.ok
      ? `Sent ${result.framesSent} frames over ${result.durationMs} ms.`
      : "Test pattern failed.",
    detail: result.ok
      ? `Send failures: ${result.sendFailures}\n` +
        (result.lastError ? `Last error: ${result.lastError}\n\n` : "\n") +
        "Reply with which of the two outcomes above you observed."
      : result.error || "Unknown error",
    buttons: ["OK"],
  });
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

/**
 * v0.9.33: Build the `Options ▸ NDI ▸ Network adapter` submenu. The
 * submenu shows:
 *
 *   - Auto-select (prefer Ethernet) — default. Shows the IP it
 *     currently resolves to in the label so the operator can verify
 *     auto-mode picked the right NIC without opening the status panel.
 *   - Per-IP entries grouped roughly by adapter type. APIPA addresses
 *     and likely-virtual NICs are shown but visually de-prioritised
 *     so the operator doesn't accidentally pin to a non-routable IP.
 *   - A "Restart required" hint in the disabled summary line so
 *     newcomers understand why nothing happens immediately after they
 *     click an entry.
 *
 * Clicking any entry persists the choice, writes the config file, and
 * shows a "restart now / later" dialog.
 */
function buildNdiAdapterSubmenu() {
  const adapters = ndiAdapters.enumerateAdapters();
  const preference = desktopPreferences.ndiBindAdapter || { kind: "auto" };
  const autoResolved = ndiAdapters.pickAutoBinding(adapters);
  const isAuto = preference.kind === "auto";
  const items = [];
  items.push({
    label: "Apply takes effect after restart",
    enabled: false,
  });
  items.push({ type: "separator" });
  items.push({
    type: "radio",
    checked: isAuto,
    label: autoResolved
      ? `Auto-select (prefer Ethernet) — currently ${autoResolved.friendlyName} ${autoResolved.ip}`
      : "Auto-select (prefer Ethernet) — no routable adapter found",
    click: () => {
      void confirmAndApplyNdiBindingChange({ kind: "auto" });
    },
  });
  items.push({ type: "separator" });
  if (adapters.length === 0) {
    items.push({
      label: "No network adapters detected",
      enabled: false,
    });
    return items;
  }
  for (const adapter of adapters) {
    const isCurrent =
      preference.kind === "ip" && preference.ip === adapter.ip;
    /** Decorate APIPA / virtual entries so the operator can see at a
     *  glance why these IPs probably won't deliver to remote receivers. */
    const suffix = adapter.isApipa
      ? "  (APIPA / link-local)"
      : adapter.isLikelyVirtual && adapter.type !== "wifi" && adapter.type !== "ethernet"
        ? "  (virtual)"
        : adapter.isLoopback
          ? "  (loopback)"
          : "";
    items.push({
      type: "radio",
      checked: isCurrent && !isAuto,
      label: `${adapter.friendlyName} (${adapter.adapterName}) — ${adapter.ip}${suffix}`,
      click: () => {
        void confirmAndApplyNdiBindingChange({ kind: "ip", ip: adapter.ip });
      },
    });
  }
  return items;
}

/**
 * Persist the new NDI binding, write the config file, refresh the
 * menu, and prompt the operator to restart so `NDIlib_initialize()`
 * picks up the change. If the operator declines we leave the next-
 * launch binding in place — they can also restart later from the
 * dashboard's NDI status pill.
 */
async function confirmAndApplyNdiBindingChange(nextPreference) {
  const previous = desktopPreferences.ndiBindAdapter || { kind: "auto" };
  const same = JSON.stringify(previous) === JSON.stringify(nextPreference);
  desktopPreferences.ndiBindAdapter = normalizeNdiBindAdapter(nextPreference);
  persistDesktopPreferences();
  applySavedNdiBinding();
  refreshApplicationMenu();
  broadcastNdiState();
  if (same) return;
  const adapters = ndiAdapters.enumerateAdapters();
  const resolved = ndiAdapters.resolveBinding(adapters, nextPreference);
  const human = resolved
    ? `${resolved.friendlyName} (${resolved.adapterName}) — ${resolved.ip}`
    : "Auto-select (no routable adapter found)";
  const choice = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "NDI binding updated",
    message: "Restart Mat Beast Scoreboard to apply the new NDI binding?",
    detail:
      `New binding: ${human}\n\n` +
      "The NDI runtime reads its network configuration only when the app " +
      "starts. Without a restart, the new binding will take effect the " +
      "next time you launch Mat Beast Scoreboard.",
    buttons: ["Restart now", "Restart later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response === 0) {
    try {
      ndiFeed.stopAllNdiFeeds(/* onLog */ undefined);
    } catch {
      /* ignore */
    }
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
  }
}

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
        { type: "separator" },
        {
          /**
           * v0.9.21–0.9.28: smoke-test only (no real NDI library).
           * v0.9.29: scoreboard feed is live via `grandiose`. Toggle item
           *   flips between "Start" and "Stop" labels.
           * v0.9.30: bracket feed wired up alongside scoreboard (one
           *   toggle per scene, both reuse `ndi-feed.js`); per-frame
           *   buffer-vs-getSize diagnostic in `ndi-sender.js`; first-30-
           *   frames warmup so receivers don't latch onto a partially-
           *   hydrated React tree.
           * v0.9.31+: source-name editor, frame-rate selector, "Show
           *   visible monitor windows" checkbox, persisted auto-start
           *   in desktopPreferences.
           */
          label: "NDI",
          submenu: [
            /**
             * v0.9.33: Network-adapter picker. The NDI runtime
             * announces sources on every NIC by default — including
             * APIPA (169.254.*) addresses on disconnected Ethernet
             * adapters and Wi-Fi Direct virtual adapters — which
             * causes "source visible but blank preview" on remote
             * receivers. Pinning to one IP via `ndi-config.v1.json`
             * fixes it. Submenu is rebuilt every menu refresh so the
             * IPs reflect whatever DHCP currently has.
             */
            {
              label: "Network adapter",
              submenu: buildNdiAdapterSubmenu(),
            },
            { type: "separator" },
            {
              label: ndiFeed.isFeedRunning("scoreboard")
                ? `Stop "${ndiFeed.getDefaultSourceName("scoreboard")}"`
                : `Start "${ndiFeed.getDefaultSourceName("scoreboard")}" NDI source`,
              click: () => {
                void toggleNdiFeed("scoreboard");
              },
            },
            {
              label: ndiFeed.isFeedRunning("bracket")
                ? `Stop "${ndiFeed.getDefaultSourceName("bracket")}"`
                : `Start "${ndiFeed.getDefaultSourceName("bracket")}" NDI source`,
              click: () => {
                void toggleNdiFeed("bracket");
              },
            },
            { type: "separator" },
            {
              /**
               * v0.9.32 diagnostic: send a synthetic SMPTE color-bar test
               * pattern (no React, no offscreen window) so the operator can
               * tell us whether NDI receivers display known-good frames.
               * If yes → bug is in our React content. If no → bug is in
               * Windows Firewall / NDI runtime / NIC binding. Definitive
               * one-round-trip diagnostic.
               */
              label: ndiTestPattern.isTestPatternRunning()
                ? `"${require("./ndi-test-pattern.js").TP_NAME}" running…`
                : "Send BGRA test pattern (30s)",
              enabled: !ndiTestPattern.isTestPatternRunning(),
              click: () => {
                void runNdiTestPattern();
              },
            },
            {
              label: "Run offscreen smoke test (5s)",
              click: () => {
                void runNdiOffscreenSmokeTest();
              },
            },
          ],
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
      submenu: [
        {
          /**
           * Recreate the scoreboard output overlay if it was closed, or
           * re-snap it to native 1920×1080 on the primary display. Always
           * shown behind the dashboard via `ensureMainWindowOnTop()`.
           */
          label: "Open Scoreboard Overlay",
          click: () => {
            createOverlayWindowForRole("scoreboard");
            repositionAllOverlayWindows();
            ensureMainWindowOnTop();
          },
        },
        {
          label: "Open Bracket Overlay",
          click: () => {
            createOverlayWindowForRole("bracket");
            repositionAllOverlayWindows();
            ensureMainWindowOnTop();
          },
        },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
        { role: "togglefullscreen" },
      ],
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
      scheduleMainWebContentsKeyboardFocus();
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
  /**
   * Apply the operator's saved NDI binding BEFORE anything triggers
   * `require("grandiose")`. The NDI runtime reads `NDI_CONFIG_DIR` at
   * `NDIlib_initialize()` time exactly once per process, so setting it
   * later in the session has no effect — the operator would have to
   * restart the app for the change to take. This is the entire reason
   * the NDI > Network adapter menu shows a "Restart required" prompt.
   */
  try {
    const apply = applySavedNdiBinding();
    appendUpdaterLog(
      `${nowIso()}  ndi-bootstrap: applied binding ${JSON.stringify({
        configDir: apply.result?.configDir || null,
        configPath: apply.result?.configPath || null,
        ip: apply.result?.ip || null,
        preference: desktopPreferences.ndiBindAdapter,
        adapter: apply.resolved
          ? `${apply.resolved.friendlyName} (${apply.resolved.adapterName})`
          : null,
      })}\n`,
    );
  } catch (err) {
    appendUpdaterLog(
      `${nowIso()}  ndi-bootstrap: failed ${String(err?.message || err)}\n`,
    );
  }
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

  boot.finally(async () => {
  await maybeClearStaleRendererCachesOnUpgrade();
  pruneStaleUserDataArtifacts();
  configureAutoUpdater();

  ipcMain.handle("overlay:open", () => {
    createOverlayWindows();
    repositionAllOverlayWindows();
    return { ok: true };
  });

  registerBracketMusicProtocol();

  /**
   * Read the operator's persisted bracket-music configuration. Called on
   * mount by the dashboard and by the bracket overlay so both can render
   * the right initial state without waiting for the next push.
   */
  ipcMain.handle("bracket-music:get-state", () => bracketMusicSnapshot());

  /**
   * Open a native file picker, persist the selected audio file, and push
   * the new state to every renderer. `canceled: true` if the operator
   * dismissed the dialog — caller leaves the existing track untouched.
   */
  ipcMain.handle("bracket-music:choose-file", async () => {
    try {
      /**
       * Resolving the parent window:
       *   - Prefer the dashboard (`mainWindow`) explicitly so the dialog
       *     reliably parents to a visible, non-destroyed window.
       *   - `BrowserWindow.getFocusedWindow()` can return `null` when the
       *     popover-button click stole focus on Windows (the dropdown is
       *     a transient element that loses focus before the IPC fires);
       *     a `null` parent silently degrades to a non-modal dialog
       *     that some Windows configurations render off-screen, which
       *     is exactly the "nothing happens" symptom operators reported.
       */
      const win =
        mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : BrowserWindow.getFocusedWindow();
      let defaultDir;
      try {
        defaultDir = desktopPreferences.bracketMusicFilePath
          ? path.dirname(desktopPreferences.bracketMusicFilePath)
          : app.getPath("music");
      } catch {
        /** Some Windows profiles redirect "Music" to a path that fails the
         *  shell folder lookup; fall back to the user's home so the dialog
         *  always has a valid `defaultPath`. */
        defaultDir = app.getPath("home");
      }
      const options = {
        title: "Choose bracket overlay music",
        defaultPath: defaultDir,
        properties: ["openFile"],
        filters: BRACKET_MUSIC_AUDIO_FILTERS,
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths?.[0]) {
        return { ok: false, canceled: true };
      }
      const next = result.filePaths[0];
      desktopPreferences.bracketMusicFilePath = next;
      persistDesktopPreferences();
      broadcastBracketMusicState();
      return { ok: true, state: bracketMusicSnapshot() };
    } catch (err) {
      console.error("[matbeast] bracket-music:choose-file failed:", err);
      return {
        ok: false,
        error: String(err?.message || err),
      };
    }
  });

  /** Set track to NONE — operator's "no music" choice. */
  ipcMain.handle("bracket-music:clear-file", () => {
    desktopPreferences.bracketMusicFilePath = null;
    persistDesktopPreferences();
    broadcastBracketMusicState();
    return { ok: true, state: bracketMusicSnapshot() };
  });

  /**
   * Use the bundled "DEFAULT" track. The audio file is shipped under
   * `<resources>/default-music/tale.mp3` via `extraResources`. Returns
   * `{ ok: false, error }` if the file is missing on disk (e.g.
   * antivirus quarantined it post-install) so the dashboard can show
   * a structured error instead of silently selecting nothing.
   */
  ipcMain.handle("bracket-music:use-default", () => {
    const def = getBundledDefaultBracketMusicPath();
    if (!def) {
      return {
        ok: false,
        error: "Default bracket music track is not installed.",
      };
    }
    desktopPreferences.bracketMusicFilePath = def;
    persistDesktopPreferences();
    broadcastBracketMusicState();
    return { ok: true, state: bracketMusicSnapshot() };
  });

  ipcMain.handle("bracket-music:set-playing", (_event, payload) => {
    const next = Boolean(payload && payload.playing);
    if (desktopPreferences.bracketMusicPlaying === next) {
      return { ok: true, state: bracketMusicSnapshot() };
    }
    desktopPreferences.bracketMusicPlaying = next;
    persistDesktopPreferences();
    broadcastBracketMusicState();
    return { ok: true, state: bracketMusicSnapshot() };
  });

  ipcMain.handle("bracket-music:set-monitor", (_event, payload) => {
    const next = Boolean(payload && payload.monitor);
    if (desktopPreferences.bracketMusicMonitor === next) {
      return { ok: true, state: bracketMusicSnapshot() };
    }
    desktopPreferences.bracketMusicMonitor = next;
    persistDesktopPreferences();
    broadcastBracketMusicState();
    return { ok: true, state: bracketMusicSnapshot() };
  });

  /**
   * v0.9.33: NDI network-binding IPC. Returns the same snapshot the
   * Overlay-card status pill subscribes to via `matbeast:ndi:state`,
   * so the renderer can render the initial value synchronously on
   * mount before the first push event arrives.
   */
  ipcMain.handle("ndi:get-state", () => {
    return buildNdiStateSnapshot();
  });

  /**
   * Persist the operator's adapter choice and (asynchronously) prompt
   * for app restart since `NDI_CONFIG_DIR` only takes effect at
   * `NDIlib_initialize()` time.
   *
   * Payload: same shape `desktopPreferences.ndiBindAdapter` accepts —
   *   - `{ kind: "auto" }`
   *   - `{ kind: "ip", ip: "192.168.0.20" }`
   *   - `{ kind: "adapter", adapterName: "Ethernet" }`
   *
   * Returns `{ ok, willTakeEffectAfterRestart, snapshot }` so the
   * dashboard can show inline confirmation before the operator
   * chooses Restart now / Restart later.
   */
  ipcMain.handle("ndi:set-binding", (_event, payload) => {
    try {
      const next = normalizeNdiBindAdapter(payload);
      const previous = desktopPreferences.ndiBindAdapter || { kind: "auto" };
      const same = JSON.stringify(previous) === JSON.stringify(next);
      desktopPreferences.ndiBindAdapter = next;
      persistDesktopPreferences();
      /** Write the config file immediately even though it won't bind
       *  until the next launch — that way an operator who CLI-relaunches
       *  with `app.relaunch()` from the menu picks up the new binding
       *  without us having to re-run `applyBinding` separately. */
      applySavedNdiBinding();
      const snapshot = broadcastNdiState();
      refreshApplicationMenu();
      return {
        ok: true,
        willTakeEffectAfterRestart: !same,
        snapshot,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  /** Restart the app so a new `NDI_CONFIG_DIR` / config-file binding
   *  takes effect. Called from the dashboard's NDI status pill after
   *  the operator picks a new adapter. */
  ipcMain.handle("ndi:relaunch-for-binding", () => {
    try {
      ndiFeed.stopAllNdiFeeds(/* onLog */ undefined);
    } catch {
      /* ignore — relaunch is the actual fix */
    }
    /** Defer one tick so the IPC reply gets back to the renderer
     *  before Electron tears down the renderer process. */
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
    return { ok: true };
  });

  /** Push initial state once windows are ready, then refresh on a
   *  5 s interval to catch OS-level NIC changes. */
  startNdiStateRefreshTimer();
  setTimeout(() => {
    broadcastNdiState();
  }, 1500);

  /**
   * v0.9.34: NDI audio fan-in. The offscreen NDI bracket renderer's
   * AudioWorklet PCM tap pushes 1024-sample planar Float32 frames here
   * via fire-and-forget `ipcRenderer.send`, and we forward each one to
   * the active sender for that scene. If the feed isn't running yet
   * (audio path can come up before video on mount) the frame is
   * silently dropped — drops are normal at startup, not an error.
   *
   * Diagnostic logging is rate-limited inside `ndi-sender.js`'s
   * `sendNdiAudioFrame` (first 3 frames per sender), so this handler
   * stays cheap on the hot path.
   */
  ipcMain.on("ndi-audio:push", (_event, msg) => {
    if (!msg || typeof msg !== "object") return;
    const scene = msg.scene === "bracket" ? "bracket" : msg.scene === "scoreboard" ? "scoreboard" : null;
    if (!scene) return;
    const payload = msg.payload;
    if (!payload || typeof payload !== "object") return;
    const log = (line) => appendUpdaterLog(`${nowIso()}  ${line}\n`);
    try {
      ndiFeed.pushAudioForScene(scene, payload, log);
    } catch (err) {
      log(
        `[ndi-audio] push failed for scene=${scene}: ${String(err?.message || err)}`,
      );
    }
  });

  try {
    const onScreensChanged = () => scheduleRepositionOverlayOutputs();
    screen.on("display-metrics-changed", onScreensChanged);
    screen.on("display-added", onScreensChanged);
    screen.on("display-removed", onScreensChanged);
  } catch {
    /* ignore */
  }
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
        /** Deferred so we run after Windows foreground bookkeeping (see {@link scheduleMainWebContentsKeyboardFocus}). */
        scheduleMainWebContentsKeyboardFocus();
      }
    } catch {
      /* ignore */
    }
    return { ok: true };
  });

  ipcMain.handle("app:restore-web-keyboard-focus", async () => {
    try {
      forceMainWebContentsKeyboardFocus();
    } catch {
      /* ignore */
    }
    return { ok: true };
  });

  /**
   * v1.2.9: First-launch password gate persistence. The renderer's
   * `localStorage` is keyed by origin and the bundled Next server
   * picks a fresh loopback port every launch (`getFreeIpv4Port`),
   * so any flag we wrote to `localStorage` was invisible to the
   * next launch's renderer. Persist the unlock flag here under
   * `userData/first-launch-password.json` instead — survives port
   * changes, app updates, and renderer reloads.
   */
  ipcMain.handle("app:get-first-launch-password-unlocked", async () => {
    try {
      const filePath = path.join(
        app.getPath("userData"),
        "first-launch-password.json",
      );
      if (!fs.existsSync(filePath)) return { ok: true, unlocked: false };
      const text = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(text);
      return { ok: true, unlocked: data && data.unlocked === true };
    } catch {
      return { ok: true, unlocked: false };
    }
  });

  ipcMain.handle(
    "app:set-first-launch-password-unlocked",
    async (_event, payload) => {
      try {
        const unlocked = Boolean(payload && payload.unlocked);
        const filePath = path.join(
          app.getPath("userData"),
          "first-launch-password.json",
        );
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          JSON.stringify({ unlocked, savedAt: new Date().toISOString() }, null, 2),
          "utf8",
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    },
  );

  refreshApplicationMenu();
  createMainWindow();
  if (launchEventFile) enqueueOpenEventFile(launchEventFile);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once("did-finish-load", () => {
      sendOptionsMenuAction("autosave-5m", {
        enabled: desktopPreferences.autoSaveEvery5Minutes,
      });
      /**
       * Create output overlay windows after the main shell has loaded so the
       * bundled Next server is already serving `/overlay` (startup race when
       * overlays were created synchronously with the main window).
       */
      createOverlayWindows();
    });
  } else {
    createOverlayWindows();
  }
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
  /**
   * Stop NDI feeds first, before the offscreen `BrowserWindow`s would be
   * torn down by `closeOverlayWindows()` (NDI feeds own their own
   * offscreen windows but the order matters for clean log output and
   * avoids "send to destroyed webContents" warnings during teardown).
   * grandiose's `NDIlib_send_destroy` runs on JS GC and is best-effort
   * here — receivers detect the dropout within ~3 s either way.
   */
  try {
    ndiFeed.stopAllNdiFeeds((line) => appendUpdaterLog(`${nowIso()}  ${line}\n`));
  } catch (err) {
    appendUpdaterLog(`${nowIso()}  ndi-feed: stopAllNdiFeeds threw ${String(err?.message || err)}\n`);
  }
  closeOverlayWindows();
  if (bundledServerProcess && !bundledServerProcess.killed) {
    bundledServerProcess.kill();
    bundledServerProcess = null;
  }
});
