"use client";

import { useEffect } from "react";
import {
  applySelectedAudioOutputToContext,
  audioContextSupportsSinkSelection,
  onAudioOutputChanged,
} from "@/lib/audio-output";
import type { BracketMusicState } from "@/lib/bracket-music-state";

/**
 * Stable URL the renderer uses to fetch whatever audio file the operator
 * picked. Main process registers `mat-beast-asset` as a privileged scheme
 * (see `electron/main.js → registerBracketMusicProtocol`) and the handler
 * streams the configured file. The renderer never sees the absolute host
 * path — it just loads this URL and adds `?r=…` to cache-bust when the
 * underlying file changes.
 */
const MUSIC_URL_BASE = "mat-beast-asset://music/track";

/**
 * `AudioContext.setSinkId` accepts either a device-id string or
 * `{ type: "none" }` to consume the graph without producing any local
 * output. The "none" form is exactly what we want for the operator's
 * MONITOR=off state — the music still flows through the AudioContext (so
 * a future NDI worklet tap will see it) but nothing reaches a physical
 * device on the operator PC.
 */
type SinkCapableAudioContext = AudioContext & {
  setSinkId?: (sinkIdOrOpts: string | { type: "none" }) => Promise<void>;
};

async function silenceLocalSink(ctx: SinkCapableAudioContext): Promise<boolean> {
  if (typeof ctx.setSinkId !== "function") return false;
  try {
    await ctx.setSinkId({ type: "none" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Activates the bracket overlay's looping music engine. Only mount with
 * `active = true` inside the actual bracket output `BrowserWindow`
 * (`outputScene === "bracket"` and not in preview). Guarded internally
 * against missing Electron APIs and missing AudioContext support.
 *
 * State (which file, play/stop, monitor) is owned by the main process and
 * pushed via `window.matBeastDesktop.onBracketMusicStateChange`. The hook
 * reapplies on every push: file changes reload the `<audio>` src, monitor
 * toggles flip the `setSinkId` between operator-device and `{type:"none"}`,
 * playing toggles call `play()` / `pause()`.
 *
 * v0.9.34 NDI-audio mode (`options.tapPcmForNdi = true`):
 *   When the hook runs inside the **offscreen NDI bracket renderer**
 *   (the headless `BrowserWindow` whose video frames feed
 *   `Mat Beast Bracket` over NDI), we install an AudioWorklet PCM tap
 *   between `source` and `gain`. The tap forwards 1024-sample planar
 *   Float32 frames to the main process via `matBeastDesktop.pushNdiAudio
 *   ("bracket", ...)`, where they're handed to grandiose's
 *   `sender.audio()`. We also force the local sink to silent regardless
 *   of the operator's MONITOR toggle — the operator hears the music
 *   from the visible bracket overlay window (a separate process); the
 *   offscreen NDI renderer plays a silent copy whose sole purpose is
 *   to feed the PCM tap.
 */
export function useBracketOverlayMusic(
  active: boolean,
  options?: { tapPcmForNdi?: boolean },
): void {
  const tapPcmForNdi = Boolean(options?.tapPcmForNdi);
  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined") return;
    const desk = window.matBeastDesktop;
    if (!desk?.onBracketMusicStateChange) return;

    let disposed = false;
    let audioEl: HTMLAudioElement | null = null;
    let ctx: SinkCapableAudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    let tapNode: AudioWorkletNode | null = null;
    /**
     * Promise resolves when the AudioWorklet module is loaded; further
     * `ensureGraph` calls await it before constructing the worklet
     * node. Single-flight by design — the worklet module only needs to
     * be added once per `AudioContext`.
     */
    let workletReady: Promise<void> | null = null;
    let lastRevision = -1;
    let lastFilePath: string | null = null;
    let lastMonitor: boolean | null = null;
    /**
     * Tri-state: `null` = unknown, `true` = `setSinkId({type:"none"})`
     * succeeded once, `false` = unsupported (fall back to gain-mute).
     */
    let supportsSilentSink: boolean | null = null;

    function attachTapHandler(node: AudioWorkletNode): void {
      const pushFn = window.matBeastDesktop?.pushNdiAudio;
      if (typeof pushFn !== "function") return;
      node.port.onmessage = (event) => {
        const data = event.data as
          | {
              sampleRate?: number;
              numChannels?: number;
              numSamples?: number;
              planar?: ArrayBuffer;
            }
          | undefined;
        if (
          !data ||
          typeof data.sampleRate !== "number" ||
          typeof data.numChannels !== "number" ||
          typeof data.numSamples !== "number" ||
          !(data.planar instanceof ArrayBuffer)
        ) {
          return;
        }
        try {
          pushFn("bracket", {
            sampleRate: data.sampleRate,
            numChannels: data.numChannels,
            numSamples: data.numSamples,
            planar: data.planar,
          });
        } catch {
          /* swallow IPC errors — audio is best-effort, missing one
             frame is inaudible compared to throwing on every message */
        }
      };
    }

    async function loadAndConnectTap(
      currentCtx: SinkCapableAudioContext,
      currentSource: MediaElementAudioSourceNode,
      currentGain: GainNode,
    ): Promise<void> {
      try {
        if (!workletReady) {
          workletReady = currentCtx.audioWorklet.addModule(
            "/matbeast-ndi-pcm-tap.worklet.js",
          );
        }
        await workletReady;
        if (disposed) return;
        const node = new AudioWorkletNode(currentCtx, "matbeast-ndi-pcm-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        attachTapHandler(node);
        try {
          currentSource.disconnect();
        } catch {
          /* ignore — disconnect on a freshly-created source is fine */
        }
        currentSource.connect(node).connect(currentGain).connect(currentCtx.destination);
        tapNode = node;
      } catch {
        /**
         * Worklet load failures (missing file, blocked by CSP, OOM) are
         * non-fatal. Fall back to the original `source -> gain ->
         * destination` chain so the visible-monitor path keeps
         * working; NDI just won't carry audio for this session.
         */
      }
    }

    function ensureGraph(): void {
      if (ctx && audioEl && gain) return;
      const g = globalThis as typeof globalThis & {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = g.AudioContext ?? g.webkitAudioContext ?? null;
      if (!Ctor) return;
      audioEl = new Audio();
      audioEl.loop = true;
      audioEl.preload = "auto";
      /**
       * Required so `createMediaElementSource` accepts the cross-origin
       * `mat-beast-asset://` response (the protocol is registered with
       * `corsEnabled: true` so the response carries the right headers).
       */
      audioEl.crossOrigin = "anonymous";
      ctx = new Ctor({ latencyHint: "interactive" }) as SinkCapableAudioContext;
      source = ctx.createMediaElementSource(audioEl);
      gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain).connect(ctx.destination);
      if (tapPcmForNdi && source && gain) {
        /** Fire-and-forget — promise rejection is handled internally. */
        void loadAndConnectTap(ctx, source, gain);
      }
    }

    async function applySink(monitor: boolean): Promise<void> {
      if (!ctx || !gain) return;
      /**
       * NDI offscreen renderer always silences its local output —
       * the operator monitors via the visible bracket overlay (a
       * separate process), and a second audible copy here would
       * double-play. The PCM tap is upstream of the gain node, so
       * silencing here doesn't affect what NDI receivers hear.
       */
      const effectiveMonitor = tapPcmForNdi ? false : monitor;
      if (effectiveMonitor) {
        if (audioContextSupportsSinkSelection(ctx)) {
          await applySelectedAudioOutputToContext(ctx);
        }
        gain.gain.value = 1;
        return;
      }
      if (supportsSilentSink === null) {
        supportsSilentSink = await silenceLocalSink(ctx);
      } else if (supportsSilentSink) {
        await silenceLocalSink(ctx);
      }
      if (!supportsSilentSink) {
        /**
         * Fallback path for older Chromium builds without the `{type:"none"}`
         * sink option: silence by gain. Future NDI worklet tap should be
         * inserted *before* `gain` so it always sees full-amplitude PCM
         * even when the operator monitor is muted.
         */
        gain.gain.value = 0;
      }
    }

    async function applyState(state: BracketMusicState): Promise<void> {
      if (disposed) return;
      ensureGraph();
      if (!ctx || !audioEl) return;

      if (lastMonitor !== state.monitor) {
        await applySink(state.monitor);
        lastMonitor = state.monitor;
      }

      const fileChanged =
        lastRevision !== state.revision || lastFilePath !== state.filePath;
      if (fileChanged) {
        lastRevision = state.revision;
        lastFilePath = state.filePath;
        if (state.filePath) {
          audioEl.src = `${MUSIC_URL_BASE}?r=${state.revision}`;
          audioEl.load();
        } else {
          audioEl.pause();
          audioEl.removeAttribute("src");
          audioEl.load();
        }
      }

      if (state.filePath && state.playing) {
        try {
          if (ctx.state === "suspended") await ctx.resume();
          await audioEl.play();
        } catch (err) {
          /**
           * Bracket overlay window has `autoplayPolicy: 'no-user-gesture-required'`
           * so this should not fire in production. Log for debugging if it does.
           */
          console.debug("[matbeast bracket music] play() failed:", err);
        }
      } else {
        audioEl.pause();
      }
    }

    desk.getBracketMusicState?.().then((state) => {
      if (state) void applyState(state);
    });
    const off = desk.onBracketMusicStateChange((state) => {
      void applyState(state);
    });

    /**
     * Re-apply the sink when the operator changes their global audio
     * output device — only meaningful while MONITOR is on (monitor off
     * ignores the device picker by design).
     */
    const offOutput = onAudioOutputChanged(() => {
      if (lastMonitor) void applySink(true);
    });

    return () => {
      disposed = true;
      off?.();
      offOutput?.();
      try {
        audioEl?.pause();
      } catch {
        /* ignore */
      }
      try {
        if (audioEl) audioEl.removeAttribute("src");
      } catch {
        /* ignore */
      }
      try {
        if (tapNode) {
          tapNode.port.onmessage = null;
          tapNode.disconnect();
        }
      } catch {
        /* ignore */
      }
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
      audioEl = null;
      ctx = null;
      source = null;
      gain = null;
      tapNode = null;
      workletReady = null;
    };
  }, [active, tapPcmForNdi]);
}
