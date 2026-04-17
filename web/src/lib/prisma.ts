import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Resolve `file:...` from DATABASE_URL to an absolute filesystem path (Windows-safe). */
function resolveSqliteFilePath(databaseUrl: string): string | null {
  const url = databaseUrl.trim();
  if (!url.toLowerCase().startsWith("file:")) return null;
  let raw = url.slice("file:".length).trim();
  if (raw.startsWith("//")) raw = raw.slice(2);
  let decoded = decodeURIComponent(raw.replace(/\+/g, "%20"));
  if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(decoded)) {
    decoded = decoded.slice(1);
  }
  if (!path.isAbsolute(decoded)) {
    decoded = path.resolve(process.cwd(), decoded);
  }
  return decoded;
}

/** Prefer a child Node process so `node:sqlite` matches the Node version running the server. */
function patchTeamOverlayColorViaNodeSqliteChild(dbPath: string): boolean {
  const script = `
import { DatabaseSync } from "node:sqlite";
const dbPath = ${JSON.stringify(dbPath)};
const db = new DatabaseSync(dbPath);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Team'")
  .all();
if (!tables.length) process.exit(0);
const cols = db.prepare('PRAGMA table_info("Team")').all().map((r) => r.name);
if (cols.includes("overlayColor")) process.exit(0);
db.exec('ALTER TABLE "Team" ADD COLUMN "overlayColor" TEXT');
process.exit(0);
`.trim();
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 60_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Older Node (no \`node:sqlite\`): patch in-process using sql.js (same dependency as Electron). */
async function patchTeamOverlayColorViaSqlJs(dbPath: string): Promise<void> {
  const initSqlJs = (await import("sql.js")).default;
  const wasmPath = path.join(
    path.dirname(require.resolve("sql.js/package.json")),
    "dist",
    "sql-wasm.wasm",
  );
  const wasmBinary = readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });
  const fileBuf = readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(fileBuf));
  try {
    const tables = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='Team';`,
    );
    if (!tables.length) return;
    const info = db.exec(`PRAGMA table_info("Team");`);
    const colNames =
      info.length && info[0]?.values ? info[0].values.map((row) => String(row[1])) : [];
    if (colNames.includes("overlayColor")) return;
    db.run(`ALTER TABLE "Team" ADD COLUMN "overlayColor" TEXT;`);
    const exported = db.export();
    writeFileSync(dbPath, Buffer.from(exported));
  } finally {
    db.close();
  }
}

async function ensureTeamOverlayColorSqliteColumn(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const dbPath = resolveSqliteFilePath(url);
  if (!dbPath || !existsSync(dbPath)) return;
  if (patchTeamOverlayColorViaNodeSqliteChild(dbPath)) return;
  await patchTeamOverlayColorViaSqlJs(dbPath);
}

async function createPrismaClient(): Promise<PrismaClient> {
  try {
    await ensureTeamOverlayColorSqliteColumn();
  } catch (e) {
    console.error("[prisma] ensureTeamOverlayColorSqliteColumn failed:", e);
  }
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? (await createPrismaClient());

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
