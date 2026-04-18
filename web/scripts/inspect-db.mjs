import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) {
  console.error("usage: node inspect-db.mjs <path>");
  process.exit(1);
}
const db = new DatabaseSync(path);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("Tables:", tables.map((t) => t.name).join(", "));
for (const { name } of tables) {
  if (typeof name !== "string") continue;
  if (name.startsWith("_") || name === "sqlite_sequence") continue;
  try {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
    console.log(`\n[${name}]`);
    for (const c of cols) {
      console.log(`  ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ""}`);
    }
  } catch (e) {
    console.log(`  (error reading ${name}): ${String(e)}`);
  }
}
