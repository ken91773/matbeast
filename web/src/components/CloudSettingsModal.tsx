"use client";

import { useCallback, useEffect, useState } from "react";

type CloudConfigSnapshot = {
  cloudBaseUrl: string;
  syncEnabled: boolean;
  /** When false, live Master* lists are not downloaded from the cloud on each open. */
  liveMastersPullFromCloud: boolean;
  /** Legacy v1.1.x field. v1.2.0 ignores this for gating. */
  tokenSet: boolean;
  tokenPreview: string;
  configured: boolean;
  lastProfilesPullAt: string | null;
  lastTeamNamesPullAt: string | null;
  lastSyncError: string | null;
  outboxCount: number;
  updatedAt: string;
};

type SyncResult = {
  teams?: { pulled: number; drainedOps: number; remainingOps: number; error?: string };
  profiles?: { pulled: number; drainedOps: number; remainingOps: number; error?: string };
  pulled?: number;
  drainedOps?: number;
  remainingOps?: number;
  error?: string;
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const card: React.CSSProperties = {
  width: "min(680px, 92vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: 10,
  padding: 24,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const sectionTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "#94a3b8",
  marginTop: 24,
  marginBottom: 8,
  borderBottom: "1px solid #334155",
  paddingBottom: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * v1.2.0 Cloud Settings.
 *
 * Mat Beast Masters is now a single shared workspace with no
 * authentication, so this panel is purely informational + control:
 * the operator can see the cloud URL, last sync timestamps, pending
 * outbox count, pause / resume the live-master pulls or the cloud
 * sync entirely, and trigger a manual sync.
 *
 * The legacy "Desktop token" section is gone — the cloud no longer
 * issues or requires tokens. Old installs that still have a saved
 * token will keep sending it (purely for audit-trail continuity);
 * nothing in the UI mentions it.
 */
export default function CloudSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<CloudConfigSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch("/api/cloud/config", { cache: "no-store" });
      if (!r.ok) {
        setLoadError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as CloudConfigSnapshot;
      setCfg(data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    if (open) {
      void reload();
      setLastSyncSummary(null);
    }
  }, [open, reload]);

  // Esc closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const toggleSync = useCallback(async () => {
    if (!cfg) return;
    try {
      await fetch("/api/cloud/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncEnabled: !cfg.syncEnabled }),
      });
      await reload();
    } catch {
      /* ignore */
    }
  }, [cfg, reload]);

  const toggleLiveMastersPull = useCallback(async () => {
    if (!cfg) return;
    try {
      await fetch("/api/cloud/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          liveMastersPullFromCloud: !cfg.liveMastersPullFromCloud,
        }),
      });
      await reload();
    } catch {
      /* ignore */
    }
  }, [cfg, reload]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setLastSyncSummary(null);
    try {
      const r = await fetch("/api/cloud/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "all" }),
      });
      const data = (await r.json()) as SyncResult;
      const t = data.teams;
      const p = data.profiles;
      const parts: string[] = [];
      if (t) parts.push(`teams: pulled ${t.pulled}, pushed ${t.drainedOps}, remaining ${t.remainingOps}${t.error ? ` (err: ${t.error})` : ""}`);
      if (p) parts.push(`profiles: pulled ${p.pulled}, pushed ${p.drainedOps}, remaining ${p.remainingOps}${p.error ? ` (err: ${p.error})` : ""}`);
      setLastSyncSummary(parts.join(" | ") || "Sync complete.");
      await reload();
    } catch (e) {
      setLastSyncSummary(`Sync failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setSyncing(false);
    }
  }, [reload]);

  if (!open) return null;

  return (
    <div
      style={overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>Cloud sync</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ ...buttonStyle, backgroundColor: "#334155", color: "#fff" }}
          >
            Close
          </button>
        </div>
        <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, marginTop: 8 }}>
          Mat Beast Scoreboard syncs the master player profile list, the
          master team name list, and your event catalog with the shared
          Mat Beast Masters cloud. Sync runs automatically when you open
          or edit a master list. Use this panel to retry after going
          offline, temporarily pause sync, or check status.
        </p>

        {loadError && (
          <p style={{ color: "#fca5a5", fontSize: 13 }}>
            Failed to load cloud config: {loadError}
          </p>
        )}

        <div style={sectionTitle}>Status</div>
        {cfg ? (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>
              Sync enabled:{" "}
              <span style={{ color: cfg.syncEnabled ? "#86efac" : "#fca5a5" }}>
                {cfg.syncEnabled ? "yes" : "no (paused)"}
              </span>{" "}
              <button
                type="button"
                onClick={toggleSync}
                style={{
                  ...buttonStyle,
                  marginLeft: 8,
                  padding: "4px 10px",
                  fontSize: 12,
                  backgroundColor: "#475569",
                  color: "#fff",
                }}
              >
                {cfg.syncEnabled ? "Pause" : "Resume"}
              </button>
            </div>
            <div>
              Pull live masters from cloud:{" "}
              <span
                style={{
                  color: (cfg.liveMastersPullFromCloud ?? true) ? "#86efac" : "#fbbf24",
                }}
              >
                {(cfg.liveMastersPullFromCloud ?? true)
                  ? "yes"
                  : "no (live lists stay local)"}
              </span>{" "}
              <button
                type="button"
                onClick={toggleLiveMastersPull}
                style={{
                  ...buttonStyle,
                  marginLeft: 8,
                  padding: "4px 10px",
                  fontSize: 12,
                  backgroundColor: "#475569",
                  color: "#fff",
                }}
              >
                {(cfg.liveMastersPullFromCloud ?? true) ? "Pause pulls" : "Resume pulls"}
              </button>
            </div>
            <p style={{ fontSize: 11, opacity: 0.7, marginTop: 4, maxWidth: 560, lineHeight: 1.45 }}>
              After sample master data is moved into training-only lists, pulls can stay off so the
              cloud does not refill your <strong>live</strong> master list. Resume when you want to
              download live masters from Mat Beast Masters again.
            </p>
            <div>Cloud URL: <code style={{ opacity: 0.8 }}>{cfg.cloudBaseUrl}</code></div>
            <div>Last team-names pull: {fmtDate(cfg.lastTeamNamesPullAt)}</div>
            <div>Last profiles pull: {fmtDate(cfg.lastProfilesPullAt)}</div>
            <div>
              Pending uploads:{" "}
              <span style={{ color: cfg.outboxCount > 0 ? "#fbbf24" : "#86efac" }}>
                {cfg.outboxCount}
              </span>
            </div>
            {cfg.lastSyncError && (
              <div style={{ color: "#fca5a5", marginTop: 6 }}>
                Last error: {cfg.lastSyncError}
              </div>
            )}
          </div>
        ) : !loadError ? (
          <p style={{ fontSize: 13, opacity: 0.6 }}>Loading...</p>
        ) : null}

        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing || !cfg?.configured}
            title={!cfg?.configured ? "Cloud sync is paused — resume it first" : undefined}
            style={{
              ...buttonStyle,
              backgroundColor: syncing ? "#475569" : "#3b82f6",
              color: "#fff",
              cursor: syncing || !cfg?.configured ? "not-allowed" : "pointer",
              opacity: !cfg?.configured ? 0.5 : 1,
            }}
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
          {lastSyncSummary && (
            <p style={{ fontSize: 12, marginTop: 8, opacity: 0.85 }}>
              {lastSyncSummary}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
