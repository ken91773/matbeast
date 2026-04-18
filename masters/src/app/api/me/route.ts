import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Protected test endpoint.
 *
 * Returns identity info for the currently signed-in user. The Clerk
 * middleware (src/middleware.ts) rejects unauthenticated requests to
 * this route with a 404 before they reach this handler.
 *
 * Used to sanity-check that a signed-in browser session actually produces
 * a valid server-side auth token.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const user = await currentUser();
  return NextResponse.json({
    userId,
    email: user?.emailAddresses[0]?.emailAddress ?? null,
    firstName: user?.firstName ?? null,
    lastName: user?.lastName ?? null,
    imageUrl: user?.imageUrl ?? null,
  });
}
