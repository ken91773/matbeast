import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import EventsClient from "./events-client";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const { userId } = await auth();
  return (
    <main
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: "48px 32px",
      }}
    >
      <p style={{ marginBottom: 8, fontSize: 13 }}>
        <Link href="/" style={{ color: "#93c5fd" }}>
          &larr; Back to home
        </Link>
      </p>
      <h1 style={{ fontSize: 36, fontWeight: 700, marginBottom: 8 }}>
        Cloud events
      </h1>
      <p style={{ fontSize: 15, opacity: 0.75, marginTop: 0, lineHeight: 1.6 }}>
        Events uploaded to the cloud by any Mat Beast Scoreboard desktop.
        Editing is done in the desktop app - this page is read-only and is
        mainly useful for renaming or deleting events.
      </p>
      {userId ? (
        <EventsClient currentUserId={userId} />
      ) : (
        <section
          style={{
            marginTop: 32,
            padding: 24,
            border: "1px solid #475569",
            borderRadius: 8,
            backgroundColor: "#1e293b",
          }}
        >
          <p style={{ margin: 0, fontSize: 15 }}>
            You need to be signed in to view cloud events.{" "}
            <Link href="/" style={{ color: "#93c5fd" }}>
              Go home
            </Link>{" "}
            and click <strong>Sign in</strong>.
          </p>
        </section>
      )}
    </main>
  );
}
