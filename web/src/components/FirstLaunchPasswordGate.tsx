"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * First-launch password gate.
 *
 * Renders a full-screen modal on the very first dashboard mount of
 * a fresh install. The operator must enter the access password
 * before any dashboard UI is mounted underneath. Once the correct
 * password is entered we persist an unlock flag so subsequent
 * launches skip the gate entirely.
 *
 * v1.2.9 persistence overhaul: the unlock flag is now stored via
 * Electron IPC in a JSON file under `userData/`, NOT `localStorage`.
 * Reason: the bundled Next server picks a fresh loopback port every
 * launch (`getFreeIpv4Port` in `electron/main.js`), which changes
 * the renderer origin (`http://127.0.0.1:<port>`). Browser
 * `localStorage` is keyed by origin, so the flag written on launch
 * N was invisible on launch N+1 — the operator was prompted on
 * EVERY launch instead of only the first. The IPC path survives
 * port changes; we keep `localStorage` as a fallback for the dev
 * browser session (where `matBeastDesktop` is undefined and the
 * dev port stays at 3000).
 *
 * Notes:
 *   - The gate is mounted by `RouteChromeShell`, which already
 *     short-circuits on `/overlay` routes. Overlay BrowserWindows
 *     (offscreen NDI surfaces, popped-out overlay output) are
 *     therefore never gated.
 *   - This is **not** a security boundary. The expected password
 *     lives in this source file and is trivially extractable from
 *     the shipped bundle. It exists to filter casual / unintended
 *     launches by people who weren't given the password verbally,
 *     not to defend against motivated attackers.
 *   - Children are rendered ONLY after the flag check completes,
 *     so unregistered installs never flash dashboard chrome before
 *     the gate appears.
 */
const PASSWORD_FLAG_KEY = "matbeast.firstLaunchPasswordEntered";
const REQUIRED_PASSWORD = "Kuwy";

type DesktopBridge = {
  getFirstLaunchPasswordUnlocked?: () => Promise<{ ok: boolean; unlocked: boolean }>;
  setFirstLaunchPasswordUnlocked?: (
    unlocked: boolean,
  ) => Promise<{ ok: boolean }>;
};

function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { matBeastDesktop?: DesktopBridge };
  return w.matBeastDesktop ?? null;
}

async function readUnlockFlag(): Promise<boolean> {
  const desk = getDesktopBridge();
  if (desk?.getFirstLaunchPasswordUnlocked) {
    try {
      const r = await desk.getFirstLaunchPasswordUnlocked();
      if (r && r.unlocked === true) return true;
      /**
       * One-time migration: if the desktop file says "locked" but
       * the legacy `localStorage` flag is set, the user already
       * unlocked under a previous origin/port. Promote it to the
       * persistent IPC store so they aren't re-prompted.
       */
      try {
        if (window.localStorage.getItem(PASSWORD_FLAG_KEY) === "true") {
          await desk.setFirstLaunchPasswordUnlocked?.(true);
          return true;
        }
      } catch {
        /* localStorage unavailable */
      }
      return false;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    return window.localStorage.getItem(PASSWORD_FLAG_KEY) === "true";
  } catch {
    return false;
  }
}

async function writeUnlockFlag(): Promise<void> {
  const desk = getDesktopBridge();
  if (desk?.setFirstLaunchPasswordUnlocked) {
    try {
      await desk.setFirstLaunchPasswordUnlocked(true);
    } catch {
      /* fall through */
    }
  }
  try {
    window.localStorage.setItem(PASSWORD_FLAG_KEY, "true");
  } catch {
    /* persistence failed — IPC path is the source of truth in production */
  }
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "#0b1220",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 99999,
  padding: 24,
};

const card: React.CSSProperties = {
  width: "min(440px, 92vw)",
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: 10,
  padding: 24,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 8,
  padding: "10px 12px",
  fontSize: 14,
  borderRadius: 6,
  border: "1px solid #475569",
  backgroundColor: "#1e293b",
  color: "#f8fafc",
  outline: "none",
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  marginTop: 16,
  width: "100%",
  padding: "10px 18px",
  fontSize: 13,
  fontWeight: 600,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  backgroundColor: "#0d9488",
  color: "#fff",
};

type GateState = "checking" | "locked" | "unlocked";

export default function FirstLaunchPasswordGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<GateState>("checking");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Read the persisted unlock flag once on mount. Source of truth in
   * production is the IPC-backed `userData/first-launch-password.json`
   * (see `electron/main.js`); browser/dev falls back to localStorage.
   * We deliberately default to LOCKED on any read failure so a
   * misconfigured renderer can never accidentally bypass the gate.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const unlocked = await readUnlockFlag();
      if (cancelled) return;
      setState(unlocked ? "unlocked" : "locked");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Autofocus the password field as soon as the gate becomes
   * visible so the operator can just start typing.
   */
  useEffect(() => {
    if (state !== "locked") return;
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [state]);

  const submit = useCallback(() => {
    if (draft === REQUIRED_PASSWORD) {
      void writeUnlockFlag();
      setError(null);
      setDraft("");
      setState("unlocked");
      return;
    }
    setError("Incorrect password.");
    setDraft("");
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [draft]);

  if (state === "checking") return null;
  if (state === "unlocked") return <>{children}</>;

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Access password">
      <div style={card}>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            color: "#f8fafc",
          }}
        >
          Mat Beast Scoreboard
        </h1>
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 13,
            lineHeight: 1.55,
            color: "#cbd5e1",
          }}
        >
          Enter the access password to launch this app for the first time.
        </p>

        <label
          htmlFor="matbeast-first-launch-password"
          style={{
            marginTop: 16,
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "#94a3b8",
          }}
        >
          Password
        </label>
        <input
          id="matbeast-first-launch-password"
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          style={inputStyle}
        />

        {error ? (
          <p
            style={{
              marginTop: 10,
              marginBottom: 0,
              fontSize: 12,
              color: "#fca5a5",
            }}
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <button type="button" onClick={submit} style={buttonStyle}>
          Continue
        </button>
      </div>
    </div>
  );
}
