"use client";

import {
  type OverlayOutputBroadcast,
  isOverlayOutputBroadcast,
  openOverlayOutputChannel,
} from "@/lib/overlay-output-broadcast";
import { openScoreboardOverlayWindow } from "@/lib/open-scoreboard-overlay";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dashboard-only: drive the external overlay window live/stopped state and keep UI in sync
 * when the output window closes (broadcast `output-closed`).
 */
export function useOverlayOutputLiveControl() {
  const [live, setLive] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const ch = openOverlayOutputChannel();
    channelRef.current = ch;
    ch.onmessage = (ev: MessageEvent) => {
      if (!isOverlayOutputBroadcast(ev.data)) return;
      const m = ev.data;
      if (m.kind === "ping") {
        ch.postMessage({
          kind: "pong",
          live: liveRef.current,
        } satisfies OverlayOutputBroadcast);
      } else if (m.kind === "live" || m.kind === "pong") {
        setLive(m.live);
      } else if (m.kind === "output-closed") {
        setLive(false);
      }
    };
    ch.postMessage({ kind: "ping" } satisfies OverlayOutputBroadcast);
    return () => {
      channelRef.current = null;
      ch.close();
    };
  }, []);

  const setLiveAndBroadcast = useCallback((next: boolean) => {
    setLive(next);
    channelRef.current?.postMessage({ kind: "live", live: next } satisfies OverlayOutputBroadcast);
  }, []);

  const deactivateOverlay = useCallback(() => {
    setLiveAndBroadcast(false);
  }, [setLiveAndBroadcast]);

  const activateOverlay = useCallback(() => {
    if (!openScoreboardOverlayWindow()) return;
    setLiveAndBroadcast(true);
  }, [setLiveAndBroadcast]);

  const toggleLive = useCallback(() => {
    const next = !liveRef.current;
    if (next) {
      activateOverlay();
    } else {
      setLiveAndBroadcast(false);
    }
  }, [activateOverlay, setLiveAndBroadcast]);

  return {
    overlayOutputLive: live,
    toggleOverlayOutputLive: toggleLive,
    activateOverlay,
    deactivateOverlay,
  };
}
