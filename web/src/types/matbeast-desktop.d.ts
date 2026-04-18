export {};

type UpdateState = {
  status: string;
  message: string;
  downloadedVersion: string | null;
};

type OpenEventDialogResult =
  | { ok: true; filePath: string; text: string }
  | { ok: false; canceled?: boolean; error?: string };

type SaveEventDialogResult =
  | { ok: true; filePath: string }
  | { ok: false; canceled?: boolean };

type DefaultEventSavePathResult =
  | { ok: true; filePath: string }
  | { ok: false; error?: string };

type WriteTextFileResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * Structured reason so the renderer can branch on "recoverable vs
       * fatal" without string-matching the Windows error message.
       */
      reason?:
        | "bad-args"
        | "not-absolute"
        | "inside-install-dir"
        | "permission"
        | "fs-error"
        | "ipc-rejected";
      error?: string;
    };
type ReadTextFileResult = { ok: true; text: string } | { ok: false; error?: string };

type SampleEventMeta = {
  fileName: string;
  eventName: string | null;
  sizeBytes: number;
};

interface MatBeastDesktopApi {
  isDesktopApp: boolean;
  /**
   * Build variant. "demo" disables cloud sync, hides cloud UI, and makes
   * the Home page list bundled sample events instead of calling the
   * masters service. "production" is the full app.
   */
  variant?: "production" | "demo";
  /** Demo-only: list bundled sample events shipped with the installer. */
  listSampleEvents?: () => Promise<{ ok: true; events: SampleEventMeta[] } | { ok: false; error?: string }>;
  /** Demo-only: read a bundled sample event's .matb envelope text. */
  readSampleEvent?: (
    fileName: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; error?: string }>;
  /** Ensures scoreboard + bracket overlay output windows exist (Electron) and focuses them. */
  openScoreboardOverlayWindow?: () => Promise<{ ok: boolean }>;
  /** Push current tournament id to overlay output windows (desktop diagnostics). */
  setOverlayTournamentId?: (tournamentId: string | null) => Promise<{ ok: boolean }>;
  /** Snapshot the output overlay window pixels for preview mirroring. */
  captureOverlayPreview?: (
    scene: "scoreboard" | "bracket",
  ) => Promise<{ ok: true; dataUrl: string } | { ok: false; error?: string }>;
  showOpenEventDialog?: () => Promise<OpenEventDialogResult>;
  showSaveEventDialog?: (opts?: {
    defaultName?: string;
  }) => Promise<SaveEventDialogResult>;
  /** Documents/Mat Beast Scoreboard/Events/… — no dialog. */
  getDefaultEventSavePath?: (opts?: {
    defaultName?: string;
  }) => Promise<DefaultEventSavePathResult>;
  writeTextFile?: (filePath: string, text: string) => Promise<WriteTextFileResult>;
  readTextFile?: (filePath: string) => Promise<ReadTextFileResult>;
  addRecentDocument?: (filePath: string) => Promise<{ ok: true } | { ok: false }>;
  /** Pull current desktop preferences (closes the render-mount vs. did-finish-load race). */
  getDesktopPreferences?: () => Promise<{ autoSaveEvery5Minutes: boolean }>;
  /** Inform the main process whether the renderer is showing the home catalog or the event dashboard. */
  setWorkspaceViewState?: (state: {
    showingHome: boolean;
    hasTabs: boolean;
  }) => Promise<{ ok: boolean; changed?: boolean }>;
  /** Focus the main dashboard window (desktop); helps OS keyboard routing after Alt-Tab / overlay windows. */
  focusMainWindow?: () => Promise<{ ok: boolean }>;
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
  onFileMenu?: (cb: (action: string) => void) => () => void;
  onHelpMenu?: (cb: (action: string) => void) => () => void;
}

declare global {
  interface Window {
    matBeastDesktop?: MatBeastDesktopApi;
  }
}
