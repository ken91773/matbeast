"use client";

import { useCallback, useEffect, useState } from "react";

type CloudConfigSnapshot = {
  cloudBaseUrl: string;
  syncEnabled: boolean;
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 13,
  fontFamily: "ui-monospace, Menlo, Consolas, 'Courier New', monospace",
  border: "1px solid #475569",
  borderRadius: 6,
  backgroundColor: "#1e293b",
  color: "#e2e8f0",
  boxSizing: "border-box",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function CloudSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<CloudConfigSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tokenInput, setTokenInput] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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
      setTokenInput("");
      setSaveMsg(null);
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

  const saveToken = useCallback(async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setSavingToken(true);
    setSaveMsg(null);
    try {
      const r = await fetch("/api/cloud/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desktopToken: trimmed }),
      });
      const data = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !data.ok) {
        setSaveMsg({
          kind: "err",
          text: data.error || `Save failed (HTTP ${r.status})`,
        });
      } else {
        setSaveMsg({ kind: "ok", text: "Token saved." });
        setTokenInput("");
        await reload();
      }
    } catch (e) {
      setSaveMsg({
        kind: "err",
        text: e instanceof Error ? e.message : "save failed",
      });
    } finally {
      setSavingToken(false);
    }
  }, [tokenInput, reload]);

  const clearToken = useCallback(async () => {
    if (!window.confirm("Unlink this desktop from the cloud? Local data is unchanged. You'll need to paste a token again to re-link.")) {
      return;
    }
    setSavingToken(true);
    setSaveMsg(null);
    try {
      const r = await fetch("/api/cloud/config", { method: "DELETE" });
      if (!r.ok) {
        setSaveMsg({ kind: "err", text: `Unlink failed (HTTP ${r.status})` });
      } else {
        setSaveMsg({ kind: "ok", text: "Desktop unlinked from cloud." });
        await reload();
      }
    } finally {
      setSavingToken(false);
    }
  }, [reload]);

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
        <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6 }}>
          Sync the master player profile and master team name lists with the
          shared cloud database (Mat Beast Masters). Sync runs automatically
          when you open or edit a master list. Use this panel to link a new
          desktop, retry after going offline, or temporarily disable sync.
        </p>

        {loadError && (
          <p style={{ color: "#fca5a5", fontSize: 13 }}>
            Failed to load cloud config: {loadError}
          </p>
        )}

        {/* STATUS */}
        <div style={sectionTitle}>Status</div>
        {cfg ? (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>
              Linked:{" "}
              {cfg.tokenSet ? (
                <span style={{ color: "#86efac" }}>
                  yes ({cfg.tokenPreview ? `...${cfg.tokenPreview}` : "set"})
                </span>
              ) : (
                <span style={{ color: "#fca5a5" }}>no - paste a token below</span>
              )}
            </div>
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

        {/* SYNC NOW */}
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing || !cfg?.configured}
            title={!cfg?.configured ? "Paste a token first" : undefined}
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

        {/* LINK / RELINK */}
        <div style={sectionTitle}>Desktop token</div>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Generate a token at{" "}
          <code style={{ opacity: 0.85 }}>
            {(cfg?.cloudBaseUrl ?? "https://matbeast-masters.vercel.app").replace(/\/+$/, "")}
            /desktop-tokens
          </code>
          , then paste it below and click <strong>Save token</strong>.
        </p>
        <input
          type="password"
          placeholder="mbk_..."
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          disabled={savingToken}
          style={inputStyle}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={saveToken}
            disabled={savingToken || tokenInput.trim().length === 0}
            style={{
              ...buttonStyle,
              backgroundColor: savingToken ? "#475569" : "#16a34a",
              color: "#fff",
              cursor: savingToken ? "wait" : "pointer",
              opacity: tokenInput.trim().length === 0 ? 0.5 : 1,
            }}
          >
            {savingToken ? "Saving..." : "Save token"}
          </button>
          {cfg?.tokenSet && (
            <button
              type="button"
              onClick={clearToken}
              disabled={savingToken}
              style={{
                ...buttonStyle,
                backgroundColor: "#7f1d1d",
                color: "#fff",
              }}
            >
              Unlink desktop
            </button>
          )}
        </div>
        {saveMsg && (
          <p
            style={{
              marginTop: 8,
              fontSize: 13,
              color: saveMsg.kind === "ok" ? "#86efac" : "#fca5a5",
            }}
          >
            {saveMsg.text}
          </p>
        )}
      </div>
    </div>
  );
}
