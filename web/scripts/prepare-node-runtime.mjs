import fs from "node:fs/promises";
import path from "node:path";

const webRoot = process.cwd();
const outDir = path.resolve(webRoot, "build", "node-runtime");
/** Use a unique name so builds are not blocked by a locked `node.exe` left on disk. */
const outNode = path.join(outDir, "matbeast-node.exe");

const candidates = [
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\Program Files (x86)\\nodejs\\node.exe",
];

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let src = "";
  for (const c of candidates) {
    if (await fileExists(c)) {
      src = c;
      break;
    }
  }

  if (!src) {
    throw new Error("Could not find node.exe in standard install paths.");
  }

  await fs.mkdir(outDir, { recursive: true });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tmpOut = path.join(outDir, `matbeast-node-${process.pid}.tmp.exe`);

  async function tryUnlink(p) {
    try {
      await fs.unlink(p);
    } catch {
      // ignore
    }
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await tryUnlink(outNode);
      await tryUnlink(tmpOut);
      try {
        await fs.copyFile(src, outNode);
      } catch (e) {
        if (e?.code === "EBUSY" || e?.code === "EPERM") {
          const buf = await fs.readFile(src);
          await fs.writeFile(tmpOut, buf);
          await fs.rename(tmpOut, outNode);
        } else {
          throw e;
        }
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (e?.code === "EBUSY" || e?.code === "EPERM") {
        await sleep(200 * attempt);
        continue;
      }
      throw e;
    }
  }
  if (lastErr) {
    throw new Error(
      `${lastErr.message} (tried 10 times; close other terminals/apps using ${outNode}, then retry)`
    );
  }

  process.stdout.write(`Prepared bundled Node runtime: ${outNode}\n`);
}

main().catch((error) => {
  process.stderr.write(`prepare-node-runtime failed: ${error.message}\n`);
  process.exit(1);
});
