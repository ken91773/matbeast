"use client";

import { useEffect, useState } from "react";
import {
  getPendingSyncCount,
  retrySyncNow,
  subscribePendingSync,
} from "@/lib/matbeast-sync-coordinator";
import { isMatbeastDemo } from "@/lib/matbeast-variant-client";

/**
 * Tiny header affordance that appears only when one or more events have
 * local edits not yet confirmed on the cloud. Shows the count and a
 * one-click "retry now" that resets the backoff and flushes immediately.
 *
 * The ambient per-tab CloudSyncBadge still owns the active tab's
 * synced/connecting/failed labelling; this is the *global* queue view so
 * the operator can see (and force) pending work for tabs that aren't in
 * focus — including ones closed while offline.
 */
export default function SyncPendingIndicator() {
  const [count, setCount] = useState<number>(() => getPendingSyncCount());
  const [retrying, setRetrying] = useState(false);

  useEffect(() => subscribePendingSync(setCount), []);

  if (isMatbeastDemo()) return null;
  if (count <= 0) return null;

  const onClick = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retrySyncNow();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={retrying}
      title={
        `${count} event${count === 1 ? "" : "s"} with local edits not yet on ` +
        `the cloud. They're saved locally and will sync automatically; click ` +
        `to retry now.`
      }
      className={[
        "select-none whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        "border-amber-600/60 bg-amber-950/40 text-amber-200",
        retrying ? "opacity-60" : "cursor-pointer hover:bg-amber-900/50",
      ].join(" ")}
    >
      {retrying
        ? "syncing…"
        : `${count} pending • retry`}
    </button>
  );
}
