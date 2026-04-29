"use client";

import { useCallback, useEffect, useState } from "react";

type TokenRow = {
  id: string;
  label: string;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
};

type MintResponse = {
  token: {
    id: string;
    label: string;
    tokenPreview: string;
    createdAt: string;
  };
  plaintext: string;
  warning: string;
};

const cardStyle: React.CSSProperties = {
  marginTop: 32,
  padding: 24,
  border: "1px solid #475569",
  borderRadius: 8,
  backgroundColor: "#1e293b",
};

const buttonStyle: React.CSSProperties = {
  padding: "10px 16px",
  fontSize: 14,
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

export default function DesktopTokensClient() {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [justMinted, setJustMinted] = useState<MintResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch("/api/desktop-tokens", { cache: "no-store" });
      if (!r.ok) {
        setLoadError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { tokens: TokenRow[] };
      setTokens(data.tokens);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleMint = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = label.trim();
      if (!trimmed) return;
      setMinting(true);
      setMintError(null);
      setJustMinted(null);
      setCopied(false);
      try {
        const r = await fetch("/api/desktop-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: trimmed }),
        });
        const data = (await r.json()) as MintResponse | { error: string };
        if (!r.ok) {
          setMintError(("error" in data && data.error) || `HTTP ${r.status}`);
        } else if ("plaintext" in data) {
          setJustMinted(data);
          setLabel("");
          await reload();
        }
      } catch (err) {
        setMintError(err instanceof Error ? err.message : "mint failed");
      } finally {
        setMinting(false);
      }
    },
    [label, reload],
  );

  const handleCopy = useCallback(async () => {
    if (!justMinted) return;
    try {
      await navigator.clipboard.writeText(justMinted.plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* user can copy manually from the textarea */
    }
  }, [justMinted]);

  const handleRevoke = useCallback(
    async (id: string, displayLabel: string) => {
      const confirmed = window.confirm(
        `Revoke token "${displayLabel}"? The desktop using this token will lose cloud access immediately.`,
      );
      if (!confirmed) return;
      setRevokingId(id);
      try {
        const r = await fetch(`/api/desktop-tokens/${id}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          window.alert(`Revoke failed: HTTP ${r.status}`);
        } else {
          await reload();
        }
      } catch (err) {
        window.alert(
          `Revoke failed: ${err instanceof Error ? err.message : "unknown"}`,
        );
      } finally {
        setRevokingId(null);
      }
    },
    [reload],
  );

  return (
    <>
      <section style={cardStyle}>
        <h2 style={{ marginTop: 0, fontSize: 20 }}>Generate a new token</h2>
        <p style={{ fontSize: 14, opacity: 0.75, lineHeight: 1.6 }}>
          Pick a label that identifies the device this token is for ({" "}
          <em>"Ken's laptop"</em>, <em>"Cage iPad"</em>, etc.). The token value
          is shown <strong>once only</strong> — copy it immediately and paste
          it into the desktop app's <strong>Cloud</strong> settings.
        </p>
        <form
          onSubmit={handleMint}
          style={{ display: "flex", gap: 8, alignItems: "stretch" }}
        >
          <input
            type="text"
            placeholder="Label (e.g. Ken's laptop)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={minting}
            maxLength={80}
            style={{
              flex: 1,
              padding: "10px 12px",
              fontSize: 14,
              border: "1px solid #475569",
              borderRadius: 6,
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
            }}
          />
          <button
            type="submit"
            disabled={minting || label.trim().length === 0}
            style={{
              ...buttonStyle,
              backgroundColor: minting ? "#475569" : "#3b82f6",
              color: "#fff",
              cursor: minting ? "wait" : "pointer",
            }}
          >
            {minting ? "Generating..." : "Generate token"}
          </button>
        </form>
        {mintError && (
          <p style={{ marginTop: 12, color: "#fca5a5", fontSize: 14 }}>
            Error: {mintError}
          </p>
        )}

        {justMinted && (
          <div
            style={{
              marginTop: 16,
              padding: 16,
              border: "2px solid #f59e0b",
              borderRadius: 6,
              backgroundColor: "#3a2a0a",
            }}
          >
            <p
              style={{
                margin: 0,
                marginBottom: 8,
                fontSize: 14,
                color: "#fde68a",
              }}
            >
              <strong>Copy this now</strong> — it will not be shown again.
            </p>
            <textarea
              readOnly
              value={justMinted.plaintext}
              onFocus={(e) => e.currentTarget.select()}
              rows={2}
              style={{
                width: "100%",
                fontFamily:
                  "ui-monospace, Menlo, Consolas, 'Courier New', monospace",
                fontSize: 13,
                padding: 8,
                borderRadius: 4,
                border: "1px solid #475569",
                backgroundColor: "#0f172a",
                color: "#fde68a",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              onClick={handleCopy}
              style={{
                ...buttonStyle,
                marginTop: 8,
                backgroundColor: copied ? "#16a34a" : "#3b82f6",
                color: "#fff",
              }}
            >
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={{ marginTop: 0, fontSize: 20 }}>Your tokens</h2>
        {loadError && (
          <p style={{ color: "#fca5a5", fontSize: 14 }}>
            Failed to load: {loadError}
          </p>
        )}
        {tokens === null && !loadError ? (
          <p style={{ fontSize: 14, opacity: 0.6 }}>Loading...</p>
        ) : tokens && tokens.length === 0 ? (
          <p style={{ fontSize: 14, opacity: 0.6 }}>No tokens yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
              }}
            >
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    borderBottom: "1px solid #475569",
                  }}
                >
                  <th style={{ padding: "8px 6px" }}>Label</th>
                  <th style={{ padding: "8px 6px" }}>Preview</th>
                  <th style={{ padding: "8px 6px" }}>Created</th>
                  <th style={{ padding: "8px 6px" }}>Last used</th>
                  <th style={{ padding: "8px 6px" }}>Status</th>
                  <th style={{ padding: "8px 6px" }}></th>
                </tr>
              </thead>
              <tbody>
                {(tokens ?? []).map((t) => {
                  const isRevoked = t.revokedAt !== null;
                  return (
                    <tr
                      key={t.id}
                      style={{
                        borderBottom: "1px solid #334155",
                        opacity: isRevoked ? 0.5 : 1,
                      }}
                    >
                      <td style={{ padding: "10px 6px" }}>
                        <strong>{t.label}</strong>
                      </td>
                      <td
                        style={{
                          padding: "10px 6px",
                          fontFamily:
                            "ui-monospace, Menlo, Consolas, monospace",
                          fontSize: 12,
                        }}
                      >
                        ...{t.tokenPreview}
                      </td>
                      <td style={{ padding: "10px 6px", fontSize: 12 }}>
                        {fmtDate(t.createdAt)}
                      </td>
                      <td style={{ padding: "10px 6px", fontSize: 12 }}>
                        {fmtDate(t.lastUsedAt)}
                      </td>
                      <td style={{ padding: "10px 6px", fontSize: 12 }}>
                        {isRevoked ? (
                          <span style={{ color: "#fca5a5" }}>
                            revoked {fmtDate(t.revokedAt)}
                          </span>
                        ) : (
                          <span style={{ color: "#86efac" }}>active</span>
                        )}
                      </td>
                      <td style={{ padding: "10px 6px", textAlign: "right" }}>
                        {!isRevoked && (
                          <button
                            type="button"
                            onClick={() => handleRevoke(t.id, t.label)}
                            disabled={revokingId === t.id}
                            style={{
                              ...buttonStyle,
                              padding: "6px 12px",
                              fontSize: 12,
                              backgroundColor: "#7f1d1d",
                              color: "#fff",
                            }}
                          >
                            {revokingId === t.id ? "..." : "Revoke"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
