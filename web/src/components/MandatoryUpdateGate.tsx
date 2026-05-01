"use client";

import { useEffect, useState } from "react";

/**
 * v1.2.10 mandatory update gate.
 *
 * Once Electron's `autoUpdater` (in `electron/main.js`) reports a newer
 * release version on GitHub, this full-screen overlay blocks ALL other
 * dashboard UI underneath until the user installs the update. The
 * operator cannot keep using the outdated version.
 *
 * Trigger conditions (the renderer subscribes to `onUpdateStateChange`
 * via the desktop preload):
 *   - `status === "available"`  → newer version detected, download not
 *                                 yet started; show "preparing" message.
 *   - `status === "downloading"`→ show the message with percent so the
 *                                 operator knows the wait isn't a hang.
 *   - `status === "downloaded"` → show the "Install & restart" button.
 *   - `status === "installing"` → show the "restarting" message; the
 *                                 next launch will be on the new version.
 *
 * We DO NOT block on:
 *   - `status === "up-to-date"` / `null`  → normal happy path.
 *   - `status === "checking"`            → a check is in flight but
 *                                          we don't yet know the outcome.
 *                                          Blocking here would cause a
 *                                          flicker on every cold launch.
 *   - `status === "offline" / "error"`   → the operator has no path to
 *                                          install (no internet or the
 *                                          updater feed is broken). We
 *                                          must not strand them; they
 *                                          may need to run an offline
 *                                          tournament. The header still
 *                                          surfaces the warning text.
 *   - `status === "disabled"`            → demo / dev / unpackaged.
 *
 * Mounted at the same level as `FirstLaunchPasswordGate` (see
 * `RouteChromeShell`). Skipped on `/overlay` routes (popped-out NDI
 * surfaces) just like the password gate.
 *
 * NOTE: This is intentionally a "soft" enforcement — there is no
 * password / signed assertion. The operator could in theory close
 * the app or block the network, but the update check + blocking
 * overlay mean a normal launch on a connected machine forces the
 * upgrade before any tournament work happens.
 */

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "up-to-date"
  | "offline"
  | "error"
  | "disabled";

type UpdateState = {
  status: UpdateStatus | string;
  message: string;
  downloadedVersion: string | null;
};

type DesktopBridge = {
  isDesktopApp?: boolean;
  getUpdateState?: () => Promise<UpdateState>;
  onUpdateStateChange?: (cb: (state: UpdateState) => void) => () => void;
  installDownloadedUpdate?: () => Promise<{ ok: boolean; reason?: string }>;
};

function getApi(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { matBeastDesktop?: DesktopBridge };
  return w.matBeastDesktop ?? null;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(7, 11, 22, 0.97)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  /**
   * Sit above every dashboard panel and even the first-launch
   * password gate (which is at 99999). Mandatory updates take
   * priority over the password gate — the user shouldn't enter a
   * password into an outdated build whose auth mechanism may have
   * changed in the new release.
   */
  zIndex: 100001,
  padding: 24,
};

const cardStyle: React.CSSProperties = {
  width: "min(520px, 94vw)",
  backgroundColor: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: 12,
  padding: 28,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
};

const buttonStyle: React.CSSProperties = {
  marginTop: 20,
  width: "100%",
  padding: "12px 18px",
  fontSize: 14,
  fontWeight: 600,
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  backgroundColor: "#0d9488",
  color: "#fff",
};

const buttonDisabledStyle: React.CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  opacity: 0.55,
};

export default function MandatoryUpdateGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [installBusy, setInstallBusy] = useState(false);

  useEffect(() => {
    const api = getApi();
    if (!api?.isDesktopApp) return;

    let cancelled = false;
    const unsub = api.onUpdateStateChange?.((next) => {
      if (cancelled) return;
      setState(next);
    });
    void api
      .getUpdateState?.()
      .then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
      try {
        unsub?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const status = state?.status as UpdateStatus | undefined;
  /**
   * Active states that block the app. We deliberately exclude
   * `checking` (would flicker every cold launch), `up-to-date`,
   * `offline`, `error`, `disabled` (operator can't act / shouldn't
   * be stranded).
   */
  const isBlocking =
    status === "available" ||
    status === "downloading" ||
    status === "downloaded" ||
    status === "installing";

  if (!isBlocking || !state) return <>{children}</>;

  const installable = status === "downloaded" && !installBusy;
  const showSpinner =
    status === "available" || status === "downloading" || installBusy;

  const headline =
    status === "downloaded"
      ? state.downloadedVersion
        ? `Update ${state.downloadedVersion} ready to install`
        : "Update ready to install"
      : status === "installing"
        ? "Installing update…"
        : "Update required";

  const body =
    state.message ||
    (status === "downloaded"
      ? "A newer version of Mat Beast Scoreboard is available. Install it to continue."
      : "A newer version of Mat Beast Scoreboard is available. Downloading now…");

  return (
    <>
      {children}
      <div
        style={overlayStyle}
        role="dialog"
        aria-modal="true"
        aria-label="Update required"
      >
        <div style={cardStyle}>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              color: "#f8fafc",
            }}
          >
            {headline}
          </h1>
          <p
            style={{
              marginTop: 14,
              marginBottom: 0,
              fontSize: 13,
              lineHeight: 1.55,
              color: "#cbd5e1",
            }}
          >
            This version of the app is out of date. You must install the
            latest release before you can continue using the app. The app
            will restart automatically once the update is installed.
          </p>
          <p
            style={{
              marginTop: 14,
              marginBottom: 0,
              fontSize: 12,
              lineHeight: 1.55,
              color: "#94a3b8",
            }}
          >
            {body}
          </p>

          {showSpinner ? (
            <div
              style={{
                marginTop: 18,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
              aria-live="polite"
            >
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: "#38bdf8",
                  animation: "matbeast-mandatory-update-pulse 1.2s infinite ease-in-out",
                }}
              />
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                {status === "installing"
                  ? "Restarting the app…"
                  : "Please wait — this can take a minute on slow connections."}
              </span>
            </div>
          ) : null}

          <button
            type="button"
            disabled={!installable}
            onClick={async () => {
              const api = getApi();
              if (!api?.installDownloadedUpdate) return;
              setInstallBusy(true);
              try {
                await api.installDownloadedUpdate();
              } catch {
                setInstallBusy(false);
              }
            }}
            style={installable ? buttonStyle : buttonDisabledStyle}
          >
            {status === "installing" || installBusy
              ? "Installing…"
              : status === "downloaded"
                ? "Install and restart"
                : "Preparing update…"}
          </button>
        </div>
        <style>{`
          @keyframes matbeast-mandatory-update-pulse {
            0%, 100% { opacity: 0.35; transform: scale(0.85); }
            50% { opacity: 1; transform: scale(1.15); }
          }
        `}</style>
      </div>
    </>
  );
}
