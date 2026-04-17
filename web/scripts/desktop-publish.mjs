/**
 * Loads GitHub token before electron-builder --publish.
 * Order: existing env → web/.env → web/electron-builder.env → `gh auth token` (GitHub CLI).
 */
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyStandardElectronBuilderEnv } from "./electron-builder-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

applyStandardElectronBuilderEnv(root);

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  try {
    const token = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      process.env.GH_TOKEN = token;
    }
  } catch {
    // gh not installed or not logged in
  }
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  process.stderr.write(
    "desktop-publish: GH_TOKEN or GITHUB_TOKEN not set. Add it to web/.env or web/electron-builder.env (gitignored), or export it in your shell.\n"
  );
  process.exit(1);
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawnSync(npmCmd, ["run", "desktop:publish:run"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  // Windows: npm.cmd must run via shell or spawn fails with EINVAL.
  shell: process.platform === "win32",
});
process.exit(child.error ? 1 : child.status === null ? 1 : child.status);
