/**
 * NDI offscreen-rendering smoke test (v0.9.21+).
 *
 * Goal: prove the offscreen webContents → NativeImage pipeline produces
 * a true 1920×1080 broadcast frame of the live scoreboard at the target
 * frame rate, **before** we add any NDI library dependency. The smoke
 * test runs for ~7 seconds (1500 ms warmup + ~5 s recording), captures
 * frames at 30 fps via `webContents.capturePage()`, and writes ~15
 * sampled PNG frames + a `summary.json` to
 * `<userData>/ndi-test/<timestamp>/`.
 *
 * Once this is signed off, v0.9.27 swaps the PNG write for
 * `grandiose.NdiSender.video(image.toBitmap(), …)` and we have an
 * actual NDI source on the network.
 *
 * Architecture note: the offscreen webContents loads
 * `${appUrl}/overlay?ndi=1&outputScene=scoreboard`. The `ndi=1` flag is
 * read by `src/app/overlay/overlay-client.tsx` to suppress the
 * operator-confidence inset frame (visible windows show a teal border
 * so the operator can see the capture extent; broadcast viewers should
 * not).
 *
 * The offscreen window has `transparent: true` so the scoreboard's
 * alpha channel survives into the BGRA frame buffer — required for
 * downstream NDI receivers that support alpha (vMix, OBS NDI source
 * with "Allow alpha").
 *
 * With `webPreferences.offscreen: true`, the BrowserWindow `width` /
 * `height` are interpreted as the **buffer** size — there's no host
 * display, so no scaleFactor math. Setting `width: 1920, height: 1080`
 * yields a 1920×1080 BGRA buffer regardless of the operator's physical
 * display.
 */
const { BrowserWindow, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const NDI_FRAME_RATE_DEFAULT = 30;
const NDI_OFFSCREEN_W = 1920;
const NDI_OFFSCREEN_H = 1080;
/** Total wall-clock time the smoke test runs (warmup + recording). */
const SMOKE_TEST_DURATION_MS = 7000;
/** Save one PNG every Nth successful capture during recording. */
const SMOKE_TEST_PNG_EVERY = 10;
/**
 * Capture cadence — `webContents.capturePage()` invocation interval.
 *
 * **Why we don't use the `paint` event:** v0.9.21–0.9.26 tried multiple
 * variations of `beginFrameSubscription` and `webContents.on("paint",
 * …)`. v0.9.25 confirmed the renderer painted 29 frames at ~31 fps
 * during initial load + hydration (t=395ms → t=1330ms) and then
 * **stopped completely** for the remaining 5.4 s. Cause: offscreen
 * renderers only emit `paint` events when the compositor is invalidated
 * by DOM/style changes; visible windows are paced by the OS
 * compositor's vsync, but offscreen renderers have no such external
 * clock. v0.9.26 attempted to force invalidation by mutating
 * `document.body.dataset.matbeastNdiTick` from main on a 33 ms
 * `setInterval` — the pump fired 208 times during the recording
 * window and produced 0 additional paints. Two reasons: (a) Chromium
 * elides paint for `data-*` attribute changes that don't affect
 * rendering, and (b) `show: false` offscreen windows may throttle the
 * renderer's JS execution itself.
 *
 * **Why `capturePage()` works:** it forces Chromium to commit a fresh
 * frame to a `NativeImage` regardless of compositor-invalidation
 * state, regardless of renderer throttling — same code path DevTools'
 * "Capture screenshot" uses. Each result is a complete 1920×1080 BGRA
 * frame we can write as PNG (smoke test) or hand to
 * `grandiose.ndiSender.video(...)` (v0.9.27+).
 *
 * **Trade-off:** capturePage involves an extra raster pass per call.
 * For 30 fps × 1920×1080 this is well within budget on any machine
 * that runs the dashboard, and it's reliable — NDI receivers drop
 * sources that miss frames, and reliability matters more than
 * per-frame efficiency at this point in development.
 *
 * **Do not reintroduce `webContents.invalidate()`** — it's documented
 * as "schedules a full repaint of the **window**", a no-op on
 * offscreen webContents. v0.9.23 tried this and produced almost no
 * frames.
 */
const CAPTURE_INTERVAL_MS = Math.round(1000 / NDI_FRAME_RATE_DEFAULT);
/**
 * Time to wait after `did-finish-load` before we begin counting captures
 * as "recorded". Gives the offscreen renderer time to:
 *   - Hydrate Next.js client components
 *   - Resolve React Query fetches against the bundled server
 *   - Load `@fontsource` web fonts (otherwise scoreboard text reflows late)
 *   - Complete the first `transform: scale(s)` fit pass
 * Captures during warmup are still attempted (so `framesDuringWarmup`
 * tells us whether the loop is alive) but not written to disk.
 */
const SMOKE_TEST_WARMUP_MS = 1500;

let activeSmokeTestRun = null;

/**
 * Create the offscreen scoreboard webContents and run the smoke test.
 *
 * @param {{ appUrl: string, userDataDir: string, preloadPath: string,
 *           onLog?: (line: string) => void }} opts
 */
async function runOffscreenSmokeTest(opts) {
  /**
   * Exclusivity is enforced by `runOffscreenSmokeTestExclusive` (the
   * exported wrapper). This inner function must NOT re-check
   * `activeSmokeTestRun` — the wrapper sets the lock before calling us,
   * so a second guard here would always trip on the very first
   * invocation. That bug shipped in v0.9.21 and immediately failed
   * every smoke-test run with "A smoke test is already running."
   */
  const log = typeof opts.onLog === "function" ? opts.onLog : () => {};

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "");
  const outputDir = path.join(opts.userDataDir, "ndi-test", stamp);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir failed: ${String(err?.message || err)}` };
  }

  log(`[ndi-smoke] output dir: ${outputDir}`);
  log(`[ndi-smoke] target ${NDI_OFFSCREEN_W}x${NDI_OFFSCREEN_H} @ ${NDI_FRAME_RATE_DEFAULT}fps`);

  /**
   * Offscreen BrowserWindow — pinned to a deterministic 1920×1080 BGRA
   * output regardless of operator hardware.
   *
   * **Resolution-locking strategy** (operator requirement: NDI source
   * dimensions must be exactly 1920×1080 on any PC, regardless of host
   * display size or DPI):
   *
   *   - `offscreen: true` — Chromium paints to memory, never the OS display.
   *   - `useContentSize: true` — `width`/`height` refer to the renderer's
   *     content area exactly, not including any chrome the OS would
   *     otherwise add. Combined with `frame: false` and offscreen mode
   *     this pins the CSS viewport to 1920×1080.
   *   - `webPreferences.zoomFactor: 1.0` — explicitly defeat any zoom
   *     drift. Belt-and-suspenders with `setZoomFactor(1.0)` post-load.
   *   - `transparent: true` — keeps alpha in the BGRA buffer.
   *   - `paintWhenInitiallyHidden: true` — required for offscreen +
   *     `show: false` to paint at all.
   *   - `backgroundThrottling: false` — paranoid; harmless on offscreen.
   *   - `autoplayPolicy: "no-user-gesture-required"` — future-proofs the
   *     bracket-music tap (planned for a later version).
   *
   * v0.9.27 captured at 2562×1529 on the operator's 2560×1600 / 150%-DPI
   * display because the renderer's `devicePixelRatio` was inherited from
   * the host. The settings above plus the explicit `rect` passed to
   * `capturePage` (see capture loop) plus the always-resize-to-1920×1080
   * fall-back below produce a deterministic broadcast frame regardless
   * of operator hardware.
   */
  const win = new BrowserWindow({
    show: false,
    width: NDI_OFFSCREEN_W,
    height: NDI_OFFSCREEN_H,
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

  const overlayQs = new URLSearchParams({ ndi: "1", outputScene: "scoreboard" });
  const targetUrl = `${opts.appUrl}/overlay?${overlayQs.toString()}`;
  log(`[ndi-smoke] loading ${targetUrl}`);

  let recording = false;
  /** Diagnostic only — paint events from Chromium's natural cycle. */
  let paintEventsDuringWarmup = 0;
  let paintEventsDuringRecording = 0;
  let firstPaintEventRelMs = null;
  let lastPaintEventRelMs = null;
  /** Capture-driven counters. These produce our PNGs / future NDI frames. */
  let captureAttempts = 0;
  let capturesDuringWarmup = 0;
  let capturesDuringRecording = 0;
  let captureFailures = 0;
  let firstCaptureRelMs = null;
  let lastCaptureRelMs = null;
  let pngsWritten = 0;
  let pngWriteFailures = 0;
  let captureSizeOnce = null;
  let firstCaptureMs = null;
  const overallStartedAt = Date.now();

  /**
   * Paint event listener — diagnostic only. Tells us whether Chromium's
   * natural paint cycle is running at all (we expect ~29 paints during
   * initial hydration, then ≈0 once the DOM goes quiescent — that's the
   * offscreen-renderer behavior identified in v0.9.25 / v0.9.26). The
   * captures driven by `capturePage` below are what produce frames; this
   * listener does not write PNGs.
   */
  const onPaint = () => {
    const rel = Date.now() - overallStartedAt;
    if (firstPaintEventRelMs === null) firstPaintEventRelMs = rel;
    lastPaintEventRelMs = rel;
    if (recording) paintEventsDuringRecording += 1;
    else paintEventsDuringWarmup += 1;
  };

  /**
   * Capture loop. `webContents.capturePage()` forces Chromium to commit a
   * fresh frame to a NativeImage regardless of compositor-invalidation
   * state. Started inside `did-finish-load` so the renderer is alive.
   * Captures during warmup are counted but discarded; once `recording`
   * flips true, every Nth successful capture is written to disk.
   *
   * `captureInFlight` guards against piling up requests on a slow tick
   * — capturePage is async and a slow capture should drop the next tick
   * rather than queue.
   */
  let captureTimer = null;
  let captureInFlight = false;
  let resizesPerformed = 0;
  const captureRect = {
    x: 0,
    y: 0,
    width: NDI_OFFSCREEN_W,
    height: NDI_OFFSCREEN_H,
  };
  /**
   * Force every captured frame to the canonical 1920×1080 BGRA broadcast
   * size before it leaves this function. Three layers of defense:
   *   1. Offscreen `BrowserWindow` is constructed with `useContentSize:
   *      true` and `zoomFactor: 1.0` (see window construction above).
   *   2. `capturePage(captureRect)` constrains the capture region.
   *   3. `image.resize(...)` if the result doesn't already match — the
   *      bulletproof guarantee. NDI receivers expect a fixed advertised
   *      resolution; any frame whose dimensions disagree with the sender's
   *      announced format is treated as a format change and re-negotiated,
   *      which causes downstream stutter.
   * `resizesPerformed` counter in the summary tells us whether layers 1+2
   * succeeded (no resize needed) or whether layer 3 had to step in.
   */
  const normalizeFrame = (image) => {
    const size = image.getSize();
    if (size.width === NDI_OFFSCREEN_W && size.height === NDI_OFFSCREEN_H) {
      return image;
    }
    resizesPerformed += 1;
    return image.resize({
      width: NDI_OFFSCREEN_W,
      height: NDI_OFFSCREEN_H,
      quality: "best",
    });
  };
  const startCaptureLoop = () => {
    if (captureTimer) return;
    captureTimer = setInterval(async () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      if (captureInFlight) return;
      captureInFlight = true;
      captureAttempts += 1;
      const startedAt = Date.now();
      try {
        const rawImage = await win.webContents.capturePage(captureRect);
        const finishedAt = Date.now();
        const rel = finishedAt - overallStartedAt;
        if (firstCaptureRelMs === null) {
          firstCaptureRelMs = rel;
          firstCaptureMs = finishedAt - startedAt;
        }
        lastCaptureRelMs = rel;
        if (captureSizeOnce === null) {
          try {
            const size = rawImage.getSize();
            captureSizeOnce = `${size.width}x${size.height}`;
            log(
              `[ndi-smoke] first capture size: ${captureSizeOnce}` +
                ` (${firstCaptureMs} ms)` +
                (size.width !== NDI_OFFSCREEN_W || size.height !== NDI_OFFSCREEN_H
                  ? ` — will resize to ${NDI_OFFSCREEN_W}x${NDI_OFFSCREEN_H}`
                  : ` — exact match, no resize needed`),
            );
          } catch {
            /* ignore */
          }
        }
        const image = normalizeFrame(rawImage);
        if (recording) {
          capturesDuringRecording += 1;
          if (capturesDuringRecording % SMOKE_TEST_PNG_EVERY === 1) {
            const idx = String(pngsWritten + 1).padStart(3, "0");
            const file = path.join(outputDir, `frame-${idx}.png`);
            try {
              const buf = image.toPNG();
              fs.writeFileSync(file, buf);
              pngsWritten += 1;
            } catch (err) {
              pngWriteFailures += 1;
              log(
                `[ndi-smoke] write ${file} failed: ${String(err?.message || err)}`,
              );
            }
          }
        } else {
          capturesDuringWarmup += 1;
        }
      } catch (err) {
        captureFailures += 1;
        if (captureFailures <= 3) {
          log(
            `[ndi-smoke] capturePage failed (${captureFailures}): ${String(
              err?.message || err,
            )}`,
          );
        }
      } finally {
        captureInFlight = false;
      }
    }, CAPTURE_INTERVAL_MS);
  };
  const stopCaptureLoop = () => {
    if (captureTimer) {
      clearInterval(captureTimer);
      captureTimer = null;
    }
  };

  win.loadURL(targetUrl, {
    extraHeaders: "pragma: no-cache\r\nCache-Control: no-cache\r\n",
  });

  /**
   * Wait for `did-finish-load`, attach the diagnostic paint listener,
   * apply `setFrameRate`, start the capture loop, then wait out the
   * warmup window. setFrameRate is post-load because Chromium's
   * renderer-init pass can reset it when set too early (verified
   * empirically against v0.9.21 / v0.9.22).
   */
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    win.webContents.once("did-finish-load", () => {
      log("[ndi-smoke] did-finish-load");
      try {
        win.webContents.on("paint", onPaint);
        log("[ndi-smoke] paint listener attached (diagnostic only)");
      } catch (err) {
        log(`[ndi-smoke] paint listener attach failed: ${String(err?.message || err)}`);
      }
      /** Lock zoom factor at 1.0. Belt-and-suspenders with the constructor
       * `webPreferences.zoomFactor: 1.0` to defeat any zoom drift that
       * would scale the renderer's CSS pixel grid away from the
       * 1920×1080 buffer. */
      try {
        win.webContents.setZoomFactor(1.0);
      } catch {
        /* ignore */
      }
      try {
        win.webContents.setFrameRate(NDI_FRAME_RATE_DEFAULT);
        log(`[ndi-smoke] setFrameRate(${NDI_FRAME_RATE_DEFAULT}) applied post-load`);
      } catch (err) {
        log(`[ndi-smoke] setFrameRate failed (continuing): ${String(err?.message || err)}`);
      }
      /** Diagnostic: log the renderer's view of itself so we can confirm
       * `useContentSize` + `zoomFactor` worked as intended on this machine. */
      win.webContents
        .executeJavaScript(
          "({dpr:window.devicePixelRatio,iw:window.innerWidth,ih:window.innerHeight})",
          true,
        )
        .then((info) => {
          log(
            `[ndi-smoke] renderer dpr=${info?.dpr} innerWidth=${info?.iw} innerHeight=${info?.ih}`,
          );
        })
        .catch(() => {
          /* ignore */
        });
      startCaptureLoop();
      log(`[ndi-smoke] capture loop started (every ${CAPTURE_INTERVAL_MS} ms)`);
      setTimeout(settle, SMOKE_TEST_WARMUP_MS);
    });
    /** Belt-and-suspenders: don't hang forever if did-finish-load doesn't fire. */
    setTimeout(settle, SMOKE_TEST_WARMUP_MS + 4000);
  });

  log(
    `[ndi-smoke] warmup complete (paintEventsDuringWarmup=${paintEventsDuringWarmup},` +
      ` capturesDuringWarmup=${capturesDuringWarmup},` +
      ` captureFailures=${captureFailures}); recording`,
  );
  const recordingStartedAt = Date.now();
  recording = true;

  const recordingMs = Math.max(
    1000,
    SMOKE_TEST_DURATION_MS - (recordingStartedAt - overallStartedAt),
  );
  await new Promise((resolve) => setTimeout(resolve, recordingMs));
  recording = false;
  stopCaptureLoop();

  try {
    win.webContents.removeListener("paint", onPaint);
  } catch {
    /* ignore */
  }

  const recordingDurationMs = Date.now() - recordingStartedAt;
  const totalDurationMs = Date.now() - overallStartedAt;
  const observedFps =
    recordingDurationMs > 0
      ? +(capturesDuringRecording / (recordingDurationMs / 1000)).toFixed(2)
      : 0;
  log(
    `[ndi-smoke] complete:` +
      ` paintEventsDuringWarmup=${paintEventsDuringWarmup}` +
      ` paintEventsDuringRecording=${paintEventsDuringRecording}` +
      ` captureAttempts=${captureAttempts}` +
      ` capturesDuringWarmup=${capturesDuringWarmup}` +
      ` capturesDuringRecording=${capturesDuringRecording}` +
      ` captureFailures=${captureFailures}` +
      ` pngsWritten=${pngsWritten}` +
      ` pngWriteFailures=${pngWriteFailures}` +
      ` recordingDurationMs=${recordingDurationMs}` +
      ` totalDurationMs=${totalDurationMs}` +
      ` observedFps=${observedFps}` +
      ` firstCaptureRelMs=${firstCaptureRelMs ?? "never"}` +
      ` lastCaptureRelMs=${lastCaptureRelMs ?? "never"}` +
      ` firstPaintEventRelMs=${firstPaintEventRelMs ?? "never"}` +
      ` lastPaintEventRelMs=${lastPaintEventRelMs ?? "never"}`,
  );

  try {
    const summary = {
      timestamp: stamp,
      paintEventsDuringWarmup,
      paintEventsDuringRecording,
      captureAttempts,
      capturesDuringWarmup,
      capturesDuringRecording,
      captureFailures,
      pngsWritten,
      pngWriteFailures,
      resizesPerformed,
      captureIntervalMs: CAPTURE_INTERVAL_MS,
      recordingDurationMs,
      totalDurationMs,
      observedFps,
      firstCaptureRelMs,
      lastCaptureRelMs,
      firstPaintEventRelMs,
      lastPaintEventRelMs,
      captureSize: captureSizeOnce,
      firstCaptureMs,
      targetUrl,
      bufferWidth: NDI_OFFSCREEN_W,
      bufferHeight: NDI_OFFSCREEN_H,
      frameRate: NDI_FRAME_RATE_DEFAULT,
      warmupMs: SMOKE_TEST_WARMUP_MS,
    };
    fs.writeFileSync(
      path.join(outputDir, "summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );
  } catch {
    /* ignore */
  }

  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* ignore */
  }

  /** Reveal the output dir in Explorer so the operator can immediately
   * inspect the captured frames. `shell.openPath` returns "" on success. */
  try {
    await shell.openPath(outputDir);
  } catch {
    /* ignore */
  }

  /** Exclusivity lock is owned by the wrapper's `finally` block; this
   * function does not touch `activeSmokeTestRun`. */
  return {
    ok: true,
    outputDir,
    framesCaptured: capturesDuringRecording,
    framesDuringWarmup: capturesDuringWarmup,
    pngsWritten,
    recordingDurationMs,
    totalDurationMs,
    observedFps,
  };
}

/** Wrapper that locks against double-runs. */
async function runOffscreenSmokeTestExclusive(opts) {
  if (activeSmokeTestRun) {
    return { ok: false, error: "A smoke test is already running." };
  }
  activeSmokeTestRun = { startedAt: Date.now() };
  try {
    return await runOffscreenSmokeTest(opts);
  } finally {
    activeSmokeTestRun = null;
  }
}

module.exports = {
  runOffscreenSmokeTest: runOffscreenSmokeTestExclusive,
  NDI_OFFSCREEN_W,
  NDI_OFFSCREEN_H,
  NDI_FRAME_RATE_DEFAULT,
};
