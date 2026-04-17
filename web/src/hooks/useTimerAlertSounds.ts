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
  dispose: () => void;
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

async function createAudioKit(): Promise<AudioKit | null> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  const ctx = new Ctor({ latencyHint: "interactive" });
  const gain = ctx.createGain();
  gain.gain.value = getAudioVolumePercent() / 100;

  let streamDestination: MediaStreamAudioDestinationNode | null = null;
  let sinkEl: HTMLAudioElement | null = null;

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

  return {
    ctx,
    gain,
    dispose: () => {
      if (sinkEl) {
        sinkEl.pause();
        sinkEl.srcObject = null;
      }
      if (streamDestination) {
        streamDestination.disconnect();
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
      source.connect(kit.gain);
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

async function buildAudioKitAndBuffers(): Promise<{
  kit: AudioKit | null;
  b10: AudioBuffer | null;
  b0: AudioBuffer | null;
}> {
  const kit = await createAudioKit();
  if (!kit) return { kit: null, b10: null, b0: null };
  const [b10, b0] = await Promise.all([
    loadFirstDecodableBuffer(kit.ctx, SOUND_10S_WARNING_CANDIDATES),
    loadFirstDecodableBuffer(kit.ctx, SOUND_0_AIR_HORN_CANDIDATES),
  ]);
  return { kit, b10, b0 };
}

/**
 * Plays overlay cues when the match clock crosses into the final 10 seconds and when it hits 0.
 * Uses edge detection (previous vs current second) so a 1s poll does not miss the 10s boundary.
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
): void {
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
    claimCoordinatorOwner(instanceId);
    let cancelled = false;
    const rebuildKit = async () => {
      delete (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime;
      audioKitRef.current?.dispose();
      audioKitRef.current = null;
      audio10BufferRef.current = null;
      audio0BufferRef.current = null;
      const { kit, b10, b0 } = await buildAudioKitAndBuffers();
      if (cancelled) {
        kit?.dispose();
        delete (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime;
        return;
      }
      audioKitRef.current = kit;
      audio10BufferRef.current = b10;
      audio0BufferRef.current = b0;
      (window as TimerAudioPrimeWindow).__matbeastTimerAudioPrime = () => {
        const k = audioKitRef.current;
        if (k?.ctx.state === "suspended") void k.ctx.resume();
      };
    };
    void rebuildKit();
    const off = onAudioOutputChanged(() => {
      void rebuildKit();
    });
    const offVol = onAudioVolumeChanged(() => {
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
      releaseCoordinatorOwner(instanceId);
    };
  }, [enabled]);

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
      if (!(isRestMode ?? false) && (is10SecondEnabled ?? true) && prev > 10 && curr <= 10) {
        const eventKey = `auto10:${resetKey ?? "none"}:${curr}`;
        if (shouldPlayEvent(instanceIdRef.current, eventKey) && crossWindowClaim(eventKey)) {
          playBuffer(audioKitRef.current, audio10BufferRef.current);
        }
      }
      if (prev > 0 && curr === 0) {
        if (isRestMode ?? false) {
          if (isZeroEnabled ?? true) {
            const eventKey = `auto0rest:${resetKey ?? "none"}:${curr}`;
            if (shouldPlayEvent(instanceIdRef.current, eventKey) && crossWindowClaim(eventKey)) {
              playBuffer(audioKitRef.current, audio10BufferRef.current);
            }
          }
        } else if (isZeroEnabled ?? true) {
          const eventKey = `auto0:${resetKey ?? "none"}:${curr}`;
          if (shouldPlayEvent(instanceIdRef.current, eventKey) && crossWindowClaim(eventKey)) {
            playBuffer(audioKitRef.current, audio0BufferRef.current);
          }
        }
      }
    }

    prevSecondsRef.current = curr;
  }, [secondsRemaining, is10SecondEnabled, isZeroEnabled, isRestMode, enabled, resetKey]);

  useEffect(() => {
    if (!enabled) return;
    if (play10NowNonce === undefined) return;
    if (lastPlay10NowNonceRef.current === null) {
      lastPlay10NowNonceRef.current = play10NowNonce;
      return;
    }
    if (play10NowNonce !== lastPlay10NowNonceRef.current) {
      const eventKey = `manual10:${play10NowNonce}`;
      if (shouldPlayEvent(instanceIdRef.current, eventKey) && crossWindowClaim(eventKey)) {
        playBuffer(audioKitRef.current, audio10BufferRef.current);
      }
    }
    lastPlay10NowNonceRef.current = play10NowNonce;
  }, [play10NowNonce, enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (play0NowNonce === undefined) return;
    if (lastPlay0NowNonceRef.current === null) {
      lastPlay0NowNonceRef.current = play0NowNonce;
      return;
    }
    if (play0NowNonce !== lastPlay0NowNonceRef.current) {
      const eventKey = `manual0:${play0NowNonce}`;
      if (shouldPlayEvent(instanceIdRef.current, eventKey) && crossWindowClaim(eventKey)) {
        playBuffer(audioKitRef.current, audio0BufferRef.current);
      }
    }
    lastPlay0NowNonceRef.current = play0NowNonce;
  }, [play0NowNonce, enabled]);
}
