import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

/** App version (from package.json) surfaced to the client for the overlay's
 * `?diag=1` version stamp, so an OBS Browser Source can be verified to be
 * running the expected build (vs. a stale cached one). */
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
  async headers() {
    return [
      {
        source: "/overlay",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, max-age=0",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
