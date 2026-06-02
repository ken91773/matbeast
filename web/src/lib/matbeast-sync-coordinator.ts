"use client";

/**
 * Background cloud-sync coordinator.
 *
 * The app is local-first: every edit is committed to SQLite by the
 * mutation routes before any cloud call. This coordinator is the layer
 * that makes the *cloud copy* eventually catch up, no matter what — even
 * if the cloud was unreachable when the edit happened, the tab was
 * closed, or the app was restarted.
 *
 * Responsibilities:
 *   - Drain the durable "needs sync" queue (`/api/cloud/events/pending`)
 *     by rebuilding + pushing each linked tournament that has unsynced
 *     local bytes — globally, not just the active tab.
 *   - Retry on a capped exponential backoff while anything stays pending.
 *   - Fire flushes the instant connectivity could have returned
 *     (startup, `online` event, window focus, cloud-online reconnect).
 *   - On a push conflict, write a local `.matb` backup of the offline
 *     edits first, then surface the existing conflict dialog so nothing
 *     is silently overwritten.
 *   - After the cloud has been failing for a tournament long enough,
 *     write a local `.matb` backup as a safety net.
 *   - Expose a live pending count + a manual "retry now" for the UI.
 */

import {
  pushLinkedTournamentInBackground,
  writeOfflineBackupForTournament,
} from "@/lib/matbeast-dashboard-file-actions";
import {
  probeCloud,
  subscribeCloudOnline,
} from "@/lib/matbeast-cloud-online";
import { isMatbeastDemo } from "@/lib/matbeast-variant-client";

type PendingEvent = {
  tournamentId: string;
  cloudEventId: string;
  name: string;
  lastError: string | null;
  pendingSince: string | null;
};

type PendingListener = (count: number) => void;

/** Write a disk backup once the cloud has been failing this long. */
const BACKUP_AFTER_MS = 5 * 60_000;
/** Backoff schedule for automatic retries while anything is pending. */
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
/** Ignore focus/online bursts that arrive closer together than this. */
const TRIGGER_THROTTLE_MS = 4_000;

let installed = false;
let flushing: Promise<void> | null = null;
let pendingCount = 0;
let backoffIndex = 0;
let retryTimer: number | null = null;
let lastTriggerAt = 0;

const pendingListeners = new Set<PendingListener>();
/** When the current failure streak for a tournament started (ms epoch). */
const firstFailAt = new Map<string, number>();
/** Tournaments we've already written an offline backup for this streak. */
const backedUpThisStreak = new Set<string>();

export function getPendingSyncCount(): number {
  return pendingCount;
}

export function subscribePendingSync(fn: PendingListener): () => void {
  pendingListeners.add(fn);
  try {
    fn(pendingCount);
  } catch {
    /* listeners must not throw */
  }
  return () => {
    pendingListeners.delete(fn);
  };
}

function setPendingCount(n: number) {
  if (n === pendingCount) return;
  pendingCount = n;
  for (const l of pendingListeners) {
    try {
      l(n);
    } catch {
      /* ignore */
    }
  }
}

async function fetchPending(): Promise<PendingEvent[]> {
  try {
    const r = await fetch("/api/cloud/events/pending", { cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as {
      configured?: boolean;
      pending?: PendingEvent[];
    };
    if (!j.configured) return [];
    return Array.isArray(j.pending) ? j.pending : [];
  } catch {
    return [];
  }
}

function clearStreak(tid: string) {
  firstFailAt.delete(tid);
  backedUpThisStreak.delete(tid);
}

/** Note a failed push and write a disk backup if it's been failing too long. */
async function noteFailureAndMaybeBackup(ev: PendingEvent) {
  const now = Date.now();
  const since = firstFailAt.get(ev.tournamentId) ?? now;
  if (!firstFailAt.has(ev.tournamentId)) firstFailAt.set(ev.tournamentId, now);
  if (
    now - since >= BACKUP_AFTER_MS &&
    !backedUpThisStreak.has(ev.tournamentId)
  ) {
    backedUpThisStreak.add(ev.tournamentId);
    try {
      await writeOfflineBackupForTournament(ev.tournamentId, ev.name);
    } catch {
      // Backup is a safety net; never let it break the sync loop.
    }
  }
}

/**
 * Drain the pending queue once. Deduped: concurrent callers share the
 * single in-flight run. Reschedules a backoff retry if anything is still
 * pending afterwards.
 */
export function flushPendingSync(): Promise<void> {
  if (isMatbeastDemo()) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    const pending = await fetchPending();
    setPendingCount(pending.length);
    if (pending.length === 0) {
      // Everything is synced — clear any streak/backoff state.
      firstFailAt.clear();
      backedUpThisStreak.clear();
      backoffIndex = 0;
      return;
    }

    let stillPending = 0;
    let sawTransientError = false;

    for (const ev of pending) {
      const outcome = await pushLinkedTournamentInBackground(
        ev.tournamentId,
        ev.name,
      );
      switch (outcome.kind) {
        case "ok":
        case "no-op":
        case "no-link":
          clearStreak(ev.tournamentId);
          break;
        case "conflict": {
          // Preserve the operator's offline edits before prompting.
          try {
            await writeOfflineBackupForTournament(ev.tournamentId, ev.name);
          } catch {
            /* best effort */
          }
          window.dispatchEvent(
            new CustomEvent("matbeast-cloud-conflict", {
              detail: {
                tournamentId: ev.tournamentId,
                localVersion: outcome.localVersion,
                cloudVersion: outcome.cloudVersion,
              },
            }),
          );
          // Leave it for the user to resolve; don't keep hammering.
          clearStreak(ev.tournamentId);
          break;
        }
        case "error":
          stillPending += 1;
          sawTransientError = true;
          await noteFailureAndMaybeBackup(ev);
          // The cloud is probably down for all of them — stop early to
          // avoid a burst of doomed requests.
          break;
      }
      if (sawTransientError) break;
    }

    // Recount from the durable source so the badge reflects reality even
    // if some pushes succeeded before the first failure.
    const after = await fetchPending();
    setPendingCount(after.length);
    stillPending = after.length;

    if (stillPending > 0) {
      scheduleBackoffRetry();
    } else {
      firstFailAt.clear();
      backedUpThisStreak.clear();
      backoffIndex = 0;
    }
  })();
  const done = flushing;
  void done.finally(() => {
    if (flushing === done) flushing = null;
  });
  return done;
}

function scheduleBackoffRetry() {
  if (retryTimer != null) return; // one timer at a time
  const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
  backoffIndex += 1;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flushPendingSync();
  }, delay);
}

/** Manual "retry now": reset backoff, probe, then flush immediately. */
export async function retrySyncNow(): Promise<void> {
  backoffIndex = 0;
  if (retryTimer != null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  try {
    await probeCloud();
  } catch {
    /* probe never throws, but be safe */
  }
  await flushPendingSync();
}

function trigger(reason: string) {
  const now = Date.now();
  if (now - lastTriggerAt < TRIGGER_THROTTLE_MS && reason !== "reconnect") {
    return;
  }
  lastTriggerAt = now;
  backoffIndex = 0; // a fresh external signal — try promptly
  if (retryTimer != null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  void flushPendingSync();
}

/**
 * Install the coordinator's triggers. Safe to call multiple times; only
 * the first call wires listeners. Returns a cleanup function.
 */
export function installSyncCoordinator(): () => void {
  if (typeof window === "undefined") return () => {};
  if (installed) return () => {};
  installed = true;

  const onOnline = () => trigger("online");
  const onFocus = () => trigger("focus");
  const onVisibility = () => {
    if (document.visibilityState === "visible") trigger("visibility");
  };
  const wasOffline = { current: false };
  const unsubscribeOnline = subscribeCloudOnline((next) => {
    const reconnected = wasOffline.current && next.online;
    wasOffline.current = !next.online;
    if (reconnected) trigger("reconnect");
  });

  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);

  // Startup reconciliation: flush anything left over from a previous
  // session (edited offline, then closed) shortly after launch.
  const startupTimer = window.setTimeout(() => {
    void flushPendingSync();
  }, 1_500);

  // Slow heartbeat so a long-idle session still notices pending work
  // (including events that became pending after a single failed push)
  // even without an explicit trigger. flushPendingSync() is cheap when
  // nothing is queued — it just reads the pending list and returns.
  const heartbeat = window.setInterval(() => {
    void flushPendingSync();
  }, 60_000);

  return () => {
    installed = false;
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    unsubscribeOnline();
    window.clearTimeout(startupTimer);
    window.clearInterval(heartbeat);
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
}
