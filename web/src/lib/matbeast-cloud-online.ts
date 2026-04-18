/**
 * Tiny pub/sub that tracks whether the cloud backend is currently
 * reachable from this session. A handful of call sites write into it
 * — the CloudSyncBadge poll, the save pipeline, the "new event"
 * pre-flight — and the badge + close-tab dialog subscribe to read.
 *
 * This is intentionally client-local (not persisted) because it is a
 * derived, in-the-moment signal: the truth is "did the most recent
 * cloud call succeed". A future reload or a transient network blip
 * will be corrected automatically by the first cloud call after the
 * reload.
 *
 * `reason` distinguishes three cases so the UI can show a different
 * label:
 *   - "ok"          → online (default on startup until proven otherwise).
 *   - "unreachable" → cloud is configured but the request timed out
 *                     or the proxy returned a non-2xx network error.
 *   - "not-configured" → `/api/cloud/config` says `configured=false`,
 *                     i.e. the user has no cloud credentials yet.
 *
 * For the badge label:
 *   - "unreachable"    → "CONNECTION LOST"
 *   - "not-configured" → "NO CLOUD" (configured by the user)
 */

export type CloudOnlineReason = "ok" | "unreachable" | "not-configured";

export type CloudOnlineState = {
  online: boolean;
  reason: CloudOnlineReason;
  /** `Date.now()` the most recent successful cloud call finished. */
  lastOkAt: number | null;
  /** `Date.now()` of the last failed attempt — helpful for debugging. */
  lastFailAt: number | null;
  /**
   * Short human-readable description of the most recent failure, or
   * null if we've never failed in this session. Populated by the
   * save-pipeline helpers so the cloud-sync indicator can show the
   * actual reason ("HTTP 401 invalid token", "network timeout", …)
   * even when no CloudEventLink row exists yet (e.g. the auto-link
   * upload itself is what's failing).
   */
  lastErrorMessage: string | null;
};

type Listener = (s: CloudOnlineState) => void;

let state: CloudOnlineState = {
  online: true,
  reason: "ok",
  lastOkAt: null,
  lastFailAt: null,
  lastErrorMessage: null,
};

const listeners = new Set<Listener>();

export function getCloudOnlineState(): CloudOnlineState {
  return state;
}

export function subscribeCloudOnline(fn: Listener): () => void {
  listeners.add(fn);
  // Push current state on subscribe so the subscriber never renders
  // with stale "online: true" defaults when it was started after a
  // failure.
  try {
    fn(state);
  } catch {
    /* swallow — listeners are not supposed to throw */
  }
  return () => {
    listeners.delete(fn);
  };
}

function publish(next: CloudOnlineState) {
  state = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch {
      /* ignore */
    }
  }
}

/** Record a successful cloud round-trip. */
export function markCloudReachable() {
  if (state.online && state.reason === "ok") {
    state = { ...state, lastOkAt: Date.now() };
    return;
  }
  publish({
    online: true,
    reason: "ok",
    lastOkAt: Date.now(),
    lastFailAt: state.lastFailAt,
    // Clear the cached error message — if we're back online, it
    // would only confuse the indicator to keep whispering the
    // previous failure reason.
    lastErrorMessage: null,
  });
}

/**
 * Record a failed cloud round-trip (timeout or non-2xx network error).
 *
 * `message` should be a short, user-legible summary of what failed
 * (e.g. `HTTP 502 masters service unreachable`, `network timeout`,
 * `auto-link upload failed: HTTP 401`). It is surfaced verbatim by
 * the cloud-sync indicator when the user clicks the red "save
 * failed" text, so keep it truthful and free of cryptic tokens.
 */
export function markCloudUnreachable(message?: string) {
  const msg = message?.trim() || null;
  publish({
    online: false,
    reason: "unreachable",
    lastOkAt: state.lastOkAt,
    lastFailAt: Date.now(),
    lastErrorMessage: msg ?? state.lastErrorMessage,
  });
}

/** Record that the cloud has no configuration on this install yet. */
export function markCloudNotConfigured() {
  publish({
    online: false,
    reason: "not-configured",
    lastOkAt: state.lastOkAt,
    lastFailAt: Date.now(),
    lastErrorMessage: state.lastErrorMessage,
  });
}

/**
 * Lightweight ping: calls `/api/cloud/config` + (best-effort) the
 * cloud-events list. Returns the new state snapshot so callers can
 * short-circuit on "not configured" vs "unreachable". Updates the
 * shared state as a side effect.
 *
 * Never throws — always resolves to a state. Includes an 8-second
 * timeout so a flaky proxy doesn't leave a "New event" call spinning
 * indefinitely.
 */
export async function probeCloud(timeoutMs = 8000): Promise<CloudOnlineState> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cfgRes = await fetch("/api/cloud/config", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!cfgRes.ok) {
      markCloudUnreachable();
      return state;
    }
    const cfg = (await cfgRes.json()) as { configured?: boolean };
    if (!cfg.configured) {
      markCloudNotConfigured();
      return state;
    }
    // Hit the cloud-events list to confirm the masters service is
    // actually reachable (the `/api/cloud/config` route runs purely
    // in the desktop server, so it can succeed while the masters
    // host is down).
    const listRes = await fetch("/api/cloud/events", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!listRes.ok) {
      markCloudUnreachable();
      return state;
    }
    markCloudReachable();
    return state;
  } catch {
    markCloudUnreachable();
    return state;
  } finally {
    window.clearTimeout(timer);
  }
}
