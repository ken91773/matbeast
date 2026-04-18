import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Next.js middleware runs on every request before the page/route handler.
 *
 * `clerkMiddleware()` attaches the current Clerk auth state (is-signed-in,
 * user id) to every request. By default it does NOT require sign-in
 * anywhere - routes stay public unless we explicitly protect them.
 *
 * Routing strategy:
 *  - `/api/me` is the only route hard-protected at the middleware layer
 *    (Clerk session required, returns 404 if absent). It exists to test
 *    Clerk specifically.
 *  - All other protected routes (master profiles, master team names,
 *    desktop-tokens admin) do their own auth check inside the handler via
 *    `requireUserId()` from src/lib/auth.ts. That helper accepts either
 *    a Clerk session OR an `Authorization: Bearer mbk_...` desktop token,
 *    and returns 401 (NOT 404) when nothing valid is presented. This is
 *    important: the desktop app distinguishes "you need to re-link"
 *    (401) from "endpoint missing" (404).
 *
 * Public (no auth):
 *  - `/`                 (landing page)
 *  - `/sign-in/*`
 *  - `/sign-up/*`
 *  - `/desktop-tokens`   (the admin page itself; the API behind it is
 *                         protected, so unauthenticated visitors just see
 *                         "Please sign in" inside the page)
 *  - `/api/health`       (uptime check must never require auth)
 */
const isHardProtectedRoute = createRouteMatcher(["/api/me(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isHardProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
