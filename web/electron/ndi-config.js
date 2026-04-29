/**
 * NDI runtime configuration writer (v0.9.33).
 *
 * Background:
 *   `ndi-config.v1.json` is the official Newtek NDI 5+ runtime config
 *   file. Setting `adapters.allowed` to a list of IPs forces every NDI
 *   sender on the machine to announce / stream only on those IPs,
 *   instead of mDNS-broadcasting on every adapter Windows reports.
 *   This is THE professional broadcast solution for the multi-NIC
 *   "source visible but blank preview" symptom.
 *
 *   Default search location is `C:\ProgramData\NDI\ndi-config.v1.json`,
 *   which we deliberately don't touch — that file is system-wide and
 *   would change behaviour for every NDI app on the operator's
 *   machine. Instead we write a per-app config under
 *   `<userData>/ndi-config/ndi-config.v1.json` and point the NDI
 *   runtime at it via the `NDI_CONFIG_DIR` environment variable.
 *
 *   `NDI_CONFIG_DIR` is read by `NDIlib_initialize()` exactly once per
 *   process. We must set it BEFORE `require("grandiose")` triggers
 *   `NDIlib_initialize()`, which means in `main.js` startup before any
 *   NDI menu interaction. The lazy-load contract in
 *   `electron/ndi-sender.js` ensures grandiose isn't pulled in until
 *   the first feed starts, so as long as the env var is set during
 *   `app.whenReady()` we're fine.
 *
 * What this module exposes:
 *   - `getConfigDir(userDataDir)` → absolute path to our config dir
 *   - `getConfigPath(userDataDir)` → absolute path to ndi-config.v1.json
 *   - `applyBinding({ userDataDir, ip })` → write the JSON file (or
 *     remove it for "auto / no binding") and set `process.env
 *     .NDI_CONFIG_DIR`. Returns the resulting state.
 *   - `readCurrentConfig(userDataDir)` → read what's on disk, useful
 *     for diagnostics.
 *
 * Config schema (NDI 5+):
 *   {
 *     "ndi": {
 *       "adapters": {
 *         "allowed": ["10.0.0.20"]
 *       }
 *     }
 *   }
 *
 *   Empty array or missing key = NDI uses default (all adapters).
 *   We support both "binding to one IP" and "no binding" (auto-select)
 *   by writing the file with `["<ip>"]` or removing the file entirely.
 */
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_DIR_NAME = "ndi-config";
const CONFIG_FILE_NAME = "ndi-config.v1.json";

function getConfigDir(userDataDir) {
  return path.join(userDataDir, CONFIG_DIR_NAME);
}

function getConfigPath(userDataDir) {
  return path.join(getConfigDir(userDataDir), CONFIG_FILE_NAME);
}

/**
 * Set the `NDI_CONFIG_DIR` env var so the bundled NDI runtime reads
 * our private config instead of the system-wide one. Must run before
 * grandiose is required for the first time. Safe to call repeatedly
 * — value just gets overwritten with the same string.
 */
function pointNdiAtConfigDir(userDataDir) {
  const dir = getConfigDir(userDataDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore — non-fatal; if mkdir fails NDI just falls back to
       defaults */
  }
  process.env.NDI_CONFIG_DIR = dir;
  return dir;
}

/**
 * Apply (or clear) the binding. If `ip` is a string, write the JSON
 * with `adapters.allowed = [ip]`. If `ip` is null / undefined, delete
 * the JSON so NDI uses default behaviour (all adapters).
 *
 * Always sets `NDI_CONFIG_DIR` so a future binding can be applied
 * without recreating the env var.
 *
 * @param {{ userDataDir: string, ip?: string | null }} opts
 * @returns {{
 *   ok: boolean,
 *   configDir: string,
 *   configPath: string,
 *   ip: string | null,
 *   wroteFile: boolean,
 *   removedFile: boolean,
 *   error?: string,
 * }}
 */
function applyBinding(opts) {
  const userDataDir = opts.userDataDir;
  if (!userDataDir) {
    return {
      ok: false,
      configDir: "",
      configPath: "",
      ip: null,
      wroteFile: false,
      removedFile: false,
      error: "applyBinding: userDataDir is required",
    };
  }
  const configDir = pointNdiAtConfigDir(userDataDir);
  const configPath = getConfigPath(userDataDir);
  const ip = typeof opts.ip === "string" && opts.ip.length > 0 ? opts.ip : null;

  if (ip) {
    const payload = {
      ndi: {
        adapters: {
          allowed: [ip],
        },
      },
    };
    try {
      fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf8");
      return {
        ok: true,
        configDir,
        configPath,
        ip,
        wroteFile: true,
        removedFile: false,
      };
    } catch (err) {
      return {
        ok: false,
        configDir,
        configPath,
        ip,
        wroteFile: false,
        removedFile: false,
        error: String(err?.message || err),
      };
    }
  }

  /** No binding — let NDI use default behaviour by removing our config
   *  file. (We keep `NDI_CONFIG_DIR` set so NDI looks in our dir; the
   *  absence of `ndi-config.v1.json` makes NDI fall back to its
   *  built-in defaults.) */
  let removedFile = false;
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      removedFile = true;
    }
  } catch (err) {
    return {
      ok: false,
      configDir,
      configPath,
      ip: null,
      wroteFile: false,
      removedFile: false,
      error: String(err?.message || err),
    };
  }
  return {
    ok: true,
    configDir,
    configPath,
    ip: null,
    wroteFile: false,
    removedFile,
  };
}

function readCurrentConfig(userDataDir) {
  const configPath = getConfigPath(userDataDir);
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  applyBinding,
  pointNdiAtConfigDir,
  readCurrentConfig,
  getConfigDir,
  getConfigPath,
};
