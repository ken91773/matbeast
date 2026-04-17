/**
 * electron-builder afterPack hook.
 *
 * Problem: with `win.signAndEditExecutable: false` (our workaround for the
 * winCodeSign 7z extraction failure on Windows without Developer Mode), the
 * packaged `Mat Beast Scoreboard.exe` keeps Electron's default icon and
 * version strings embedded in its PE resources. The window frame looks fine
 * (Electron loads icon.ico at runtime) but the desktop/Start-Menu shortcut
 * pulls the icon straight from the .exe resources → shows the stock Electron
 * icon.
 *
 * Fix: run rcedit here to embed build/icon.ico AND patch the version strings
 * to Mat Beast. This is exactly what electron-builder would do if
 * signAndEditExecutable were true, but without triggering the winCodeSign
 * tooling download.
 *
 * Robustness: we observed the rcedit call occasionally exit 0 without
 * actually mutating the PE resources (likely a brief file lock race with
 * the asar-integrity step that runs immediately before this hook). We now
 * verify by reading back the FileDescription and retry with a small delay
 * until the change is committed, or fail the build loudly.
 *
 * We shell out to rcedit-x64.exe directly (shipped by the `rcedit` npm
 * package) to avoid ESM/CJS interop issues with the JS wrapper.
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const EXPECTED_FILE_DESCRIPTION = "Mat Beast Scoreboard";
const MAX_ATTEMPTS = 4;
const DELAY_MS = 750;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runRcedit(rceditPath, args, { capture = false } = {}) {
  const result = spawnSync(rceditPath, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`[after-pack-icon] rcedit spawn failed: ${result.error.message}`);
  }
  return result;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(appOutDir, `${productFilename}.exe`);
  const webRoot = path.resolve(__dirname, "..");
  const iconPath = path.resolve(webRoot, "build", "icon.ico");

  const rceditExeName =
    process.arch === "x64" || process.arch === "arm64"
      ? "rcedit-x64.exe"
      : "rcedit.exe";
  const rceditPath = path.resolve(
    webRoot,
    "node_modules",
    "rcedit",
    "bin",
    rceditExeName,
  );

  for (const [label, p] of [
    ["Main exe", exePath],
    ["Icon", iconPath],
    ["rcedit binary", rceditPath],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(`[after-pack-icon] ${label} not found: ${p}`);
    }
  }

  const editArgs = [
    exePath,
    "--set-icon",
    iconPath,
    "--set-version-string",
    "FileDescription",
    EXPECTED_FILE_DESCRIPTION,
    "--set-version-string",
    "ProductName",
    "Mat Beast Scoreboard",
    "--set-version-string",
    "CompanyName",
    "Mat Beast Scoreboard",
    "--set-version-string",
    "OriginalFilename",
    `${productFilename}.exe`,
    "--set-version-string",
    "InternalName",
    "Mat Beast Scoreboard",
  ];

  process.stdout.write(
    `[after-pack-icon] Patching ${exePath} (icon + version strings)\n`,
  );

  let committed = false;
  let lastDescription = "(not read)";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const editRes = runRcedit(rceditPath, editArgs);
    if (editRes.status !== 0) {
      throw new Error(
        `[after-pack-icon] rcedit --set-* exited with status ${editRes.status} (attempt ${attempt})`,
      );
    }

    // Read back to verify the edit actually landed in the PE resources.
    const verifyRes = runRcedit(
      rceditPath,
      [exePath, "--get-version-string", "FileDescription"],
      { capture: true },
    );
    lastDescription = (verifyRes.stdout || "").trim();
    if (lastDescription === EXPECTED_FILE_DESCRIPTION) {
      committed = true;
      process.stdout.write(
        `[after-pack-icon] Verified on attempt ${attempt} (FileDescription="${lastDescription}")\n`,
      );
      break;
    }

    process.stdout.write(
      `[after-pack-icon] Attempt ${attempt} did not commit (got FileDescription="${lastDescription}"); retrying in ${DELAY_MS}ms\n`,
    );
    await sleep(DELAY_MS);
  }

  if (!committed) {
    throw new Error(
      `[after-pack-icon] Failed to commit icon/version patch after ${MAX_ATTEMPTS} attempts (last FileDescription="${lastDescription}"). ` +
        "This usually means another process has an open handle on the exe. " +
        "Close any running Mat Beast Scoreboard windows and rebuild.",
    );
  }

  process.stdout.write(`[after-pack-icon] Done.\n`);
};
