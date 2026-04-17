import fs from "node:fs";
import path from "node:path";

export function parseEnvFile(filePath) {
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
export function mergeEnvFiles(filePaths) {
  const merged = {};
  for (const fp of filePaths) {
    Object.assign(merged, parseEnvFile(fp));
  }
  for (const [key, val] of Object.entries(merged)) {
    if (val === "") continue;
    const existing = process.env[key];
    if (existing !== undefined && existing !== "") continue;
    process.env[key] = val;
  }
}

export function mapSigningEnv() {
  if (process.env.WIN_CSC_LINK && !process.env.CSC_LINK) {
    process.env.CSC_LINK = process.env.WIN_CSC_LINK;
  }
  if (process.env.WIN_CSC_KEY_PASSWORD && !process.env.CSC_KEY_PASSWORD) {
    process.env.CSC_KEY_PASSWORD = process.env.WIN_CSC_KEY_PASSWORD;
  }
  if (process.env.WIN_CSC_NAME && !process.env.CSC_NAME) {
    process.env.CSC_NAME = process.env.WIN_CSC_NAME;
  }

  const hasSigningInputs = Boolean(
    process.env.CSC_LINK ||
      process.env.CSC_KEY_PASSWORD ||
      process.env.CSC_NAME ||
      process.env.WIN_CSC_LINK ||
      process.env.WIN_CSC_KEY_PASSWORD ||
      process.env.WIN_CSC_NAME,
  );

  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === undefined) {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = hasSigningInputs ? "true" : "false";
  }
}

export function applyStandardElectronBuilderEnv(webRoot) {
  mergeEnvFiles([
    path.join(webRoot, ".env"),
    path.join(webRoot, "electron-builder.env"),
  ]);
  mapSigningEnv();
}
