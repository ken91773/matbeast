"use client";

import { DashboardFullWorkspace } from "@/components/dashboard/DashboardFullWorkspace";
import { useEventWorkspace } from "@/components/EventWorkspaceProvider";

export default function DashboardClient() {
  const { ready } = useEventWorkspace();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212] text-zinc-100">
      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-3 pb-3 pt-3">
        {!ready ? (
          <p className="px-1 py-8 text-center text-sm text-zinc-500">Starting workspace…</p>
        ) : (
          <DashboardFullWorkspace />
        )}
      </div>
    </div>
  );
}
