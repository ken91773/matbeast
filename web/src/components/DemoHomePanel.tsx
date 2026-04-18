"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import { matbeastImportOpenedEventFile } from "@/lib/matbeast-dashboard-file-actions";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

type SampleEventMeta = {
  fileName: string;
  eventName: string | null;
  sizeBytes: number;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Demo-variant home page.
 *
 * Replaces `HomeCloudPanel` when `window.matBeastDesktop.variant === "demo"`
 * (see `DashboardClient`). Instead of hitting the cloud masters service
 * for an event catalog, this component:
 *
 *   1. Calls the `demo:list-sample-events` IPC to enumerate the `.matb`
 *      envelopes bundled into the installer under `<resources>/sample-events/`.
 *   2. Renders them as click-to-open rows, mirroring the visual feel of
 *      `HomeCloudPanel` so a demo viewer can't tell the two apart on sight.
 *   3. On click, fetches the envelope text via `demo:read-sample-event` and
 *      pipes it through the same `matbeastImportOpenedEventFile` path the
 *      "Restore copy from disk" menu uses, so the imported tournament is
 *      indistinguishable from one created from a real `.matb` file.
 *
 * A persistent "DEMO MODE" banner makes the variant obvious. A "Create
 * new event" button dispatches the same `matbeast-open-new-event-dialog`
 * event as HomeCloudPanel; `AppChrome` already detects demo mode
 * upstream and bypasses the cloud-first creation flow (see the `isDemo`
 * checks in the new-event handler).
 */
export default function DemoHomePanel() {
  const queryClient = useQueryClient();
  const {
    openEventInTab,
    refreshTournaments,
    openTabs,
    selectTab,
    setShowHome,
  } = useEventWorkspace();

  const [events, setEvents] = useState<SampleEventMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFile, setBusyFile] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const desk =
      typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (!desk?.listSampleEvents) {
      setError("Sample events are not available in this runtime.");
      setEvents([]);
      return;
    }
    try {
      const res = await desk.listSampleEvents();
      if (!res.ok) {
        setError(res.error ?? "Could not list sample events.");
        setEvents([]);
        return;
      }
      setEvents(res.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not list sample events.");
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedEvents = useMemo(() => {
    if (!events) return null;
    return [...events].sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [events]);

  const openSample = useCallback(
    async (meta: SampleEventMeta) => {
      const desk =
        typeof window !== "undefined" ? window.matBeastDesktop : undefined;
      if (!desk?.readSampleEvent) return;
      setBusyFile(meta.fileName);
      try {
        const res = await desk.readSampleEvent(meta.fileName);
        if (!res.ok) {
          window.alert(
            `Could not open ${meta.fileName}: ${res.error ?? "unknown error"}`,
          );
          return;
        }
        /**
         * We pass the plain filename as `filePath`. The downstream
         * import path only uses it to derive a fallback event name
         * and to log where the import came from; it never writes
         * back to disk in demo mode.
         */
        await matbeastImportOpenedEventFile({
          filePath: meta.fileName,
          text: res.text,
          queryClient,
          openEventInTab,
          refreshTournaments,
          openTabs,
          selectTab,
          setShowHome,
        });
      } finally {
        setBusyFile(null);
      }
    },
    [queryClient, openEventInTab, openTabs, refreshTournaments, selectTab, setShowHome],
  );

  const createNew = useCallback(() => {
    window.dispatchEvent(new CustomEvent("matbeast-open-new-event-dialog"));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-start overflow-y-auto px-6 py-10 text-zinc-100">
      <div className="w-full max-w-3xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-900/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-200">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-amber-400"
          />
          Demo mode — local only, no cloud sync
        </div>
        <header className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="m-0 text-2xl font-bold tracking-tight">
              Mat Beast Scoreboard
            </h1>
            <p className="mt-1 text-[12px] text-zinc-400">
              Open a bundled sample event, or create a new one. All changes
              stay on this machine.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="rounded border border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={createNew}
              className="rounded bg-teal-700 px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-teal-600"
            >
              + Create new event
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded border border-red-700/50 bg-red-900/20 p-4 text-[12px] text-red-100">
            <p className="m-0 font-semibold">Could not load sample events</p>
            <p className="m-0 mt-1 break-words text-red-100/80">{error}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void load()}
                className="rounded bg-red-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-red-600"
              >
                Retry
              </button>
            </div>
          </div>
        ) : sortedEvents === null ? (
          <p className="text-[12px] text-zinc-500">Loading sample events…</p>
        ) : sortedEvents.length === 0 ? (
          <div className="rounded border border-zinc-700 bg-zinc-900/40 p-6 text-center text-[12px] text-zinc-300">
            <p className="m-0 font-semibold">No sample events bundled</p>
            <p className="m-0 mt-1 text-zinc-500">
              Create a new event to get started.
            </p>
          </div>
        ) : (
          <ul className="m-0 list-none rounded border border-zinc-800 bg-zinc-900/40 p-0">
            {sortedEvents.map((meta) => {
              const busy = busyFile === meta.fileName;
              return (
                <li
                  key={meta.fileName}
                  className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 last:border-b-0 hover:bg-zinc-800/40"
                >
                  <button
                    type="button"
                    onClick={() => void openSample(meta)}
                    disabled={busy}
                    className="flex flex-1 flex-col items-start gap-0.5 text-left disabled:opacity-60"
                  >
                    <span className="text-[13px] font-semibold text-zinc-100">
                      {meta.fileName.replace(/\.matb$/i, "")}
                    </span>
                    {meta.eventName ? (
                      <span className="text-[11px] text-zinc-400">
                        {meta.eventName}
                      </span>
                    ) : null}
                  </button>
                  <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
                    <span>{fmtSize(meta.sizeBytes)}</span>
                    <button
                      type="button"
                      onClick={() => void openSample(meta)}
                      disabled={busy}
                      className="rounded border border-zinc-700 px-3 py-1 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
                    >
                      {busy ? "Opening…" : "Open"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
