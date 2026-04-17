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

type WriteTextFileResult = { ok: true } | { ok: false; error?: string };
type ReadTextFileResult = { ok: true; text: string } | { ok: false; error?: string };

interface MatBeastDesktopApi {
  isDesktopApp: boolean;
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
