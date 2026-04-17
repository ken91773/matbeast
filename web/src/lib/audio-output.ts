"use client";

const AUDIO_OUTPUT_STORAGE_KEY = "matbeast-audio-output-device-id";
const AUDIO_OUTPUT_EVENT = "matbeast-audio-output-changed";
const AUDIO_VOLUME_STORAGE_KEY = "matbeast-audio-volume-percent";
const AUDIO_VOLUME_EVENT = "matbeast-audio-volume-changed";

type SinkCapableMedia = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

/** Chromium / Electron: route Web Audio directly to a device (avoids MediaStream-to-audio-element resample drift). */
type SinkCapableAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export function getSelectedAudioOutputId(): string {
  if (typeof window === "undefined") return "default";
  try {
    return window.localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY) || "default";
  } catch {
    return "default";
  }
}

export function setSelectedAudioOutputId(deviceId: string): void {
  if (typeof window === "undefined") return;
  const normalized = deviceId?.trim() || "default";
  try {
    window.localStorage.setItem(AUDIO_OUTPUT_STORAGE_KEY, normalized);
  } catch {
    // ignore storage write errors
  }
  window.dispatchEvent(
    new CustomEvent(AUDIO_OUTPUT_EVENT, { detail: { deviceId: normalized } }),
  );
}

export function onAudioOutputChanged(handler: (deviceId: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ deviceId?: string }>).detail;
    handler(d?.deviceId?.trim() || "default");
  };
  window.addEventListener(AUDIO_OUTPUT_EVENT, fn);
  return () => window.removeEventListener(AUDIO_OUTPUT_EVENT, fn);
}

export function getAudioVolumePercent(): number {
  if (typeof window === "undefined") return 100;
  try {
    const raw = window.localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY);
    const n = Number(raw);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, Math.round(n)));
  } catch {
    return 100;
  }
}

export function setAudioVolumePercent(percent: number): void {
  if (typeof window === "undefined") return;
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  try {
    window.localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, String(v));
  } catch {
    // ignore storage write errors
  }
  window.dispatchEvent(new CustomEvent(AUDIO_VOLUME_EVENT, { detail: { volume: v } }));
}

export function onAudioVolumeChanged(handler: (percent: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fn = (e: Event) => {
    const d = (e as CustomEvent<{ volume?: number }>).detail;
    const v = Number(d?.volume);
    handler(Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 100);
  };
  window.addEventListener(AUDIO_VOLUME_EVENT, fn);
  return () => window.removeEventListener(AUDIO_VOLUME_EVENT, fn);
}

export function applySelectedAudioVolume(el: HTMLMediaElement): void {
  el.volume = getAudioVolumePercent() / 100;
}

export async function applySelectedAudioOutput(el: HTMLMediaElement): Promise<void> {
  const sinkCapable = el as SinkCapableMedia;
  if (typeof sinkCapable.setSinkId !== "function") return;
  const target = getSelectedAudioOutputId();
  try {
    await sinkCapable.setSinkId(target);
  } catch {
    // If persisted device no longer exists, force system default.
    try {
      await sinkCapable.setSinkId("default");
      if (target !== "default") setSelectedAudioOutputId("default");
    } catch {
      // silently ignore unsupported/invalid sink errors
    }
  }
}

export async function applySelectedAudioOutputToContext(ctx: AudioContext): Promise<void> {
  const sinkCapable = ctx as SinkCapableAudioContext;
  if (typeof sinkCapable.setSinkId !== "function") return;
  const target = getSelectedAudioOutputId();
  try {
    await sinkCapable.setSinkId(target);
  } catch {
    try {
      await sinkCapable.setSinkId("default");
      if (target !== "default") setSelectedAudioOutputId("default");
    } catch {
      // silently ignore unsupported/invalid sink errors
    }
  }
}

/** True when timer/alert audio can use context.destination + setSinkId (no MediaStream bridge). */
export function audioContextSupportsSinkSelection(ctx: AudioContext): boolean {
  return typeof (ctx as SinkCapableAudioContext).setSinkId === "function";
}
