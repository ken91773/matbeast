"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getCloudOnlineState,
  markCloudNotConfigured,
  markCloudReachable,
  markCloudUnreachable,
  subscribeCloudOnline,
  type CloudOnlineState,
} from "@/lib/matbeast-cloud-online";
import { isMatbeastDemo } from "@/lib/matbeast-variant-client";

/* Mirror of cloud-events.ts SyncStatus but typed for client consumption. */
type SyncStatus =
  | { kind: "LOCAL_ONLY" }
  | { kind: "SYNCED"; version: number; lastSyncedAt: string | null }
  | { kind: "NOT_SYNCED"; version: number; reason: "dirty" | "pending" }
  | { kind: "CONFLICT"; localVersion: number; cloudVersion: number }
  | { kind: "OFFLINE"; version: number; lastError: string }
  | { kind: "SYNCING" };

type CloudProbe =
  | "ok"
  | "not-found"
  | "unreachable"
  | "not-configured"
  | "skipped";

type StatusPayload = {
  link: {
    cloudEventId: string;
    baseVersion: number;
    lastError: string | null;
  } | null;
  cloudMeta: { id: string; name: string; currentVersion: number } | null;
  cloudProbe?: CloudProbe;
  status: SyncStatus;
};

const POLL_LOCAL_MS = 3_000;
const POLL_CLOUD_MS = 30_000;

/**
 * Threshold after which a persistent cloud failure flips the label
 * from the ambient "connecting…" to a more alarming "save failed"
 * state. The goal is to stay quiet during ordinary blips (a single
 * flaky poll, a cold-start 502) but make sure the user notices when
 * pushes have been failing long enough to risk data loss.
 */
const PERSISTENT_FAIL_MS = 15_000;

/**
 * Minimal cloud-sync indicator.
 *
 * Renders small muted text next to the dashboard toolbar instead of
 * the old coloured chip. The user only needs three signals:
 *
 *   - "synced"        → cloud has the latest bytes and we're happy.
 *   - "saving…"       → a push is in flight or queued (dirty tab,
 *                        pending upload, conflict waiting on modal).
 *                        Ambient status; no action needed.
 *   - "connecting…"   → the cloud is unreachable right now. Edits
 *                        are preserved locally and will flush when
 *                        the connection returns.
 *   - "save failed"   → "connecting…" has persisted long enough
 *                        (see `PERSISTENT_FAIL_MS`) that the user
 *                        should take notice. Clicking opens an
 *                        alert with the actual HTTP/push error
 *                        message so they can tell whether it's a
 *                        network problem or something structural
 *                        (e.g. an auth token being rejected).
 *
 * "NO CLOUD" (user hasn't configured cloud sync) renders nothing.
 */
/**
 * Thin variant shim. In demo builds we never mount the full
 * CloudSyncBadgeInner (and its effects / fetches), so the hook order
 * stays trivially stable and we don't pay for cloud status polling
 * just to render a muted label. Production builds take the normal
 * path below.
 */
export default function CloudSyncBadge(props: { tournamentId: string | null }) {
  if (isMatbeastDemo()) {
    return (
      <span
        className="select-none text-[11px] font-semibold uppercase tracking-wider text-amber-300/80"
        title="Demo build — cloud sync is disabled"
      >
        demo
      </span>
    );
  }
  return <CloudSyncBadgeInner {...props} />;
}

function CloudSyncBadgeInner({
  tournamentId,
}: {
  tournamentId: string | null;
}) {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [cloudOnline, setCloudOnline] = useState<CloudOnlineState>(
    getCloudOnlineState(),
  );
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const lastCloudCheckRef = useRef<number>(0);
  /**
   * Wall-clock of the first failed outcome since the last successful
   * cycle. `null` when nothing is failing right now. We use a ref
   * plus a state `nowTick` so the memo re-runs on a timer without
   * requiring every refresh() call to re-render the whole subtree.
   */
  const firstFailAtRef = useRef<number | null>(null);
  const [firstFailAt, setFirstFailAt] = useState<number | null>(null);
  const setFailAt = useCallback((v: number | null) => {
    firstFailAtRef.current = v;
    setFirstFailAt(v);
  }, []);

  const refresh = useCallback(
    async (opts?: { checkCloud?: boolean }) => {
      if (!tournamentId) {
        setPayload(null);
        return;
      }
      try {
        const url = new URL("/api/cloud/events/status", window.location.origin);
        url.searchParams.set("tournamentId", tournamentId);
        if (opts?.checkCloud) {
          url.searchParams.set("checkCloud", "1");
          lastCloudCheckRef.current = Date.now();
        }
        const r = await fetch(url.toString(), { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as StatusPayload;
        setPayload(data);
        if (opts?.checkCloud) {
          const probe: CloudProbe | undefined =
            data.cloudProbe ??
            (data.link
              ? data.cloudMeta
                ? "ok"
                : "unreachable"
              : "skipped");
          switch (probe) {
            case "ok":
            case "not-found":
              markCloudReachable();
              break;
            case "unreachable":
              markCloudUnreachable();
              break;
            case "not-configured":
              markCloudNotConfigured();
              break;
            case "skipped":
            default:
              break;
          }
        }
      } catch {
        markCloudUnreachable();
      }
    },
    [tournamentId],
  );

  // Subscribe to the cross-cutting cloud-online signal so the label
  // flips the moment the save pipeline reports a disconnect —
  // instead of waiting for the next poll tick.
  const wasOfflineRef = useRef<boolean>(false);
  useEffect(() => {
    return subscribeCloudOnline((next) => {
      const reconnected = wasOfflineRef.current && next.online;
      wasOfflineRef.current = !next.online;
      setCloudOnline(next);
      if (reconnected && tournamentId) {
        // Clear the persistent-fail timer on reconnect so the red
        // "save failed" label drops back to "synced"/"saving" once
        // the retry lands.
        setFailAt(null);
        window.dispatchEvent(
          new CustomEvent("matbeast-request-save", {
            detail: {
              tabId: tournamentId,
              silent: true,
              reason: "reconnect-retry",
            },
          }),
        );
        void refresh({ checkCloud: true });
      }
    });
  }, [tournamentId, refresh, setFailAt]);

  // Initial + polling loop.
  useEffect(() => {
    if (!tournamentId) return;
    void refresh({ checkCloud: true });
    const localTimer = window.setInterval(() => {
      const sinceCloud = Date.now() - lastCloudCheckRef.current;
      void refresh({ checkCloud: sinceCloud >= POLL_CLOUD_MS });
      setNowTick(Date.now());
    }, POLL_LOCAL_MS);
    return () => window.clearInterval(localTimer);
  }, [tournamentId, refresh]);

  // Refresh whenever save flow broadcasts a status change.
  useEffect(() => {
    const onChanged = () => {
      void refresh();
    };
    window.addEventListener("matbeast-cloud-sync-changed", onChanged);
    return () =>
      window.removeEventListener("matbeast-cloud-sync-changed", onChanged);
  }, [refresh]);

  /**
   * Derive the user-facing label from the combined global cloud
   * state + per-tab sync status. Keeps a single source of truth
   * for labelling so nothing can diverge — e.g. a "synced" chip
   * while CONNECTION LOST was happening elsewhere.
   */
  const label = useMemo<
    null | {
      text: string;
      title: string;
      tone: string;
      severity: "ok" | "saving" | "connecting" | "failed";
      error: string | null;
    }
  >(() => {
    if (!tournamentId) return null;
    if (cloudOnline.reason === "not-configured") return null;

    // Prefer the per-tab link error (set after a normal push
    // fails) but fall back to the global online-state's cached
    // error — which the save pipeline populates even when no
    // CloudEventLink exists yet (auto-link upload path).
    const linkError = payload?.link?.lastError?.trim() || null;
    const globalError = cloudOnline.lastErrorMessage?.trim() || null;
    const anyError = linkError ?? globalError;

    // Global cloud unreachable — label depends on how long it has
    // been failing. Short blip → ambient "connecting…". Sustained →
    // red "save failed" with clickable details.
    if (!cloudOnline.online) {
      const since = firstFailAt ?? Date.now();
      const persistent = nowTick - since >= PERSISTENT_FAIL_MS;
      if (persistent) {
        return {
          text: "save failed",
          severity: "failed",
          title:
            "Cloud save has been failing for more than 15 seconds. Your " +
            "latest edits are still safe on this machine. Click for details.",
          tone: "text-red-400",
          error: anyError,
        };
      }
      return {
        text: "connecting…",
        severity: "connecting",
        title: anyError
          ? `Cloud server is unreachable. Last error: ${anyError}`
          : "Cloud server is unreachable. Edits are preserved locally and will " +
            "sync automatically when the connection returns.",
        tone: "text-amber-300/80",
        error: anyError,
      };
    }

    if (!payload) {
      return {
        text: "connecting…",
        severity: "connecting",
        title: "Checking cloud sync…",
        tone: "text-zinc-500",
        error: null,
      };
    }

    const s = payload.status;
    switch (s.kind) {
      case "SYNCED":
        return {
          text: "synced",
          severity: "ok",
          title: s.lastSyncedAt
            ? `Cloud has your latest changes (v${s.version}).`
            : `Cloud has your latest changes.`,
          tone: "text-emerald-400/80",
          error: null,
        };
      case "LOCAL_ONLY":
        return {
          text: "saving…",
          severity: "saving",
          title:
            "Not in the cloud yet. The app will upload this event on the next save.",
          tone: "text-zinc-400",
          error: null,
        };
      case "NOT_SYNCED":
        return {
          text: "saving…",
          severity: "saving",
          title:
            s.reason === "dirty"
              ? "You have unsynced local changes. They'll push on the next save."
              : "A cloud push is queued.",
          tone: "text-zinc-400",
          error: null,
        };
      case "SYNCING":
        return {
          text: "saving…",
          severity: "saving",
          title: "Pushing changes to the cloud…",
          tone: "text-zinc-400",
          error: null,
        };
      case "CONFLICT":
        return {
          text: "saving…",
          severity: "saving",
          title: `Cloud moved to v${s.cloudVersion}; you're at v${s.localVersion}. Waiting for conflict resolution.`,
          tone: "text-zinc-400",
          error: null,
        };
      case "OFFLINE":
        // Server-side OFFLINE: the last push attempt failed but
        // the cloud probe hasn't caught up yet. Use the same
        // blip-vs-persistent split as the global offline branch.
        return {
          text: nowTick - (firstFailAt ?? nowTick) >= PERSISTENT_FAIL_MS
            ? "save failed"
            : "connecting…",
          severity:
            nowTick - (firstFailAt ?? nowTick) >= PERSISTENT_FAIL_MS
              ? "failed"
              : "connecting",
          title: `Last push failed: ${s.lastError}`,
          tone:
            nowTick - (firstFailAt ?? nowTick) >= PERSISTENT_FAIL_MS
              ? "text-red-400"
              : "text-amber-300/80",
          error: s.lastError,
        };
      default:
        return null;
    }
  }, [payload, tournamentId, cloudOnline, firstFailAt, nowTick]);

  // Update the persistent-failure timer whenever the severity moves
  // in/out of a failing state. Done as a side effect so every render
  // doesn't stamp a new timestamp.
  useEffect(() => {
    if (!label) {
      setFailAt(null);
      return;
    }
    const failing =
      label.severity === "connecting" || label.severity === "failed";
    if (failing) {
      if (firstFailAtRef.current == null) {
        setFailAt(Date.now());
      }
    } else {
      if (firstFailAtRef.current != null) setFailAt(null);
    }
  }, [label, setFailAt]);

  const onClick = useCallback(() => {
    if (!label) return;
    if (label.severity === "failed") {
      window.alert(
        [
          "Cloud save is currently failing.",
          "",
          "Your latest edits are held in memory on this machine, so they're " +
            "not lost — but they won't be on the cloud until the app can reach " +
            "it again.",
          "",
          label.error
            ? `Last error reported by the server:\n${label.error}`
            : "No specific error message was returned; this usually means a " +
              "network timeout or a cold-start 5xx from the cloud.",
          "",
          "If this persists, use File ▸ Backup copy to disk before closing " +
            "the app to preserve your edits.",
        ].join("\n"),
      );
    } else if (label.severity === "connecting" && label.error) {
      // Still ambient — quick glance at the underlying reason.
      window.alert(`Cloud sync reconnecting.\n\nLast error: ${label.error}`);
    }
  }, [label]);

  if (!label) return null;

  const clickable =
    label.severity === "failed" ||
    (label.severity === "connecting" && Boolean(label.error));

  return (
    <span
      title={label.title}
      onClick={clickable ? onClick : undefined}
      className={[
        "select-none whitespace-nowrap text-[10px] italic",
        label.tone,
        clickable ? "cursor-pointer underline decoration-dotted" : "",
      ].join(" ")}
    >
      {label.text}
    </span>
  );
}
