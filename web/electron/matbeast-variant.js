/**
 * Runtime variant detection for the Electron main process.
 *
 * The build pipeline writes a tiny JSON marker to
 *   <resources>/variant.json
 * when `MATBEAST_VARIANT=demo` is set. In packaged builds we read it from
 * `process.resourcesPath`; in development we fall back to the env var.
 *
 * Variant values are a closed enum:
 *   "production" -- default; full cloud sync, auto-update on.
 *   "demo"       -- local-only, no cloud UI, no auto-update, seeded DB.
 *
 * Any consumer should treat unknown values as "production" to stay safe.
 */

const fs = require("node:fs");
const path = require("node:path");

let cached = null;

/**
 * Read variant from disk marker or env. Cached after first call so we
 * don't re-read the file on every call.
 */
function getVariant() {
  if (cached) return cached;
  let variant = "production";

  try {
    const envVariant = String(process.env.MATBEAST_VARIANT ?? "").trim();
    if (envVariant === "demo") variant = "demo";
  } catch {
    // ignore
  }

  const resourcesDir = process.resourcesPath;
  if (resourcesDir) {
    const markerPath = path.join(resourcesDir, "variant.json");
    try {
      if (fs.existsSync(markerPath)) {
        const text = fs.readFileSync(markerPath, "utf8");
        const json = JSON.parse(text);
        if (json && typeof json.variant === "string" && json.variant === "demo") {
          variant = "demo";
        }
      }
    } catch {
      // marker missing or corrupted -> fall back to env / production
    }
  }

  cached = variant === "demo" ? "demo" : "production";
  return cached;
}

function isDemo() {
  return getVariant() === "demo";
}

module.exports = { getVariant, isDemo };
