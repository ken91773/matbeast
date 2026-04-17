"use client";

import { useCallback, useEffect, useState } from "react";

type UpdateState = {
  status: string;
  message: string;
  downloadedVersion: string | null;
};

function getApi() {
  if (typeof window === "undefined") return undefined;
  return window.matBeastDesktop;
}

export default function UpdateCheckModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [webMessage, setWebMessage] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);

  const refreshState = useCallback(async () => {
    const api = getApi();
    if (!api?.isDesktopApp) return;
    const next = await api.getUpdateState();
    setState(next);
  }, []);

  useEffect(() => {
    if (!open) {
      setState(null);
      setWebMessage(null);
      setInstallBusy(false);
      return;
    }

    const api = getApi();
    if (!api?.isDesktopApp) {
      setWebMessage(
        "Automatic updates are only available in the installed Windows desktop app.",
      );
      return;
    }

    let cancelled = false;
    const unsub = api.onUpdateStateChange((next) => {
      if (!cancelled) setState(next);
    });

    void (async () => {
      await refreshState();
      await api.checkForUpdates();
      if (!cancelled) await refreshState();
    })();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [open, refreshState]);

  if (!open) return null;

  const api = getApi();
  const desktop = Boolean(api?.isDesktopApp);
  const canInstall = desktop && state?.status === "downloaded";
  const busy =
    desktop &&
    (state?.status === "checking" ||
      state?.status === "downloading" ||
      state?.status === "installing" ||
      installBusy);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Check for updates"
    >
      <div className="w-full max-w-sm rounded-lg border border-zinc-600 bg-[#2d2d2d] shadow-2xl">
        <div className="border-b border-zinc-600 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Check for updates</h2>
        </div>
        <div className="px-4 py-4">
          {webMessage ? (
            <p className="text-sm text-zinc-300">{webMessage}</p>
          ) : state ? (
            <>
              <p className="text-sm text-zinc-200">{state.message}</p>
              {state.downloadedVersion ? (
                <p className="mt-2 text-xs text-teal-500/90">
                  Ready to install: v{state.downloadedVersion}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-zinc-400">Checking…</p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-600 px-4 py-3">
          {canInstall ? (
            <button
              type="button"
              disabled={busy}
              className="rounded bg-teal-600 px-3 py-1.5 text-sm font-semibold text-black hover:bg-teal-500 disabled:opacity-50"
              onClick={async () => {
                const a = getApi();
                if (!a) return;
                setInstallBusy(true);
                try {
                  await a.installDownloadedUpdate();
                } finally {
                  setInstallBusy(false);
                }
              }}
            >
              Install and restart
            </button>
          ) : null}
          <button
            type="button"
            className="rounded border border-zinc-500 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/10"
            onClick={onClose}
          >
            {webMessage ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
