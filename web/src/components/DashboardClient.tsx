"use client";

import { DashboardFullWorkspace } from "@/components/dashboard/DashboardFullWorkspace";
import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import HomeCloudPanel from "@/components/HomeCloudPanel";
import { useEffect } from "react";

export default function DashboardClient() {
  const { ready, openTabs, showHome } = useEventWorkspace();

  /**
   * Render modes:
   *  - loading             → "Starting workspace…" placeholder
   *  - no tabs open        → `HomeCloudPanel` (implicit home view)
   *  - tabs open + home    → `HomeCloudPanel` (explicit File ▸ Home page)
   *  - tabs open + !home   → `DashboardFullWorkspace` (event dashboard)
   *
   * The `showHome` override lets the File menu toggle to the cloud
   * catalog without closing any tabs, so switching back to Dashboard
   * lands on exactly the same event the user was editing.
   */
  const renderHome = !ready
    ? false
    : openTabs.length === 0
      ? true
      : showHome;

  /**
   * Mirror the rendered view into the Electron main process so the
   * File menu's toggle item shows the right label ("Home page"
   * vs "Dashboard"). The IPC is debounced-by-equality in main, so
   * firing this on every render is safe.
   */
  useEffect(() => {
    const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (!desk?.setWorkspaceViewState) return;
    void desk.setWorkspaceViewState({
      showingHome: renderHome,
      hasTabs: openTabs.length > 0,
    });
  }, [renderHome, openTabs.length]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212] text-zinc-100">
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-3 pb-3 pt-3">
        {!ready ? (
          <p className="px-1 py-8 text-center text-sm text-zinc-500">Starting workspace…</p>
        ) : renderHome ? (
          <HomeCloudPanel />
        ) : (
          <DashboardFullWorkspace />
        )}
      </div>
    </div>
  );
}
