"use client";

/**
 * NDI status pill for the Overlay card header (v0.9.33+).
 *
 * Why this exists:
 *   The desktop app sends NDI on whichever NIC the operator's PC
 *   announces — and Windows announces APIPA / Bluetooth / Wi-Fi
 *   Direct virtual adapters by default, which is the root cause of
 *   the "source visible but blank preview" symptom we chased through
 *   v0.9.29-0.9.32. The fix is a per-app `ndi-config.v1.json` pinning
 *   NDI to one IP. The fix only matters if the operator can SEE
 *   which adapter NDI is bound to without parsing dotted-quad IPs;
 *   this pill renders the binding in plain English ("NDI: Wi-Fi")
 *   with a colored dot for at-a-glance status:
 *
 *     - Green: bound to a routable Ethernet / Wi-Fi adapter, so cross-
 *       PC delivery should work. Tooltip lists IP + active feeds.
 *     - Yellow: bound to APIPA (169.254.*) or a virtual adapter — NDI
 *       is announcing but remote receivers will see a blank preview.
 *       Click to switch.
 *     - Gray: no NDI feed has been started yet (informational only).
 *     - Red: NDI runtime config is missing or the configured IP is no
 *       longer present on the system (cable unplugged etc.).
 *
 * Click-to-cycle:
 *   Clicking the pill opens a small dropdown list of available
 *   adapters with friendly names. Selecting one calls
 *   `setNdiBinding({ kind: "ip", ip })` and prompts the operator to
 *   restart so `NDIlib_initialize()` picks up the new config.
 *
 * Network model:
 *   The pill is a thin renderer of `matBeastDesktop.getNdiState()` /
 *   `onNdiStateChange()`. No state lives here that the main process
 *   doesn't already own; restart-after-rebind is enforced at the
 *   `electron/ndi-config.js` boundary.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  NdiAdapterEntry,
  NdiBindingPreference,
  NdiStateSnapshot,
} from "@/types/matbeast-desktop";

type Tone = "green" | "yellow" | "gray" | "red";

function classifyTone(snapshot: NdiStateSnapshot | null): Tone {
  if (!snapshot) return "gray";
  const r = snapshot.resolved;
  if (!r) return "red";
  if (r.isApipa || r.isLikelyVirtual || r.isLoopback) return "yellow";
  if (!r.isRoutable) return "yellow";
  const anyRunning =
    snapshot.feeds.scoreboard.running || snapshot.feeds.bracket.running;
  return anyRunning ? "green" : "gray";
}

/** Compact label: "NDI: Wi-Fi", "NDI: Ethernet", "NDI: APIPA",
 *  "NDI: idle". Designed to fit in a 9-12 character pill so it
 *  doesn't wrap the Overlay card's controls row on smaller screens. */
function shortLabel(snapshot: NdiStateSnapshot | null): string {
  if (!snapshot || !snapshot.resolved) return "NDI: not bound";
  const r = snapshot.resolved;
  if (r.isApipa) return "NDI: APIPA";
  if (r.isLoopback) return "NDI: loopback";
  if (r.type === "wifi") return "NDI: Wi-Fi";
  if (r.type === "ethernet") return "NDI: Ethernet";
  if (r.type === "bluetooth") return "NDI: Bluetooth";
  if (r.type === "virtual") return "NDI: virtual";
  return `NDI: ${r.friendlyName}`;
}

function describeFeeds(snapshot: NdiStateSnapshot | null): string {
  if (!snapshot) return "";
  const live: string[] = [];
  if (snapshot.feeds.scoreboard.running) live.push("Scoreboard");
  if (snapshot.feeds.bracket.running) live.push("Bracket");
  if (live.length === 0) return "No NDI source running";
  return `${live.join(" + ")} broadcasting`;
}

function buildTooltip(snapshot: NdiStateSnapshot | null): string {
  if (!snapshot) return "NDI status unavailable.";
  const lines: string[] = [];
  if (snapshot.resolved) {
    const r = snapshot.resolved;
    lines.push(
      `Bound to: ${r.friendlyName} (${r.adapterName}) — ${r.ip}`,
    );
    if (r.isApipa) {
      lines.push(
        "WARNING: APIPA / link-local address. Remote receivers cannot reach this IP. Click to switch adapters.",
      );
    } else if (r.isLikelyVirtual) {
      lines.push(
        "WARNING: virtual adapter. Cross-PC delivery is unlikely. Click to switch adapters.",
      );
    } else if (!r.isRoutable) {
      lines.push("WARNING: non-routable address.");
    }
  } else {
    lines.push("No NDI binding — auto-select found no routable adapter.");
  }
  lines.push(describeFeeds(snapshot));
  if (snapshot.preference.kind === "auto") {
    lines.push("Mode: Auto-select (prefer Ethernet)");
  } else if (snapshot.preference.kind === "ip") {
    lines.push(`Mode: pinned to IP ${snapshot.preference.ip}`);
  } else {
    lines.push(`Mode: pinned to adapter ${snapshot.preference.adapterName}`);
  }
  lines.push("Click to choose a different adapter.");
  return lines.join("\n");
}

const TONE_CLASSES: Record<Tone, { dot: string; pill: string }> = {
  green: {
    dot: "bg-emerald-400 shadow-[0_0_4px_rgba(16,185,129,0.7)]",
    pill: "border-emerald-700/60 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/40",
  },
  yellow: {
    dot: "bg-amber-300 shadow-[0_0_4px_rgba(252,211,77,0.7)]",
    pill: "border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40",
  },
  gray: {
    dot: "bg-zinc-400",
    pill: "border-zinc-600/60 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/50",
  },
  red: {
    dot: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.7)]",
    pill: "border-red-700/60 bg-red-950/40 text-red-300 hover:bg-red-900/40",
  },
};

function isPreferenceSelected(
  pref: NdiBindingPreference,
  candidate: NdiBindingPreference,
): boolean {
  if (pref.kind !== candidate.kind) return false;
  if (pref.kind === "ip" && candidate.kind === "ip") return pref.ip === candidate.ip;
  if (pref.kind === "adapter" && candidate.kind === "adapter") {
    return pref.adapterName === candidate.adapterName;
  }
  return pref.kind === "auto";
}

export function NdiStatusPill() {
  const [snapshot, setSnapshot] = useState<NdiStateSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Mount: pull the initial snapshot and subscribe to live updates.
   * Outside the Electron preload (e.g. browser dev build) the bridge
   * is undefined and the pill stays gray with "Desktop only" tooltip.
   */
  useEffect(() => {
    const desk = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
    if (!desk?.getNdiState) return;
    let cancelled = false;
    desk
      .getNdiState()
      .then((state) => {
        if (!cancelled && state) setSnapshot(state);
      })
      .catch(() => {
        /* ignore — main process not ready, periodic push will fix this */
      });
    let unsubscribe: (() => void) | undefined;
    if (desk.onNdiStateChange) {
      unsubscribe = desk.onNdiStateChange((state) => {
        setSnapshot(state);
      });
    }
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  /** Close the dropdown on outside click. Plain DOM listener — no
   *  portal, so the dropdown is positioned relative to the pill. */
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const node = containerRef.current;
      if (!node) return;
      if (node.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const tone = classifyTone(snapshot);
  const label = shortLabel(snapshot);
  const tooltip = buildTooltip(snapshot);
  const adapters = useMemo<NdiAdapterEntry[]>(
    () => snapshot?.adapters ?? [],
    [snapshot?.adapters],
  );

  const desktopAvailable =
    typeof window !== "undefined" && !!window.matBeastDesktop?.setNdiBinding;

  /**
   * Persist + offer restart. The main process owns the restart prompt
   * (uses a native `dialog.showMessageBox`); we just call the IPC and
   * close the dropdown so the dialog steals focus cleanly.
   */
  const applyPreference = async (preference: NdiBindingPreference) => {
    if (!desktopAvailable || busy) return;
    const desk = window.matBeastDesktop;
    if (!desk?.setNdiBinding) return;
    setBusy(true);
    try {
      const result = await desk.setNdiBinding(preference);
      if (result?.snapshot) setSnapshot(result.snapshot);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  if (!desktopAvailable) {
    return (
      <span
        title="NDI status is only available in the desktop build."
        className="inline-flex items-center gap-1 rounded border border-zinc-700/60 bg-zinc-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" aria-hidden />
        NDI: web
      </span>
    );
  }

  const pref = snapshot?.preference ?? { kind: "auto" };

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${TONE_CLASSES[tone].pill}`}
        title={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${TONE_CLASSES[tone].dot}`}
          aria-hidden
        />
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded border border-zinc-700/80 bg-zinc-950/95 p-1 shadow-lg"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
            NDI network adapter
          </div>
          <div className="px-2 py-0.5 text-[10px] italic text-zinc-500">
            Restart applies the binding.
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={isPreferenceSelected(pref, { kind: "auto" })}
            onClick={() => {
              void applyPreference({ kind: "auto" });
            }}
            disabled={busy}
            className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] ${
              isPreferenceSelected(pref, { kind: "auto" })
                ? "bg-zinc-800/70 text-zinc-100"
                : "text-zinc-300 hover:bg-zinc-800/50"
            }`}
          >
            <span>Auto-select (prefer Ethernet)</span>
            {isPreferenceSelected(pref, { kind: "auto" }) ? (
              <span className="text-[10px] text-emerald-400">selected</span>
            ) : null}
          </button>
          <div className="my-1 border-t border-zinc-800" />
          {adapters.length === 0 ? (
            <div className="px-2 py-2 text-[11px] italic text-zinc-500">
              No network adapters detected.
            </div>
          ) : (
            adapters.map((adapter) => {
              const candidate: NdiBindingPreference = { kind: "ip", ip: adapter.ip };
              const selected = isPreferenceSelected(pref, candidate);
              const warn = adapter.isApipa
                ? "APIPA"
                : adapter.isLoopback
                  ? "loopback"
                  : adapter.isLikelyVirtual && adapter.type !== "wifi" && adapter.type !== "ethernet"
                    ? "virtual"
                    : null;
              return (
                <button
                  key={`${adapter.adapterName}-${adapter.ip}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    void applyPreference(candidate);
                  }}
                  disabled={busy}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] ${
                    selected
                      ? "bg-zinc-800/70 text-zinc-100"
                      : "text-zinc-300 hover:bg-zinc-800/50"
                  }`}
                  title={`${adapter.adapterName} • ${adapter.ip}${warn ? ` • ${warn}` : ""}`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">
                      {adapter.friendlyName}
                    </span>
                    <span className="truncate text-[10px] text-zinc-500">
                      {adapter.ip}
                      {warn ? `  •  ${warn}` : ""}
                    </span>
                  </span>
                  {selected ? (
                    <span className="text-[10px] text-emerald-400">selected</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
