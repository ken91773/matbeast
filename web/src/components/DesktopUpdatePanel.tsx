"use client";

import { useEffect, useMemo, useState } from "react";

type UpdateStatus =
  | "idle"
  | "disabled"
  | "checking"
  | "downloading"
  | "downloaded"
  | "installing"
  | "up-to-date"
  | "error";

type UpdateState = {
  status: UpdateStatus;
  message: string;
  downloadedVersion: string | null;
};

type UpdateApi = {
  isDesktopApp: boolean;
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string; state?: UpdateState }>;
  checkForUpdatesWithDebug: () => Promise<{
    ok: boolean;
    reason?: string;
    state?: UpdateState;
    logs?: string[];
  }>;
  getRuntimeInfo: () => Promise<{
    version: string;
    executablePath: string;
    isPackaged: boolean;
  }>;
  showUpdateDebugDialog: (logs: string[]) => Promise<{ ok: boolean }>;
  getUpdateState: () => Promise<UpdateState>;
  installDownloadedUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  onUpdateStateChange: (handler: (state: UpdateState) => void) => () => void;
};

declare global {
  interface Window {
    matBeastDesktop?: UpdateApi;
  }
}

const DEFAULT_STATE: UpdateState = {
  status: "idle",
  message: "Ready",
  downloadedVersion: null,
};

export default function DesktopUpdatePanel() {
  const [state, setState] = useState<UpdateState>(DEFAULT_STATE);
  const desktopApi = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
  const isDesktop = Boolean(desktopApi?.isDesktopApp);

  useEffect(() => {
    if (!isDesktop || !desktopApi) return;

    let mounted = true;
    void desktopApi.getUpdateState().then((nextState) => {
      if (mounted) {
        setState(nextState);
      }
    });

    const unsubscribe = desktopApi.onUpdateStateChange((nextState) => {
      setState(nextState);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [desktopApi, isDesktop]);

  const checkingOrDownloading = useMemo(() => {
    return state.status === "checking" || state.status === "downloading";
  }, [state.status]);

  if (!isDesktop || !desktopApi) {
    return null;
  }

  return (
    <section className="mt-6 rounded-md border border-zinc-700 bg-zinc-900 p-4 text-zinc-100">
      <h2 className="text-lg font-semibold">Application Updates</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Updates load from GitHub Releases. A background check runs about one minute after launch; details go to{" "}
        <code className="text-zinc-400">updater.log</code> next to your app data DB.
      </p>
      <p className="mt-2 text-sm text-zinc-300">{state.message}</p>
      {state.downloadedVersion ? (
        <p className="mt-1 text-xs text-zinc-400">Downloaded version: {state.downloadedVersion}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={async () => {
            const result = await desktopApi.checkForUpdatesWithDebug();
            const refreshed = await desktopApi.getUpdateState();
            setState(refreshed);
            await desktopApi.showUpdateDebugDialog(
              result.logs && result.logs.length > 0 ? result.logs : ["No debug logs returned."]
            );
            if (!result.ok && result.reason === "already-checking") {
              setState((prev) => ({
                ...prev,
                status: "checking",
                message: "Already checking for updates...",
              }));
            }
          }}
          disabled={checkingOrDownloading || state.status === "installing"}
        >
          Check for Updates
        </button>
        <button
          type="button"
          className="rounded border border-emerald-700 bg-emerald-800 px-3 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            void desktopApi.installDownloadedUpdate();
          }}
          disabled={state.status !== "downloaded"}
        >
          Install Update and Restart
        </button>
      </div>
    </section>
  );
}
