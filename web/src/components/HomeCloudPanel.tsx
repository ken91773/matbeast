"use client";

import { useEventWorkspace } from "@/components/EventWorkspaceProvider";
import { matbeastImportOpenedEventFile } from "@/lib/matbeast-dashboard-file-actions";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CloudEventMeta = {
  id: string;
  name: string;
  eventName: string | null;
  ownerUserId: string;
  currentVersion: number;
  currentBlobSha: string | null;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  updatedByUserId: string;
};

type CloudConfig = {
  configured: boolean;
  tokenSet: boolean;
  syncEnabled: boolean;
};

function fmtAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return d.toLocaleDateString();
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Compare key for "most recently edited OR created first". We use
 * whichever of updatedAt / createdAt is later so a brand-new copy
 * whose underlying blob timestamp wasn't re-bumped still sorts to
 * the top on the same page-load.
 */
function sortKey(e: CloudEventMeta): number {
  const u = Date.parse(e.updatedAt);
  const c = Date.parse(e.createdAt);
  return Math.max(Number.isNaN(u) ? 0 : u, Number.isNaN(c) ? 0 : c);
}

/**
 * Empty-state landing panel shown when no event tabs are open. Lists the
 * full cloud event catalog so a returning user can jump straight into
 * whichever event they last worked on. Falls back gracefully when the
 * cloud isn't configured (or unreachable) — the "Create new event"
 * action stays available so local-only workflows keep working.
 *
 * Each row shows the filename on the primary line and the tournament's
 * display event name on the secondary line, plus a 3-dot action menu
 * with "Make a copy" and "Delete". Rows are sorted newest-first using
 * the max of createdAt/updatedAt so a freshly duplicated event always
 * floats to the top of the list.
 */
export default function HomeCloudPanel() {
  const queryClient = useQueryClient();
  const { openEventInTab, refreshTournaments, openTabs } =
    useEventWorkspace();

  const openTabsRef = useRef(openTabs);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const [cfg, setCfg] = useState<CloudConfig | null>(null);
  const [events, setEvents] = useState<CloudEventMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  /**
   * In-place filename rename state. When non-null, the row whose id
   * matches renders an `<input>` in place of the filename label so the
   * user can edit the name without opening a separate dialog. `initial`
   * captures the pre-edit name so we can skip the PATCH when the value
   * didn't change.
   */
  const [renameState, setRenameState] = useState<
    | { id: string; draft: string; initial: string }
    | null
  >(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const cfgRes = await fetch("/api/cloud/config", { cache: "no-store" });
      if (!cfgRes.ok) {
        setCfg({ configured: false, tokenSet: false, syncEnabled: false });
        return;
      }
      const c = (await cfgRes.json()) as CloudConfig;
      setCfg(c);
      if (!c.configured) {
        setEvents(null);
        return;
      }
      const evRes = await fetch("/api/cloud/events", { cache: "no-store" });
      if (!evRes.ok) {
        setError(`Cloud list HTTP ${evRes.status}`);
        return;
      }
      const data = (await evRes.json()) as { events: CloudEventMeta[] };
      setEvents(data.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load cloud events");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Close any open 3-dot menu when the user clicks anywhere else in
  // the panel. Listening on the whole window is fine here: the panel
  // unmounts as soon as an event tab opens.
  useEffect(() => {
    if (!menuOpenFor) return;
    const onDown = () => setMenuOpenFor(null);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpenFor]);

  /** Newest-first view of the fetched list. */
  const sortedEvents = useMemo(() => {
    if (!events) return null;
    return [...events].sort((a, b) => sortKey(b) - sortKey(a));
  }, [events]);

  const openCloudEvent = useCallback(
    async (meta: CloudEventMeta) => {
      setBusyId(meta.id);
      try {
        const r = await fetch("/api/cloud/events/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cloudEventId: meta.id }),
        });
        if (!r.ok) {
          window.alert(`Could not download event: HTTP ${r.status}`);
          return;
        }
        const { envelope } = (await r.json()) as { envelope: string };
        const before = new Set(openTabsRef.current.map((t) => t.id));
        await matbeastImportOpenedEventFile({
          filePath: `${meta.name}.matb`,
          text: envelope,
          queryClient,
          openEventInTab,
          refreshTournaments,
        });
        // Bind link via second pull with tournamentId.
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        const after = openTabsRef.current;
        const newTab = after.find((t) => !before.has(t.id));
        if (newTab) {
          await fetch("/api/cloud/events/pull", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cloudEventId: meta.id,
              tournamentId: newTab.id,
            }),
          }).catch(() => {});
          window.dispatchEvent(
            new CustomEvent("matbeast-cloud-sync-changed", {
              detail: { tournamentId: newTab.id },
            }),
          );
        }
      } finally {
        setBusyId(null);
      }
    },
    [openEventInTab, queryClient, refreshTournaments],
  );

  const createNew = useCallback(async () => {
    // Actual creation is owned by AppChrome's `NewEventDialog`. We
    // just ask it to open and let the user pick a title + filename.
    window.dispatchEvent(new CustomEvent("matbeast-open-new-event-dialog"));
  }, []);

  const copyCloudEvent = useCallback(
    async (meta: CloudEventMeta) => {
      setMenuOpenFor(null);
      setBusyId(meta.id);
      try {
        const r = await fetch(
          `/api/cloud/events/${encodeURIComponent(meta.id)}/copy`,
          { method: "POST" },
        );
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          window.alert(`Copy failed: HTTP ${r.status}\n${txt.slice(0, 300)}`);
          return;
        }
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /**
   * Commit the in-place filename edit. Skips the PATCH entirely when
   * the value is unchanged or blank; on success, refreshes the list
   * so the row moves to the top (most-recently-updated first).
   */
  const commitRename = useCallback(async () => {
    if (!renameState) return;
    const id = renameState.id;
    const next = renameState.draft.trim();
    if (!next || next === renameState.initial) {
      setRenameState(null);
      return;
    }

    /**
     * Client-side pre-check against the already-loaded catalog.
     * Saves a round-trip for the common case — "user meant to type
     * Regionals25 but hit Regionals24 which is already taken". The
     * server still enforces uniqueness; this is purely for the
     * friendlier error path and to keep the inline input open so
     * the user can edit without losing their typing.
     */
    const clash =
      events?.find(
        (ev) => ev.id !== id && ev.name.trim().toLowerCase() === next.toLowerCase(),
      ) ?? null;
    if (clash) {
      const clashLabel = clash.eventName?.trim()
        ? `${clash.name} (${clash.eventName})`
        : clash.name;
      window.alert(
        `That filename is already used by "${clashLabel}". ` +
          `Pick a different filename for this event.`,
      );
      return;
    }

    setRenameState(null);
    setBusyId(id);
    try {
      const r = await fetch(
        `/api/cloud/events/${encodeURIComponent(id)}/name`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: next }),
        },
      );
      if (r.status === 409) {
        // Someone else renamed/uploaded to this name while we were
        // editing. Refresh the catalog so the user can see the
        // collision and retry with a different name.
        window.alert(
          `That filename is already in use by another event. ` +
            `Pick a different filename and try again.`,
        );
        await load();
        return;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        window.alert(
          `Rename failed: HTTP ${r.status}\n${txt.slice(0, 300)}`,
        );
        return;
      }
      await load();
      // Badges on other windows should refresh if this event happens
      // to be open in a dashboard tab.
      window.dispatchEvent(new CustomEvent("matbeast-cloud-sync-changed"));
    } finally {
      setBusyId(null);
    }
  }, [renameState, load, events]);

  const deleteCloudEvent = useCallback(
    async (meta: CloudEventMeta) => {
      setMenuOpenFor(null);
      const label = meta.eventName || meta.name;
      if (
        !window.confirm(
          `Delete "${label}" from the cloud?\n\nThe file will be removed from everyone's homepage. This cannot be undone from the app UI.`,
        )
      ) {
        return;
      }
      setBusyId(meta.id);
      try {
        const r = await fetch(
          `/api/cloud/events/${encodeURIComponent(meta.id)}`,
          { method: "DELETE" },
        );
        if (!r.ok && r.status !== 404) {
          const txt = await r.text().catch(() => "");
          window.alert(`Delete failed: HTTP ${r.status}\n${txt.slice(0, 300)}`);
          return;
        }
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const openCloudSettings = () => {
    window.dispatchEvent(
      new CustomEvent("matbeast-native-options", {
        detail: { source: "menu", action: "cloud" },
      }),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-start overflow-y-auto px-6 py-10 text-zinc-100">
      <div className="w-full max-w-3xl">
        <header className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="m-0 text-2xl font-bold tracking-tight">
              Mat Beast Scoreboard
            </h1>
            <p className="mt-1 text-[12px] text-zinc-400">
              Pick a cloud event to open, or create a new one. New events are
              saved to the cloud automatically.
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
              onClick={() => void createNew()}
              className="rounded bg-teal-700 px-4 py-1.5 text-[12px] font-semibold text-white hover:bg-teal-600"
            >
              + Create new event
            </button>
          </div>
        </header>

        {cfg === null ? (
          <p className="text-[12px] text-zinc-500">Loading…</p>
        ) : !cfg.configured ? (
          <div className="rounded border border-amber-700/50 bg-amber-900/20 p-4 text-[12px] text-amber-100">
            <p className="m-0 font-semibold">Cloud not configured</p>
            <p className="m-0 mt-1 text-amber-100/80">
              {!cfg.tokenSet
                ? "No desktop token saved on this install. Paste one from the Mat Beast Masters admin page to see your cloud event list here."
                : !cfg.syncEnabled
                  ? "Cloud sync is paused. Re-enable it to see your cloud event list here."
                  : "Cloud is unavailable."}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={openCloudSettings}
                className="rounded bg-amber-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-amber-600"
              >
                Open Cloud Settings
              </button>
            </div>
          </div>
        ) : error ? (
          <div className="rounded border border-red-700/50 bg-red-900/20 p-4 text-[12px] text-red-100">
            <p className="m-0 font-semibold">Could not reach the cloud</p>
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
          <p className="text-[12px] text-zinc-500">Loading cloud events…</p>
        ) : sortedEvents.length === 0 ? (
          <div className="rounded border border-zinc-700 bg-zinc-900/40 p-6 text-center text-[12px] text-zinc-300">
            <p className="m-0 font-semibold">No cloud events yet</p>
            <p className="m-0 mt-1 text-zinc-500">
              Create a new event — it will be saved to the cloud automatically
              as <code>UNTITLED</code>.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {sortedEvents.map((e) => {
              const eventTitle = (e.eventName ?? "").trim();
              const displayTitle = eventTitle.length > 0 ? eventTitle : e.name;
              const showSecondary =
                eventTitle.length > 0 && eventTitle !== e.name;
              const busy = busyId === e.id;
              const menuOpen = menuOpenFor === e.id;
              return (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition hover:border-teal-700/60 hover:bg-zinc-900"
                >
                  <div className="min-w-0 flex-1">
                    {renameState?.id === e.id ? (
                      <input
                        ref={renameInputRef}
                        autoFocus
                        value={renameState.draft}
                        onChange={(ev) =>
                          setRenameState((s) =>
                            s ? { ...s, draft: ev.target.value } : s,
                          )
                        }
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") void commitRename();
                          if (ev.key === "Escape") setRenameState(null);
                        }}
                        onBlur={() => void commitRename()}
                        className="m-0 w-full rounded border border-teal-700/60 bg-[#1e1e1e] px-1.5 py-0.5 text-[13px] font-semibold text-white outline-none"
                      />
                    ) : (
                      <p
                        className="m-0 cursor-text truncate rounded px-1 py-0.5 text-[13px] font-semibold text-zinc-100 hover:bg-white/5"
                        title="Double-click to rename filename"
                        onDoubleClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setRenameState({
                            id: e.id,
                            draft: e.name,
                            initial: e.name,
                          });
                        }}
                      >
                        {e.name}
                      </p>
                    )}
                    {showSecondary ? (
                      <p className="m-0 truncate text-[11px] text-zinc-300">
                        {displayTitle}
                      </p>
                    ) : null}
                    <p className="m-0 mt-0.5 text-[10px] text-zinc-500">
                      {fmtSize(e.sizeBytes)} · updated {fmtAgo(e.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openCloudEvent(e)}
                      className="rounded bg-teal-700 px-4 py-1.5 text-[11px] font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
                    >
                      {busy && !menuOpen ? "Opening…" : "Open"}
                    </button>
                    <div
                      className="relative"
                      onMouseDown={(ev) => ev.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        aria-label="More actions"
                        title="More actions"
                        onClick={() =>
                          setMenuOpenFor((prev) => (prev === e.id ? null : e.id))
                        }
                        className="flex h-7 w-7 items-center justify-center rounded border border-transparent text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-40"
                      >
                        {/* vertical 3-dot glyph */}
                        <span aria-hidden className="leading-none tracking-widest text-[16px]">⋮</span>
                      </button>
                      {menuOpen ? (
                        <div
                          role="menu"
                          className="absolute right-0 top-8 z-20 w-40 overflow-hidden rounded border border-zinc-700 bg-zinc-900 text-[12px] text-zinc-100 shadow-lg"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void copyCloudEvent(e)}
                            className="block w-full px-3 py-2 text-left hover:bg-zinc-800"
                          >
                            Make a copy
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void deleteCloudEvent(e)}
                            className="block w-full px-3 py-2 text-left text-red-300 hover:bg-red-900/40"
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
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
