import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".next", "standalone", ".env");
if (fs.existsSync(envPath)) {
  fs.unlinkSync(envPath);
  process.stdout.write(
    "Removed .next/standalone/.env so the Electron main process controls DATABASE_URL and ports.\n"
  );
}
