"use client";

import { useCallback, useEffect, useState } from "react";

type EventRow = {
  id: string;
  name: string;
  ownerUserId: string;
  currentVersion: number;
  currentBlobSha: string | null;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  updatedByUserId: string;
};

const cardStyle: React.CSSProperties = {
  marginTop: 32,
  padding: 24,
  border: "1px solid #475569",
  borderRadius: 8,
  backgroundColor: "#1e293b",
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function EventsClient({
  currentUserId: _currentUserId,
}: {
  currentUserId: string;
}) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch("/api/events", { cache: "no-store" });
      if (!r.ok) {
        setLoadError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { events: EventRow[] };
      setEvents(data.events);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRename = useCallback(
    async (id: string, oldName: string) => {
      const next = window.prompt("New name:", oldName);
      if (!next || next.trim() === oldName) return;
      setBusyId(id);
      try {
        const r = await fetch(`/api/events/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: next.trim() }),
        });
        if (!r.ok) window.alert(`Rename failed: HTTP ${r.status}`);
        else await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(`Delete "${name}"? Desktops still have their local copy, but this cloud record goes away.`)) return;
      setBusyId(id);
      try {
        const r = await fetch(`/api/events/${id}`, { method: "DELETE" });
        if (!r.ok) window.alert(`Delete failed: HTTP ${r.status}`);
        else await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <section style={cardStyle}>
      {loadError && (
        <p style={{ color: "#fca5a5", fontSize: 14 }}>
          Failed to load: {loadError}
        </p>
      )}
      {events === null && !loadError ? (
        <p style={{ fontSize: 14, opacity: 0.6 }}>Loading...</p>
      ) : events && events.length === 0 ? (
        <p style={{ fontSize: 14, opacity: 0.6 }}>
          No cloud events yet. Upload one from the desktop app via{" "}
          <strong>File &rarr; Upload to cloud</strong>.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #475569" }}>
                <th style={{ padding: "8px 6px" }}>Name</th>
                <th style={{ padding: "8px 6px" }}>Version</th>
                <th style={{ padding: "8px 6px" }}>Size</th>
                <th style={{ padding: "8px 6px" }}>Updated</th>
                <th style={{ padding: "8px 6px" }}></th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map((e) => (
                <tr key={e.id} style={{ borderBottom: "1px solid #334155" }}>
                  <td style={{ padding: "10px 6px" }}>
                    <strong>{e.name}</strong>
                  </td>
                  <td style={{ padding: "10px 6px" }}>v{e.currentVersion}</td>
                  <td style={{ padding: "10px 6px" }}>{fmtSize(e.sizeBytes)}</td>
                  <td style={{ padding: "10px 6px", fontSize: 12 }}>
                    {fmtDate(e.updatedAt)}
                  </td>
                  <td style={{ padding: "10px 6px", textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => handleRename(e.id, e.name)}
                      disabled={busyId === e.id}
                      style={{ ...buttonStyle, backgroundColor: "#475569", color: "#fff", marginRight: 6 }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(e.id, e.name)}
                      disabled={busyId === e.id}
                      style={{ ...buttonStyle, backgroundColor: "#7f1d1d", color: "#fff" }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
