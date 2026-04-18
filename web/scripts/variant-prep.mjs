/**
 * Per-variant build preparation.
 *
 * Runs early in `desktop:build` / `desktop:build:demo` and writes two
 * artifacts that electron-builder then bundles into the installer via
 * `extraResources`:
 *
 *   build/variant.json             -- {"variant":"production"} or {"variant":"demo"}
 *   build/demo-seed/sample-events/ -- bundled .matb sample events (demo only)
 *
 * For the demo variant, this script also copies your current local
 * production SQLite (`%APPDATA%\matbeastscore\data\matbeast.db`) to
 * `build/default-data/matbeast-template-demo.db`, then strips every
 * table back to just MasterTeamName + MasterPlayerProfile. The rest of
 * the build pipeline picks up that template (see
 * prepare-desktop-db.mjs's variant branching).
 *
 * For the production variant this script no-ops beyond writing the
 * variant marker and ensuring `build/demo-seed/sample-events/` exists
 * as an empty directory (so electron-builder's `extraResources` glob
 * doesn't explode).
 *
 * Triggered by setting MATBEAST_VARIANT=demo (anything else falls
 * back to "production").
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const buildDir = path.join(webRoot, "build");

const envVariant = String(process.env.MATBEAST_VARIANT ?? "").trim();
const variant = envVariant === "demo" ? "demo" : "production";

fs.mkdirSync(buildDir, { recursive: true });

// --------------------------------------------------------------------
// 1. Variant marker
// --------------------------------------------------------------------

const markerPath = path.join(buildDir, "variant.json");
fs.writeFileSync(
  markerPath,
  JSON.stringify({ variant, preparedAt: new Date().toISOString() }, null, 2) + "\n",
  "utf8",
);
process.stdout.write(`[variant-prep] wrote ${markerPath} (variant=${variant})\n`);

// --------------------------------------------------------------------
// 2. Ensure demo-seed dirs exist (electron-builder globs need them)
// --------------------------------------------------------------------

const demoSeedRoot = path.join(buildDir, "demo-seed");
const sampleEventsDir = path.join(demoSeedRoot, "sample-events");
fs.mkdirSync(sampleEventsDir, { recursive: true });

if (variant !== "demo") {
  // Production build: wipe any stale demo seed content so we don't
  // accidentally ship sample events into production installers.
  for (const leftover of fs.readdirSync(sampleEventsDir)) {
    fs.rmSync(path.join(sampleEventsDir, leftover), { recursive: true, force: true });
  }
  process.stdout.write(
    "[variant-prep] production build -> sample-events/ reset to empty\n",
  );
  process.exit(0);
}

// --------------------------------------------------------------------
// 3. Demo variant: copy production SQLite, strip to masters-only, and
//    leave it at build/default-data/matbeast-template-demo.db for
//    prepare-desktop-db.mjs to promote into the template.
// --------------------------------------------------------------------

/**
 * The installed production app writes its SQLite to the Electron
 * `userData` folder, which resolves to `%LOCALAPPDATA%\MatBeastScore`
 * under `electron-builder`'s NSIS packaging. The folder name comes
 * from the Electron `app.getPath("userData")` default for the current
 * `productName` ("Mat Beast Scoreboard" -> "MatBeastScore" with
 * spaces stripped). The dev-only `%APPDATA%\matbeastscore` folder
 * (note lowercase + no spaces) is a scratch location used by some
 * earlier build scripts and is NOT the live app DB.
 */
const prodDbPath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "MatBeastScore",
  "matbeast.db",
);

if (!fs.existsSync(prodDbPath)) {
  process.stderr.write(
    `[variant-prep] ERROR: demo variant needs your installed production SQLite at\n` +
      `    ${prodDbPath}\n` +
      `but it does not exist. Install the production build at least once and\n` +
      `launch it so the masters tables get populated, then re-run\n` +
      `'npm run desktop:build:demo'.\n`,
  );
  process.exit(1);
}

const defaultDataDir = path.join(buildDir, "default-data");
fs.mkdirSync(defaultDataDir, { recursive: true });
const demoTemplatePath = path.join(defaultDataDir, "matbeast-template-demo.db");

// Clean any stale template from a previous demo build.
for (const ext of ["", "-journal", "-wal", "-shm"]) {
  const stale = demoTemplatePath + ext;
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
}

fs.copyFileSync(prodDbPath, demoTemplatePath);
process.stdout.write(
  `[variant-prep] copied ${prodDbPath}\n` +
    `              -> ${demoTemplatePath}\n`,
);

// --------------------------------------------------------------------
// 4. Strip the copy down to masters-only + empty CloudConfig row.
//    Use prisma db execute with inline SQL so we don't need a new
//    native-module dependency.
//
//    The schema's Prisma-level cascade rules mean we can just DELETE
//    the top-level Tournament/Bracket/PlayerProfile rows and SQLite
//    will follow the ON DELETE CASCADE wiring for the children. We
//    still defensively wipe the child tables below so older DBs
//    (where the cascades may differ) come out clean.
// --------------------------------------------------------------------

// Master* (live) + TrainingMaster* (training files) are intentionally kept.
// The cloud tables (CloudConfig, CloudEventLink, MasterCloudOutbox)
// are lazily created at runtime by ensureCloudTables() in the
// production app, so they may or may not exist in the dev's local DB.
// DROP IF EXISTS handles both cases; the demo app never sets up
// cloud, so losing the tables is desired (saves them from being
// recreated in the template only to sit empty forever).
//
// The remaining 11 models are ordinary Prisma-schema tables and are
// guaranteed to exist. Their DELETEs run unconditionally.
const stripSql = `
DROP TABLE IF EXISTS "CloudConfig";
DROP TABLE IF EXISTS "CloudEventLink";
DROP TABLE IF EXISTS "MasterCloudOutbox";

DELETE FROM "BoutLog";
DELETE FROM "QuintetSession";
DELETE FROM "BracketMatch";
DELETE FROM "ResultLog";
DELETE FROM "LiveScoreboardState";

DELETE FROM "Player";
DELETE FROM "Team";
DELETE FROM "Event";
DELETE FROM "Tournament";

VACUUM;
`;

const sqlTmpPath = path.join(defaultDataDir, "_strip-demo-template.sql");
fs.writeFileSync(sqlTmpPath, stripSql, "utf8");

const templateUrl = "file:" + demoTemplatePath.replace(/\\/g, "/");

const stripResult = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "prisma",
    "db",
    "execute",
    "--file",
    sqlTmpPath,
    "--url",
    templateUrl,
  ],
  {
    cwd: webRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: templateUrl },
    shell: process.platform === "win32",
  },
);

fs.unlinkSync(sqlTmpPath);

if (stripResult.status !== 0) {
  process.stderr.write(
    "[variant-prep] ERROR: failed to strip demo template down to masters-only.\n",
  );
  process.exit(stripResult.status ?? 1);
}

// --------------------------------------------------------------------
// 5. Copy the bundled demo sample event into build/demo-seed/sample-events/.
//    Only `demofile.matb` from the build machine's Documents folder is
//    shipped — the demo home page lists whatever .matb files land here.
//    We wipe this directory first so a previous build's samples (e.g.
//    TESTEVENT1.matb) are not left in the installer.
// --------------------------------------------------------------------

const documentsDir = path.join(
  process.env.USERPROFILE || path.join(os.homedir()),
  "Documents",
);
for (const leftover of fs.readdirSync(sampleEventsDir)) {
  fs.rmSync(path.join(sampleEventsDir, leftover), { recursive: true, force: true });
}

const sampleSources = [path.join(documentsDir, "demofile.matb")];

let copied = 0;
for (const src of sampleSources) {
  if (!fs.existsSync(src)) {
    process.stderr.write(
      `[variant-prep] WARNING: sample event not found, skipping: ${src}\n`,
    );
    continue;
  }
  const dst = path.join(sampleEventsDir, path.basename(src));
  fs.copyFileSync(src, dst);
  const bytes = fs.statSync(dst).size;
  process.stdout.write(
    `[variant-prep] bundled sample event ${path.basename(src)} (${bytes} bytes)\n`,
  );
  copied += 1;
}

if (copied === 0) {
  process.stderr.write(
    "[variant-prep] ERROR: demofile.matb was not bundled. Place your demo\n" +
      "           event at:\n" +
      `           ${path.join(documentsDir, "demofile.matb")}\n` +
      "           then re-run 'npm run desktop:build:demo'.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `[variant-prep] demo preparation complete (${copied} sample event(s), masters-only template ready)\n`,
);
