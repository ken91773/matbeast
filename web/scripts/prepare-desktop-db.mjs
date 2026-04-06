import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const outDir = path.join(webRoot, "build", "default-data");
const dbFile = path.join(outDir, "matbeast-template.db");
/** Prisma on Windows accepts forward slashes in file: URLs. */
const databaseUrl = "file:" + dbFile.replace(/\\/g, "/");

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(dbFile)) {
  fs.unlinkSync(dbFile);
}

execSync("npx prisma db push", {
  cwd: webRoot,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

process.stdout.write(`Prepared desktop SQLite template: ${dbFile}\n`);
