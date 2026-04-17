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

// Run cli.js with Node so Windows does not need shell:true for .cmd shims.
const ebCli = path.join(webRoot, "node_modules", "electron-builder", "cli.js");

const result = spawnSync(process.execPath, [ebCli, ...args], {
  cwd: webRoot,
  stdio: "inherit",
  shell: false,
  env: process.env,
});

process.exit(result.status ?? 1);
