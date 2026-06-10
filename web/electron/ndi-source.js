/**
 * Offscreen overlay source — produces a continuous stream of 1920×1080
 * BGRA frames from a hidden Next.js overlay route, ready to feed into NDI.
 *
 * One instance per scene ("scoreboard" or "bracket"). Each instance owns:
 *   - An offscreen `BrowserWindow` loading
 *     `${appUrl}/overlay?ndi=1&outputScene=<scene>` so React renders into a
 *     1920×1080 BGRA back-buffer with no operator-confidence chrome.
 *   - A `setInterval` capture pump that drives `webContents.capturePage()`
 *     at 1000/frameRate ms and forwards each frame (resized to 1920×1080
 *     if the host display ever bleeds through) to a sink callback.
 *
 * The capture-loop architecture (paint events vs capturePage, why
 * `webContents.invalidate()` is wrong, why `setFrameRate` only caps and
 * does not drive) is documented exhaustively in `electron/ndi-smoke.js`
 * — see the comment block above `CAPTURE_INTERVAL_MS`. This module
 * reuses the same approach minus the warmup / time limit / PNG writer.
 *
 * Differences from `ndi-smoke.js`:
 *   - No warmup window. The first ~30 frames may be partial (fonts loading,
 *     React hydrating). NDI receivers tolerate this.
 *   - No total-duration cap; runs until `destroy()` is called.
 *   - No PNG writes; each captured frame goes to `onFrame(image, dimensions)`.
 *   - `onError` is called for capture failures so the sender can decide
 *     whether to keep going or surface a UI warning.
 *
 * Resolution is locked to a host-independent 1920×1080 by sizing the
 * offscreen window's content area to `target / hostScaleFactor` (so the
 * physical back-buffer lands on the target on any monitor regardless of
 * its DPI scale), backed by a `capturePage(rect)` + ±1 px resize safety
 * net.
 */
const { BrowserWindow, screen } = require("electron");

/**
 * Broadcast frame size. Fixed 1080p (1920×1080) — this is the ONLY
 * resolution the NDI source ever advertises, regardless of the operator's
 * monitor or its DPI scale (see the scale-factor compensation in
 * `createOffscreenSource`).
 */
const NDI_OFFSCREEN_W = 1920;
const NDI_OFFSCREEN_H = 1080;

const KNOWN_SCENES = new Set(["scoreboard", "bracket"]);

/**
 * @typedef {Object} OffscreenSourceOptions
 * @property {string}   appUrl      Bundled Next server origin (e.g. "http://localhost:31415").
 * @property {string}   preloadPath Absolute path to electron/preload.js.
 * @property {"scoreboard"|"bracket"} scene  Which overlay scene to lock the renderer to.
 * @property {number}   [frameRate=30]  Announced NDI frame rate; also the default capture cadence.
 * @property {number}   [captureIntervalMs]  Override the capture cadence in ms.
 *   When >0 this decouples how often the page is re-captured from `frameRate`
 *   (e.g. a static bracket re-captured every 5 s while still broadcast at 15 fps).
 * @property {(image: Electron.NativeImage, dim: {width: number, height: number}) => void} onFrame
 * @property {(error: Error) => void} [onError]
 * @property {(line: string) => void} [onLog]
 */

/**
 * Create and start an offscreen overlay source. Returns a handle you can
 * inspect for diagnostic counters and call `destroy()` on to tear it down.
 *
 * @param {OffscreenSourceOptions} opts
 * @returns {Promise<OffscreenSourceHandle>}
 */
async function createOffscreenSource(opts) {
  if (!KNOWN_SCENES.has(opts.scene)) {
    throw new Error(`createOffscreenSource: unknown scene "${opts.scene}"`);
  }
  const log = typeof opts.onLog === "function" ? opts.onLog : () => {};
  const onError = typeof opts.onError === "function" ? opts.onError : () => {};
  const frameRate = Math.max(1, Math.min(60, opts.frameRate || 30));
  const captureIntervalMs =
    typeof opts.captureIntervalMs === "number" && opts.captureIntervalMs > 0
      ? Math.round(opts.captureIntervalMs)
      : Math.round(1000 / frameRate);

  /**
   * Host-independent native resolution.
   *
   * Electron's offscreen renderer multiplies the window's content size (in
   * DIPs) by the host monitor's `scaleFactor` to produce the physical
   * back-buffer. On a 100 %-scale monitor a 1920×1080 window yields a
   * 1920×1080 buffer; on a 125 %/150 % monitor the same window would yield
   * 2400×1350 / 2880×1620, and capturePage can also clamp to the desktop
   * work area — which is exactly why the operator saw a 2562×1529 capture.
   *
   * Compensating the content size by the scale factor (`target / scale`)
   * makes the PHYSICAL buffer land on the target (≈1920×1080) on ANY
   * machine, so the page renders natively at broadcast resolution with no
   * downscale pass. `normalizeFrame` below stays as a ±1 px safety net for
   * non-integer scale factors; it's a no-op when the buffer already matches.
   */
  let hostScaleFactor = 1;
  try {
    hostScaleFactor = screen.getPrimaryDisplay()?.scaleFactor || 1;
  } catch {
    hostScaleFactor = 1;
  }
  if (!Number.isFinite(hostScaleFactor) || hostScaleFactor <= 0) {
    hostScaleFactor = 1;
  }
  const contentW = Math.max(1, Math.round(NDI_OFFSCREEN_W / hostScaleFactor));
  const contentH = Math.max(1, Math.round(NDI_OFFSCREEN_H / hostScaleFactor));
  log(
    `[ndi-source/${opts.scene}] target ${NDI_OFFSCREEN_W}x${NDI_OFFSCREEN_H}` +
      ` hostScale=${hostScaleFactor} -> content ${contentW}x${contentH} (DIP)`,
  );

  const win = new BrowserWindow({
    show: false,
    width: contentW,
    height: contentH,
    useContentSize: true,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      zoomFactor: 1.0,
    },
  });

  const overlayQs = new URLSearchParams({ ndi: "1", outputScene: opts.scene });
  const targetUrl = `${opts.appUrl}/overlay?${overlayQs.toString()}`;
  log(`[ndi-source/${opts.scene}] loading ${targetUrl} @ ${frameRate}fps`);

  const captureRect = {
    x: 0,
    y: 0,
    width: contentW,
    height: contentH,
  };

  /**
   * Layer 3 of the resolution-lock — see ndi-smoke.js for the full
   * rationale. NDI receivers re-negotiate the format on every frame whose
   * dimensions disagree with the announced sender format, which causes
   * downstream stutter. Forcing 1920×1080 here means the announced
   * format is also the actual format on the wire.
   */
  let resizesPerformed = 0;
  const normalizeFrame = (image) => {
    const size = image.getSize();
    if (size.width === NDI_OFFSCREEN_W && size.height === NDI_OFFSCREEN_H) {
      return image;
    }
    resizesPerformed += 1;
    return image.resize({
      width: NDI_OFFSCREEN_W,
      height: NDI_OFFSCREEN_H,
      // `good` (bilinear) not `best` (Lanczos): with scale-factor
      // compensation this is a ±1 px correction, not a real downscale, so
      // the cheaper filter keeps per-frame cost (and latency) low.
      quality: "good",
    });
  };

  const counters = {
    captureAttempts: 0,
    framesEmitted: 0,
    captureFailures: 0,
    resizesPerformed: 0,
    firstCaptureMs: null,
    lastCaptureRelMs: null,
    startedAt: Date.now(),
  };

  let captureTimer = null;
  let captureInFlight = false;
  let destroyed = false;
  let firstCaptureLogged = false;

  const tick = async () => {
    if (destroyed) return;
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (captureInFlight) return;
    captureInFlight = true;
    counters.captureAttempts += 1;
    const startedAt = Date.now();
    try {
      const rawImage = await win.webContents.capturePage(captureRect);
      if (destroyed) return;
      const finishedAt = Date.now();
      counters.lastCaptureRelMs = finishedAt - counters.startedAt;
      if (!firstCaptureLogged) {
        firstCaptureLogged = true;
        counters.firstCaptureMs = finishedAt - startedAt;
        const size = rawImage.getSize();
        log(
          `[ndi-source/${opts.scene}] first capture ${size.width}x${size.height}` +
            ` (${counters.firstCaptureMs} ms)`,
        );
      }
      const image = normalizeFrame(rawImage);
      counters.resizesPerformed = resizesPerformed;
      const size = image.getSize();
      counters.framesEmitted += 1;
      try {
        opts.onFrame(image, { width: size.width, height: size.height });
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    } catch (err) {
      counters.captureFailures += 1;
      if (counters.captureFailures <= 3) {
        log(
          `[ndi-source/${opts.scene}] capturePage failed (${counters.captureFailures}): ${String(
            err?.message || err,
          )}`,
        );
      }
      if (counters.captureFailures === 1) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      captureInFlight = false;
    }
  };

  /**
   * Wait for did-finish-load before we start the capture pump. Without
   * this we'd sample empty frames during Chromium's renderer init.
   * Fail-safe timer: if did-finish-load doesn't fire in 8s (network
   * stall, server crash, etc.), we resolve anyway and the capture loop
   * will surface failures via `onError`.
   */
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    win.webContents.once("did-finish-load", () => {
      log(`[ndi-source/${opts.scene}] did-finish-load`);
      try {
        win.webContents.setZoomFactor(1.0);
      } catch {
        /* ignore */
      }
      try {
        win.webContents.setFrameRate(frameRate);
      } catch {
        /* ignore */
      }
      settle();
    });
    win.webContents.once("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
      log(
        `[ndi-source/${opts.scene}] did-fail-load ${validatedURL} code=${errorCode} ${errorDescription}`,
      );
      settle();
    });
    setTimeout(settle, 8000);
    win.loadURL(targetUrl, {
      extraHeaders: "pragma: no-cache\r\nCache-Control: no-cache\r\n",
    });
  });

  if (destroyed) {
    return null;
  }

  captureTimer = setInterval(tick, captureIntervalMs);
  log(`[ndi-source/${opts.scene}] capture loop started (every ${captureIntervalMs} ms)`);

  /** @type {OffscreenSourceHandle} */
  const handle = {
    scene: opts.scene,
    frameRate,
    captureIntervalMs,
    counters,
    targetUrl,
    isDestroyed: () => destroyed,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      if (captureTimer) {
        clearInterval(captureTimer);
        captureTimer = null;
      }
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* ignore */
      }
      log(
        `[ndi-source/${opts.scene}] destroyed.` +
          ` framesEmitted=${counters.framesEmitted}` +
          ` captureFailures=${counters.captureFailures}` +
          ` resizesPerformed=${counters.resizesPerformed}`,
      );
    },
  };
  return handle;
}

/**
 * @typedef {Object} OffscreenSourceHandle
 * @property {"scoreboard"|"bracket"} scene
 * @property {number} frameRate
 * @property {number} captureIntervalMs
 * @property {object} counters  diagnostic snapshot, mutates as frames come in
 * @property {string} targetUrl
 * @property {() => boolean} isDestroyed
 * @property {() => void} destroy
 */

module.exports = {
  createOffscreenSource,
  NDI_OFFSCREEN_W,
  NDI_OFFSCREEN_H,
};
