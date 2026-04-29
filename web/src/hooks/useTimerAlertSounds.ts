import { useEffect, useRef } from "react";
import {
  applySelectedAudioOutput,
  applySelectedAudioOutputToContext,
  audioContextSupportsSinkSelection,
  getAudioVolumePercent,
  getSelectedAudioOutputId,
  onAudioVolumeChanged,
  onAudioOutputChanged,
} from "@/lib/audio-output";

/** Served from `public/sounds/` — missing files will not play. */
const SOUND_10S_WARNING_CANDIDATES = [
  "/sounds/timer-10s-warning.mp3",
  "/sounds/timer-10s-warning.MP3",
];
const SOUND_0_AIR_HORN_CANDIDATES = [
  "/sounds/timer-0-air-horn.mp3",
  "/sounds/timer-0-air-horn.MP3",
];
type AudioCtxCtor = typeof AudioContext;
type AudioKit = {
  ctx: AudioContext;
  gain: GainNode;
  /**
   * Where one-shot `BufferSource`s should connect. In the standard
   * (operator-audible) branch this is `gain`. In the NDI-tap branch
   * (v0.9.35) this is the AudioWorklet tap so the captured signal is
   * pre-gain (full amplitude) regardless of the operator's local
   * volume slider, leaving level control to the NDI receiver.
   */
  input: AudioNode;
  /**
   * v0.9.35: pass-through AudioWorklet that posts planar Float32 PCM
   * to the main process for the NDI scoreboard sender. `null` outside
   * NDI-tap mode. Held here so `dispose()` can disconnect it cleanly.
   */
  tapNode: AudioWorkletNode | null;
  /** True when this kit is forwarding cues to NDI instead of a local device. */
  isNdiTap: boolean;
  dispose: () => void;
};

/**
 * v0.9.35 pseudo-context: an `AudioContext` whose `setSinkId` accepts
 * the "no local output" form. Same contract as the bracket music
 * hook's `SinkCapableAudioContext`; we narrow the type here too so
 * the silent-sink shortcut compiles under TS strict.
 */
type SinkCapableAudioContext = AudioContext & {
  setSinkId?: (sinkIdOrOpts: string | { type: "none" }) => Promise<void>;
};
type TimerAudioCoordinator = {
  ownerId: string | null;
  lastEventKey: string | null;
};

function getAudioContextCtor(): AudioCtxCtor | null {
  if (typeof window === "undefined") return null;
  const g = globalThis as typeof globalThis & {
    AudioContext?: AudioCtxCtor;
    webkitAudioContext?: AudioCtxCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

async function createAudioKit(opts?: {
  tapPcmForNdi?: boolean;
  ndiScene?: "scoreboard" | "bracket";
}): Promise<AudioKit | null> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  const ctx = new Ctor({ latencyHint: "interactive" }) as SinkCapableAudioContext;
  const gain = ctx.createGain();

  let streamDestination: MediaStreamAudioDestinationNode | null = null;
  let sinkEl: HTMLAudioElement | null = null;
  let tapNode: AudioWorkletNode | null = null;

  const tapPcmForNdi = Boolean(opts?.tapPcmForNdi);
  const ndiScene = opts?.ndiScene ?? "scoreboard";

  if (tapPcmForNdi) {
    /**
     * v0.9.35 NDI scoreboard cue path: capture each one-shot cue's
     * audio for the NDI receiver and never play it audibly on the
     * offscreen renderer's host. The operator already hears the same
     * cues from the dashboard's ControlPanel mount (standard branch
     * below), so audible double-play here would be disorienting.
     *
     *   BufferSource → tapNode → gain → ctx.destination(silent)
     *                      │
     *                      └─── postMessage(planar Float32 chunk) →
     *                              window.matBeastDesktop.pushNdiAudio
     *
     * Pre-gain tap insertion: the worklet sees full source amplitude
     * regardless of the operator's local volume slider, so the NDI
     * receiver gets a clean, normalised signal and level control is
     * deferred to the receiver's own mixer.
     *
     * Local silencing prefers `setSinkId({type:"none"})`. If that
     * fails we fall back to muting `gain`, which still leaves the
     * pre-gain tap signal intact — that's the whole reason the tap
     * is upstream of `gain` here and not downstream like in the
     * earlier draft of v0.9.35.
     */
    gain.gain.value = 1;
    const desk = (typeof window !== "undefined" ? window.matBeastDesktop : undefined) as
      | {
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
      | undefined;
    let workletInstalled = false;
    try {
      await ctx.audioWorklet.addModule("/matbeast-ndi-pcm-tap.worklet.js");
      tapNode = new AudioWorkletNode(ctx, "matbeast-ndi-pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      tapNode.port.onmessage = (event) => {
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
          desk?.pushNdiAudio?.(ndiScene, {
            sampleRate: data.sampleRate,
            numChannels: data.numChannels,
            numSamples: data.numSamples,
            planar: data.planar,
          });
        } catch {
          /* swallow IPC errors — audio is best-effort */
        }
      };
      tapNode.connect(gain).connect(ctx.destination);
      workletInstalled = true;
    } catch {
      /**
       * Worklet module load failed (e.g. asset not bundled). Wire a
       * minimal graph so subsequent `playBuffer` calls don't throw,
       * and accept that NDI audio is muted for this session. Local
       * audio is still silenced below.
       */
      gain.connect(ctx.destination);
    }

    let silenced = false;
    if (typeof ctx.setSinkId === "function") {
      try {
        await ctx.setSinkId({ type: "none" });
        silenced = true;
      } catch {
        silenced = false;
      }
    }
    if (!silenced) {
      /**
       * Falling back to gain mute: tap is upstream of gain here so
       * the NDI capture still receives full-amplitude audio. Local
       * monitoring on the offscreen window is the only thing muted.
       */
      gain.gain.value = 0;
    }
    console.debug("[MatBeast NDI scoreboard audio] kit created", {
      contextSampleRateHz: ctx.sampleRate,
      workletInstalled,
      silenced,
    });
  } else {
    gain.gain.value = getAudioVolumePercent() / 100;
    const sinkId = getSelectedAudioOutputId();
    if (audioContextSupportsSinkSelection(ctx)) {
      gain.connect(ctx.destination);
      await applySelectedAudioOutputToContext(ctx);
      console.debug(
        "[MatBeast timer audio] path: AudioContext.destination + setSinkId",
        { contextSampleRateHz: ctx.sampleRate, sinkId },
      );
    } else {
      streamDestination = ctx.createMediaStreamDestination();
      gain.connect(streamDestination);
      sinkEl = new Audio();
      sinkEl.autoplay = true;
      sinkEl.srcObject = streamDestination.stream;
      /** First play() primes the element so graph audio is not clipped at the start. */
      await sinkEl.play().catch(() => {});
      await applySelectedAudioOutput(sinkEl);
      console.debug(
        "[MatBeast timer audio] path: MediaStreamDestination + HTMLAudioElement.setSinkId (fallback)",
        { contextSampleRateHz: ctx.sampleRate, sinkId },
      );
    }
  }

  return {
    ctx,
    gain,
    input: tapNode ?? gain,
    tapNode,
    isNdiTap: tapPcmForNdi,
    dispose: () => {
      if (sinkEl) {
        sinkEl.pause();
        sinkEl.srcObject = null;
      }
      if (streamDestination) {
        streamDestination.disconnect();
      }
      try {
        if (tapNode) {
          tapNode.port.onmessage = null;
          tapNode.disconnect();
        }
      } catch {
        /* ignore */
      }
      gain.disconnect();
      void ctx.close();
    },
  };
}

async function loadFirstDecodableBuffer(
  ctx: AudioContext,
  candidates: string[],
): Promise<AudioBuffer | null> {
  for (const src of candidates) {
    try {
      const res = await fetch(src, { cache: "force-cache" });
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arr.slice(0));
      return decoded;
    } catch {
      // try next
    }
  }
  return null;
}

/** Built-in cues when `public/sounds/*.mp3` are not shipped in the repo / bundle. */
function renderTenSecondWarningBuffer(ctx: AudioContext): AudioBuffer {
  const dur = 0.35;
  const sampleRate = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sampleRate * dur));
  const buf = ctx.createBuffer(1, n, sampleRate);
  const ch = buf.getChannelData(0);
  const freq = 880;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 4000) * Math.max(0, 1 - (t - dur * 0.55) / (dur * 0.45));
    ch[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.42;
  }
  return buf;
}

function renderAirHornishBuffer(ctx: AudioContext): AudioBuffer {
  const dur = 1.1;
  const sampleRate = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sampleRate * dur));
  const buf = ctx.createBuffer(1, n, sampleRate);
  const ch = buf.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = 280;
    const f1 = 140;
    const f = f0 + (f1 - f0) * Math.min(1, t / (dur * 0.85));
    phase += (2 * Math.PI * f) / sampleRate;
    const env = Math.min(1, t * 120) * Math.max(0, 1 - (t - dur * 0.75) / (dur * 0.25));
    const buzz = Math.sin(phase) * 0.55 + (Math.random() * 2 - 1) * 0.12;
    ch[i] = buzz * env * 0.5;
  }
  return buf;
}

/**
 * Must await `AudioContext.resume()` before `start()` when the context is suspended;
 * otherwise the first samples are scheduled before output runs and sound is clipped.
 */
function playBuffer(kit: AudioKit | null, buffer: AudioBuffer | null): void {
  if (!kit || !buffer) return;
  void (async () => {
    try {
      if (kit.ctx.state === "suspended") {
        await kit.ctx.resume();
      }
      const source = kit.ctx.createBufferSource();
      source.buffer = buffer;
      /**
       * `kit.input` is the tap node in NDI mode and the gain node
       * otherwise; this keeps boundary-driven and manual cues on the
       * exact same node that volume / silencing rules expect.
       */
      source.connect(kit.input);
      source.start(kit.ctx.currentTime);
    } catch {
      /* ignore */
    }
  })();
}

type TimerAudioPrimeWindow = Window & {
  __matbeastTimerAudioPrime?: () => void;
};

/** Call synchronously from PLAY 10S / PLAY HORN click so `resume()` stays in the user-gesture chain. */
export function primeTimerAlertAudioFromUserGesture(): void {
  if (typeof window === "undefined") return;
  (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime?.();
}

function getCoordinator(): TimerAudioCoordinator | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    __matbeastTimerAudioCoordinator?: TimerAudioCoordinator;
  };
  if (!w.__matbeastTimerAudioCoordinator) {
    w.__matbeastTimerAudioCoordinator = { ownerId: null, lastEventKey: null };
  }
  return w.__matbeastTimerAudioCoordinator;
}

function claimCoordinatorOwner(instanceId: string): boolean {
  const c = getCoordinator();
  if (!c) return true;
  if (!c.ownerId) c.ownerId = instanceId;
  return c.ownerId === instanceId;
}

function releaseCoordinatorOwner(instanceId: string): void {
  const c = getCoordinator();
  if (!c) return;
  if (c.ownerId === instanceId) c.ownerId = null;
}

function shouldPlayEvent(instanceId: string, eventKey: string): boolean {
  const c = getCoordinator();
  if (!c) return true;
  if (!claimCoordinatorOwner(instanceId)) return false;
  if (c.lastEventKey === eventKey) return false;
  c.lastEventKey = eventKey;
  return true;
}

function crossWindowClaim(eventKey: string): boolean {
  if (typeof window === "undefined") return true;
  const key = "__matbeast-timer-audio-last-event__";
  const now = Date.now();
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { eventKey?: string; ts?: number };
      if (
        parsed?.eventKey === eventKey &&
        typeof parsed.ts === "number" &&
        now - parsed.ts < 2000
      ) {
        return false;
      }
    }
    window.localStorage.setItem(key, JSON.stringify({ eventKey, ts: now }));
  } catch {
    // best effort
  }
  return true;
}

async function buildAudioKitAndBuffers(opts?: {
  tapPcmForNdi?: boolean;
  ndiScene?: "scoreboard" | "bracket";
}): Promise<{
  kit: AudioKit | null;
  b10: AudioBuffer | null;
  b0: AudioBuffer | null;
}> {
  const kit = await createAudioKit(opts);
  if (!kit) return { kit: null, b10: null, b0: null };
  const [b10Raw, b0Raw] = await Promise.all([
    loadFirstDecodableBuffer(kit.ctx, SOUND_10S_WARNING_CANDIDATES),
    loadFirstDecodableBuffer(kit.ctx, SOUND_0_AIR_HORN_CANDIDATES),
  ]);
  const b10 = b10Raw ?? renderTenSecondWarningBuffer(kit.ctx);
  const b0 = b0Raw ?? renderAirHornishBuffer(kit.ctx);
  return { kit, b10, b0 };
}

/**
 * Module-level helper used by both branches of `useTimerAlertSounds`.
 * Hoisted out of the component body so it is a stable reference and
 * `react-hooks/exhaustive-deps` does not pull it (and indirectly the
 * whole closure of refs) into every effect's dep array.
 *
 * NDI tap mode (`tapPcmForNdi=true`) bypasses the in-process
 * coordinator and the localStorage cross-window claim. See the
 * `useTimerAlertSounds` JSDoc for why.
 */
function gateAndPlayCue(
  tapPcmForNdi: boolean,
  instanceId: string,
  eventKey: string,
  kit: AudioKit | null,
  buffer: AudioBuffer | null,
): void {
  if (tapPcmForNdi) {
    playBuffer(kit, buffer);
    return;
  }
  if (shouldPlayEvent(instanceId, eventKey) && crossWindowClaim(eventKey)) {
    playBuffer(kit, buffer);
  }
}

/**
 * Plays overlay cues when the match clock crosses into the final 10 seconds and when it hits 0.
 * Uses edge detection (previous vs current second) so a 1s poll does not miss the 10s boundary.
 *
 * v0.9.35 NDI tap mode (`options.tapPcmForNdi`):
 *   - Used by the offscreen NDI scoreboard renderer in `overlay-client.tsx`.
 *   - Routes cue audio through an AudioWorklet PCM tap and forwards
 *     planar Float32 chunks via `window.matBeastDesktop.pushNdiAudio`
 *     so the NDI receiver hears the same 10s warning / air horn cues
 *     as the operator does locally.
 *   - Skips the in-process coordinator and the localStorage
 *     cross-window claim. Both exist to deduplicate AUDIBLE playback
 *     across multiple windows of the same origin; the NDI renderer is
 *     a separate, always-silent playback path that should fire in
 *     parallel with whatever the dashboard is doing.
 *   - Skips the operator-device routing (`applySelectedAudioOutput*`)
 *     and the volume listener. The NDI receiver controls its own
 *     level; the operator's local slider only affects the dashboard
 *     mount of this hook.
 */
export function useTimerAlertSounds(
  secondsRemaining: number | undefined,
  resetKey: string | undefined,
  is10SecondEnabled: boolean | undefined,
  isZeroEnabled: boolean | undefined,
  isRestMode: boolean | undefined,
  play10NowNonce: number | undefined,
  play0NowNonce: number | undefined,
  enabled: boolean = true,
  /** OT count-down minute: no automatic 10s warning. */
  suppressTenSecondWarning: boolean = false,
  options?: {
    /** Pipe each cue's audio over NDI for the offscreen scoreboard renderer (silences local). */
    tapPcmForNdi?: boolean;
    /** Defaults to "scoreboard". Forwarded to `pushNdiAudio` so the main process routes to the right feed. */
    ndiScene?: "scoreboard" | "bracket";
  },
): void {
  const tapPcmForNdi = Boolean(options?.tapPcmForNdi);
  const ndiScene = options?.ndiScene ?? "scoreboard";
  const instanceIdRef = useRef(`timer-audio-${Math.random().toString(36).slice(2)}`);
  const prevSecondsRef = useRef<number | null>(null);
  const lastResetKeyRef = useRef<string | undefined>(undefined);
  const audioKitRef = useRef<AudioKit | null>(null);
  const audio10BufferRef = useRef<AudioBuffer | null>(null);
  const audio0BufferRef = useRef<AudioBuffer | null>(null);
  const lastPlay10NowNonceRef = useRef<number | null>(null);
  const lastPlay0NowNonceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const instanceId = instanceIdRef.current;
    /**
     * In NDI tap mode the cross-instance coordinator is intentionally
     * skipped; the offscreen NDI renderer is a separate playback path
     * that must fire in parallel with the dashboard's audible mount.
     * Only the audible mount needs to claim ownership of the
     * coordinator.
     */
    if (!tapPcmForNdi) {
      claimCoordinatorOwner(instanceId);
    }
    let cancelled = false;
    const rebuildKit = async () => {
      delete (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime;
      const prevKit = audioKitRef.current;
      audioKitRef.current = null;
      audio10BufferRef.current = null;
      audio0BufferRef.current = null;
      const { kit, b10, b0 } = await buildAudioKitAndBuffers({
        tapPcmForNdi,
        ndiScene,
      });
      if (cancelled) {
        kit?.dispose();
        prevKit?.dispose();
        delete (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime;
        return;
      }
      prevKit?.dispose();
      audioKitRef.current = kit;
      audio10BufferRef.current = b10;
      audio0BufferRef.current = b0;
      (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime = () => {
        const k = audioKitRef.current;
        if (k?.ctx.state === "suspended") void k.ctx.resume();
      };
    };
    void rebuildKit();
    /**
     * Operator-device / volume listeners only matter for the audible
     * (dashboard) mount. The NDI renderer's level is fixed at 1.0
     * pre-tap and silenced post-tap, so neither output-device changes
     * nor volume slider moves should reset its kit.
     */
    const off = tapPcmForNdi
      ? () => {}
      : onAudioOutputChanged(() => {
          void rebuildKit();
        });
    const offVol = tapPcmForNdi
      ? () => {}
      : onAudioVolumeChanged(() => {
          if (audioKitRef.current) {
            audioKitRef.current.gain.gain.value = getAudioVolumePercent() / 100;
          }
        });
    return () => {
      cancelled = true;
      off();
      offVol();
      audioKitRef.current?.dispose();
      audioKitRef.current = null;
      audio10BufferRef.current = null;
      audio0BufferRef.current = null;
      delete (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime;
      if (!tapPcmForNdi) {
        releaseCoordinatorOwner(instanceId);
      }
    };
  }, [enabled, tapPcmForNdi, ndiScene]);

  useEffect(() => {
    if (resetKey !== lastResetKeyRef.current) {
      lastResetKeyRef.current = resetKey;
      prevSecondsRef.current = null;
    }
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) return;
    if (secondsRemaining === undefined) return;
    const curr = secondsRemaining;
    const prev = prevSecondsRef.current;

    if (prev !== null) {
      if (
        !(isRestMode ?? false) &&
        !suppressTenSecondWarning &&
        (is10SecondEnabled ?? true) &&
        prev > 10 &&
        curr <= 10
      ) {
        gateAndPlayCue(
          tapPcmForNdi,
          instanceIdRef.current,
          `auto10:${resetKey ?? "none"}:${curr}`,
          audioKitRef.current,
          audio10BufferRef.current,
        );
      }
      /** `<= 0` covers any missed integer tick when polling lags the wall clock. */
      if (prev > 0 && curr <= 0) {
        if (isRestMode ?? false) {
          if (isZeroEnabled ?? true) {
            gateAndPlayCue(
              tapPcmForNdi,
              instanceIdRef.current,
              `auto0rest:${resetKey ?? "none"}:${curr}`,
              audioKitRef.current,
              audio0BufferRef.current,
            );
          }
        } else if (isZeroEnabled ?? true) {
          gateAndPlayCue(
            tapPcmForNdi,
            instanceIdRef.current,
            `auto0:${resetKey ?? "none"}:${curr}`,
            audioKitRef.current,
            audio0BufferRef.current,
          );
        }
      }
    }

    prevSecondsRef.current = curr;
  }, [
    secondsRemaining,
    is10SecondEnabled,
    isZeroEnabled,
    isRestMode,
    suppressTenSecondWarning,
    enabled,
    resetKey,
    tapPcmForNdi,
  ]);

  useEffect(() => {
    if (!enabled) return;
    if (play10NowNonce === undefined) return;
    if (lastPlay10NowNonceRef.current === null) {
      lastPlay10NowNonceRef.current = play10NowNonce;
      return;
    }
    if (play10NowNonce !== lastPlay10NowNonceRef.current) {
      gateAndPlayCue(
        tapPcmForNdi,
        instanceIdRef.current,
        `manual10:${play10NowNonce}`,
        audioKitRef.current,
        audio10BufferRef.current,
      );
    }
    lastPlay10NowNonceRef.current = play10NowNonce;
  }, [play10NowNonce, enabled, tapPcmForNdi]);

  useEffect(() => {
    if (!enabled) return;
    if (play0NowNonce === undefined) return;
    if (lastPlay0NowNonceRef.current === null) {
      lastPlay0NowNonceRef.current = play0NowNonce;
      return;
    }
    if (play0NowNonce !== lastPlay0NowNonceRef.current) {
      gateAndPlayCue(
        tapPcmForNdi,
        instanceIdRef.current,
        `manual0:${play0NowNonce}`,
        audioKitRef.current,
        audio0BufferRef.current,
      );
    }
    lastPlay0NowNonceRef.current = play0NowNonce;
  }, [play0NowNonce, enabled, tapPcmForNdi]);
}
