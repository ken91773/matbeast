"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickNextDatedFilename } from "@/lib/matbeast-dashboard-file-actions";

/**
 * Modal shown before a new event is actually created. Collects:
 *
 *   - Event title (the human name that appears on the tab and in the
 *     dashboard header). Defaults to "UNTITLED EVENT".
 *   - Filename (the cloud catalog slot). Defaults to the next free
 *     `MMDD-N` slot based on a live probe of the cloud events list.
 *
 * The dialog pre-fetches `/api/cloud/events` once on mount so the
 * default `MMDD-N` reflects what's already in the cloud, and so we
 * can warn the user inline when they type a filename that would
 * collide with an existing cloud event.
 *
 * Submit is blocked while the default is still loading or while the
 * filename is empty. If the filename collides with an existing cloud
 * event we surface a warning and still let the user proceed (the
 * server will reject the upload with 502 if it really is a hard
 * collision — but the check here is best-effort and staying flexible
 * avoids false positives from stale data).
 */
export default function NewEventDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (result: {
    eventName: string;
    filename: string;
    trainingMode: boolean;
  }) => void;
}) {
  const [eventName, setEventName] = useState<string>("UNTITLED EVENT");
  const [filename, setFilename] = useState<string>("");
  const [existingNames, setExistingNames] = useState<string[] | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState<boolean>(false);
  const [trainingMode, setTrainingMode] = useState(false);
  const eventNameInputRef = useRef<HTMLInputElement | null>(null);

  const refreshCatalogNames = useCallback(async () => {
    try {
      const r = await fetch("/api/cloud/events", { cache: "no-store" });
      if (!r.ok) {
        setExistingNames([]);
        return [] as string[];
      }
      const data = (await r.json()) as {
        events?: Array<{ name?: string }>;
      };
      const names: string[] = [];
      for (const e of data.events ?? []) {
        const n = (e.name ?? "").trim();
        if (n) names.push(n);
      }
      setExistingNames(names);
      return names;
    } catch {
      setExistingNames([]);
      return [] as string[];
    }
  }, []);

  // Load defaults every time the dialog opens so reopening after
  // creating one event produces the next sequential `MMDD-N`.
  useEffect(() => {
    if (!open) {
      // Closing while the catalog fetch is in flight must not leave
      // `loadingDefaults` stuck true — the filename field stays disabled
      // and feels like "typing doesn't work" on the next open.
      setLoadingDefaults(false);
      return;
    }
    let cancelled = false;
    setEventName("UNTITLED EVENT");
    setFilename("");
    setTrainingMode(false);
    setExistingNames(null);
    setLoadingDefaults(true);
    void (async () => {
      try {
        const names = await refreshCatalogNames();
        if (cancelled) return;
        setFilename(pickNextDatedFilename(names));
      } finally {
        if (!cancelled) setLoadingDefaults(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refreshCatalogNames]);

  // Listen for the submit-level duplicate-detected event so the
  // dialog can refresh its cached catalog (so the inline collision
  // warning lights up the next time the user hits Create).
  useEffect(() => {
    if (!open) return;
    const onRefresh = () => {
      void refreshCatalogNames();
    };
    window.addEventListener(
      "matbeast-new-event-catalog-stale",
      onRefresh,
    );
    return () =>
      window.removeEventListener(
        "matbeast-new-event-catalog-stale",
        onRefresh,
      );
  }, [open, refreshCatalogNames]);

  // Autofocus + select the event title when the dialog opens so the
  // user can immediately start typing. Matches the rename dialog's
  // double-tick `autoFocus` + `setSelectionRange` pattern to survive
  // Electron's window-focus race.
  useEffect(() => {
    if (!open) return;
    const el = eventNameInputRef.current;
    if (!el) return;
    const t = window.setTimeout(() => {
      try {
        el.focus();
        el.setSelectionRange(0, el.value.length);
      } catch {
        /* best-effort */
      }
    }, 40);
    return () => window.clearTimeout(t);
  }, [open]);

  const trimmedFilename = filename.trim();
  const trimmedEventName = eventName.trim() || "UNTITLED EVENT";

  const collides = useMemo<boolean>(() => {
    if (!existingNames || !trimmedFilename) return false;
    const lc = trimmedFilename.toLowerCase();
    return existingNames.some((n) => n.toLowerCase() === lc);
  }, [existingNames, trimmedFilename]);

  /**
   * Creation is blocked when the filename collides with an
   * existing cloud event. The user must pick a unique name — the
   * masters service will reject a colliding upload with 409 anyway,
   * so surfacing the collision here saves a failed round-trip and
   * keeps the dialog open for editing.
   */
  const canSubmit =
    !loadingDefaults && trimmedFilename.length > 0 && !collides;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onSubmit({
      eventName: trimmedEventName,
      filename: trimmedFilename,
      trainingMode,
    });
  }, [canSubmit, onSubmit, trimmedEventName, trimmedFilename, trainingMode]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create new event"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.stopPropagation();
          handleSubmit();
        }
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-zinc-600 bg-[#2d2d2d] shadow-2xl">
        <div className="border-b border-zinc-600 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-white">New event</h2>
        </div>
        <div className="space-y-3 px-4 py-3 text-[12px] text-zinc-200">
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-400">
              Event title
            </span>
            <input
              ref={eventNameInputRef}
              type="text"
              className="w-full rounded border border-zinc-600 bg-[#1c1c1c] px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-[#1473e6]"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              placeholder="UNTITLED EVENT"
              maxLength={120}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-400">
              Filename
            </span>
            <input
              type="text"
              className="w-full rounded border border-zinc-600 bg-[#1c1c1c] px-2 py-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-[#1473e6]"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder={loadingDefaults ? "Loading…" : "MMDD-N"}
              maxLength={120}
              disabled={loadingDefaults}
            />
            {collides ? (
              <p className="mt-1 text-[10px] text-red-300">
                A cloud event with this filename already exists. Pick a
                different filename before creating.
              </p>
            ) : null}
            {loadingDefaults ? (
              <p className="mt-1 text-[10px] text-zinc-500">
                Fetching cloud catalog to pick the next available slot…
              </p>
            ) : null}
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-zinc-700/80 bg-zinc-900/40 px-2 py-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={trainingMode}
              onChange={(e) => setTrainingMode(e.target.checked)}
            />
            <span>
              <span className="block text-[11px] font-medium text-zinc-200">
                Training mode
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">
                Uses sample name data
              </span>
            </span>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-zinc-600 px-3 py-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-[#1473e6] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#0d5fbd] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
