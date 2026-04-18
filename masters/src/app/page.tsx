import Link from "next/link";
import AuthPanel from "./auth-panel";

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "64px 32px",
      }}
    >
      <h1 style={{ fontSize: 48, fontWeight: 700, marginBottom: 8 }}>
        Mat Beast Masters
      </h1>
      <p style={{ fontSize: 18, opacity: 0.75, marginTop: 0 }}>
        Cloud service for shared master lists and event files.
      </p>

      <section style={{ marginTop: 48 }}>
        <h2
          style={{
            fontSize: 20,
            borderBottom: "1px solid #334155",
            paddingBottom: 8,
          }}
        >
          Your sign-in
        </h2>
        <AuthPanel />
      </section>

      <section style={{ marginTop: 48 }}>
        <h2
          style={{
            fontSize: 20,
            borderBottom: "1px solid #334155",
            paddingBottom: 8,
          }}
        >
          Status
        </h2>
          <ul style={{ lineHeight: 1.8, fontSize: 15 }}>
            <li>Version 0.4.0 - shared event files in the cloud</li>
            <li>
              <Link href="/desktop-tokens" style={{ color: "#93c5fd" }}>
                Manage desktop tokens
              </Link>{" "}
              (sign-in required)
            </li>
            <li>
              <Link href="/events" style={{ color: "#93c5fd" }}>
                Browse cloud events
              </Link>{" "}
              (sign-in required)
            </li>
            <li>
              Public health check:{" "}
              <Link
                href="/api/health"
                style={{ color: "#93c5fd" }}
                target="_blank"
              >
                GET /api/health
              </Link>
            </li>
            <li>
              Protected test endpoint:{" "}
              <Link href="/api/me" style={{ color: "#93c5fd" }} target="_blank">
                GET /api/me
              </Link>{" "}
              (requires sign-in)
            </li>
            <li>
              Master team names:{" "}
              <Link
                href="/api/master-team-names"
                style={{ color: "#93c5fd" }}
                target="_blank"
              >
                GET /api/master-team-names
              </Link>
            </li>
            <li>
              Master player profiles:{" "}
              <Link
                href="/api/master-player-profiles"
                style={{ color: "#93c5fd" }}
                target="_blank"
              >
                GET /api/master-player-profiles
              </Link>
            </li>
            <li>Database (Neon Postgres): connected</li>
            <li>File storage (R2): not yet configured</li>
          </ul>
      </section>
    </main>
  );
}
