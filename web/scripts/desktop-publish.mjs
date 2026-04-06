/**
 * Loads GitHub token before electron-builder --publish.
 * Order: existing env → web/.env → web/electron-builder.env → `gh auth token` (GitHub CLI).
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Later files override earlier; do not overwrite non-empty vars already in process.env (shell). */
const mergedFileEnv = {
  ...parseEnvFile(path.join(root, ".env")),
  ...parseEnvFile(path.join(root, "electron-builder.env")),
};
for (const [key, val] of Object.entries(mergedFileEnv)) {
  if (val === "") continue;
  const existing = process.env[key];
  if (existing !== undefined && existing !== "") continue;
  process.env[key] = val;
}

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
