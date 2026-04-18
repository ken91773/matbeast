import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const outDir = path.join(webRoot, "build", "default-data");

const envVariant = String(process.env.MATBEAST_VARIANT ?? "").trim();
const isDemo = envVariant === "demo";

/**
 * Production builds get a brand-new empty SQLite created via
 * `prisma db push`. Demo builds inherit
 * `build/default-data/matbeast-template-demo.db` (populated by
 * variant-prep.mjs from the dev's local production DB, with every
 * non-masters table deleted). Demo copies overwrite the
 * `matbeast-template.db` artifact that gets bundled into the
 * installer so the main process can seed userData on first run
 * without needing any variant-specific code on the Electron side.
 */
const dbFile = path.join(outDir, "matbeast-template.db");
const databaseUrl = "file:" + dbFile.replace(/\\/g, "/");

fs.mkdirSync(outDir, { recursive: true });

if (isDemo) {
  const demoSource = path.join(outDir, "matbeast-template-demo.db");
  if (!fs.existsSync(demoSource)) {
    process.stderr.write(
      `[prepare-desktop-db] ERROR: demo variant expects\n` +
        `    ${demoSource}\n` +
        `to exist. variant-prep.mjs should have created it. Re-run\n` +
        `'npm run desktop:build:demo' from a clean state.\n`,
    );
    process.exit(1);
  }

  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  fs.copyFileSync(demoSource, dbFile);
  process.stdout.write(
    `[prepare-desktop-db] demo variant -> using seeded template\n` +
      `                     ${dbFile}\n`,
  );
  process.exit(0);
}

// Production: empty DB via prisma db push.
if (fs.existsSync(dbFile)) {
  fs.unlinkSync(dbFile);
}

execSync("npx prisma db push", {
  cwd: webRoot,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

process.stdout.write(`Prepared desktop SQLite template: ${dbFile}\n`);
