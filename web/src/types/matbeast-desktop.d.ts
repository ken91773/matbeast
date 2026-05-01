import type {
  BracketMusicState,
  BracketMusicChooseResult,
  BracketMusicMutationResult,
} from "@/lib/bracket-music-state";

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
  /** Focus main `webContents` even when the window is already foreground (Windows keyboard routing after in-app actions). */
  restoreWebKeyboardFocus?: () => Promise<{ ok: boolean }>;
  /**
   * v1.2.9: First-launch password gate persistence under
   * `userData/first-launch-password.json`. Origin-stable so the
   * unlock survives the bundled Next server's per-launch port roll.
   */
  getFirstLaunchPasswordUnlocked?: () => Promise<{ ok: boolean; unlocked: boolean }>;
  setFirstLaunchPasswordUnlocked?: (
    unlocked: boolean,
  ) => Promise<{ ok: boolean }>;
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
  /** Read the persisted bracket overlay music state (or sane defaults). */
  getBracketMusicState?: () => Promise<BracketMusicState>;
  /** Open a native file picker scoped to audio files. */
  chooseBracketMusicFile?: () => Promise<BracketMusicChooseResult>;
  /** Clear the selection (operator's "NONE" choice). */
  clearBracketMusicFile?: () => Promise<BracketMusicMutationResult>;
  /** Switch to the bundled "DEFAULT" track shipped with the installer. */
  useBracketMusicDefault?: () => Promise<BracketMusicMutationResult>;
  /** PLAY/STOP toggle on the dashboard header. */
  setBracketMusicPlaying?: (playing: boolean) => Promise<BracketMusicMutationResult>;
  /** MONITOR toggle on the dashboard header (operator-PC audibility). */
  setBracketMusicMonitor?: (monitor: boolean) => Promise<BracketMusicMutationResult>;
  /** Subscribe to push-style updates whenever the bracket-music state changes. */
  onBracketMusicStateChange?: (cb: (state: BracketMusicState) => void) => () => void;
  /**
   * NDI network-binding bridge (v0.9.33+). The dashboard's Overlay-card
   * status pill renders a friendly adapter name (Wi-Fi / Ethernet / etc.)
   * + colored dot so the operator can see at a glance whether NDI is
   * pinned to a routable interface. Backend logic lives in
   * `electron/ndi-adapters.js` and `electron/ndi-config.js`; the
   * runtime config file is rewritten and a restart prompt fires when
   * `setNdiBinding` is called with a different preference.
   */
  getNdiState?: () => Promise<NdiStateSnapshot>;
  setNdiBinding?: (preference: NdiBindingPreference) => Promise<{
    ok: boolean;
    willTakeEffectAfterRestart?: boolean;
    snapshot?: NdiStateSnapshot;
    error?: string;
  }>;
  relaunchForNdiBinding?: () => Promise<{ ok: boolean }>;
  onNdiStateChange?: (cb: (state: NdiStateSnapshot) => void) => () => void;
  /**
   * v0.9.34: forward a captured PCM frame from the offscreen NDI
   * bracket renderer to the main process for `sender.audio()` dispatch.
   * `planar` is channel-major Float32 packed as ArrayBuffer
   * (`numChannels * numSamples * 4` bytes). Fire-and-forget — the
   * caller doesn't wait for an acknowledgement; missing frames are
   * inaudible compared to back-pressure on the audio thread.
   */
  pushNdiAudio?: (
    scene: "scoreboard" | "bracket",
    payload: {
      sampleRate: number;
      numChannels: number;
      numSamples: number;
      planar: ArrayBuffer;
    },
  ) => void;
}

export type NdiBindingPreference =
  | { kind: "auto" }
  | { kind: "ip"; ip: string }
  | { kind: "adapter"; adapterName: string };

export interface NdiAdapterEntry {
  adapterName: string;
  friendlyName: string;
  ip: string;
  type: "ethernet" | "wifi" | "bluetooth" | "virtual" | "loopback" | "other";
  isApipa: boolean;
  isLoopback: boolean;
  isLikelyVirtual: boolean;
  isRoutable: boolean;
}

export interface NdiStateSnapshot {
  preference: NdiBindingPreference;
  resolved: NdiAdapterEntry | null;
  adapters: NdiAdapterEntry[];
  feeds: {
    scoreboard: { running: boolean };
    bracket: { running: boolean };
  };
  configDir: string | null;
}

declare global {
  interface Window {
    matBeastDesktop?: MatBeastDesktopApi;
  }
}
