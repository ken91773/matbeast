import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyStandardElectronBuilderEnv } from "./electron-builder-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");

applyStandardElectronBuilderEnv(webRoot);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node ./scripts/run-electron-builder.mjs --win --x64 ...");
  process.exit(2);
}

/**
 * Variant-aware config overrides. When MATBEAST_VARIANT=demo is set,
 * we emit a suite of `-c.<path>=<value>` CLI flags that electron-builder
 * merges over package.json's `build` block. This lets production and
 * demo share the same package.json without maintaining a second
 * electron-builder config file. See scripts/variant-prep.mjs for the
 * matching variant.json marker and seed-data handling that runs
 * earlier in the build pipeline.
 *
 * Key overrides for the demo:
 *   - productName           -> "Mat Beast Scoreboard Demo"
 *   - appId                 -> com.matbeastscore.scoreboard.demo
 *   - directories.output    -> "dist-demo" so prod artifacts aren't clobbered
 *   - artifactName          -> injects "Demo" into the .exe filename
 *   - publish               -> null (demo never publishes to the prod feed)
 *   - nsis.shortcutName     -> "Mat Beast Scoreboard Demo" (Start Menu)
 */
const envVariant = String(process.env.MATBEAST_VARIANT ?? "").trim();
const variantArgs = [];
if (envVariant === "demo") {
  /**
   * `--publish never` is the canonical way to disable publishing in
   * electron-builder — it bypasses the publish pipeline wholesale
   * AND prevents the packed app from embedding a `app-update.yml`
   * that points at the prod GitHub release feed. (Setting
   * `-c.publish=null` would instead be interpreted as "use a
   * publisher plugin literally named 'null'" and crashes with
   * "unable to find publish provider".)
   *
   * NSIS override rationale (learned the hard way — first demo
   * install clobbered the production install):
   *
   * - `appId` and `productName` alone are NOT enough. NSIS uses the
   *   `uninstallDisplayName` as the registry key name for the
   *   "existing install" lookup. If two installers share that name
   *   they're treated as the same app and one upgrades the other,
   *   even if appId and productName differ.
   * - `shortcutName` needs to differ too or the Start Menu /
   *   Desktop shortcut overwrites the prod one.
   * - No explicit `-c.nsis.perMachine` — we inherit the package.json
   *   `perMachine: false`, so the default install dir becomes
   *   `%LOCALAPPDATA%\Programs\Mat Beast Scoreboard Demo\` naturally
   *   (derived from productName) and sits alongside prod's
   *   `...\Mat Beast Scoreboard\`.
   */
  variantArgs.push(
    "-c.productName=Mat Beast Scoreboard Demo",
    "-c.appId=com.matbeastscore.scoreboard.demo",
    "-c.directories.output=dist-demo",
    "-c.artifactName=${productName} Setup ${version}.${ext}",
    "-c.nsis.shortcutName=Mat Beast Scoreboard Demo",
    "-c.nsis.uninstallDisplayName=Mat Beast Scoreboard Demo",
    "--publish",
    "never",
  );
  process.stdout.write(
    "[run-electron-builder] demo variant -> dist-demo/Mat Beast Scoreboard Demo Setup X.Y.Z.exe\n",
  );
}

const ebCli = path.join(webRoot, "node_modules", "electron-builder", "cli.js");

const result = spawnSync(process.execPath, [ebCli, ...args, ...variantArgs], {
  cwd: webRoot,
  stdio: "inherit",
  shell: false,
  env: process.env,
});

process.exit(result.status ?? 1);
