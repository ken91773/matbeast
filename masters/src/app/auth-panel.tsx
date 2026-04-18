"use client";

import {
  SignInButton,
  SignOutButton,
  UserButton,
  useUser,
} from "@clerk/nextjs";

/**
 * Auth state widgets for the landing page.
 *
 * Client-only because Clerk's widgets and the `useUser()` hook read live
 * browser session state. Server components can't render these.
 *
 * NOTE: Clerk v7 removed the <SignedIn> / <SignedOut> control components.
 * The idiomatic replacement is to read `isSignedIn` / `isLoaded` from the
 * `useUser()` hook and branch with plain JSX. That's what this file does.
 */
export default function AuthPanel() {
  const { isLoaded, isSignedIn, user } = useUser();

  if (!isLoaded) {
    return (
      <p style={{ fontSize: 15, opacity: 0.6 }}>Loading sign-in state...</p>
    );
  }

  if (!isSignedIn) {
    return (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.6 }}>You are not signed in.</p>
        <SignInButton mode="modal">
          <button
            style={{
              padding: "10px 20px",
              fontSize: 15,
              fontWeight: 600,
              backgroundColor: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Sign in
          </button>
        </SignInButton>
      </>
    );
  }

  const email =
    user.primaryEmailAddress?.emailAddress ?? "(no email on file)";

  return (
    <>
      <p style={{ fontSize: 15, lineHeight: 1.6 }}>
        Signed in as <strong>{email}</strong>
        {user.firstName ? ` (${user.firstName})` : ""}.
      </p>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <UserButton />
        <SignOutButton>
          <button
            style={{
              padding: "10px 20px",
              fontSize: 15,
              fontWeight: 600,
              backgroundColor: "#334155",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Sign out
          </button>
        </SignOutButton>
      </div>
    </>
  );
}
