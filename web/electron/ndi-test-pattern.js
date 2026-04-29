/**
 * NDI BGRA test-pattern source (v0.9.32 diagnostic).
 *
 * Why this exists:
 *   v0.9.29 → v0.9.31 ship a fully-instrumented offscreen-render → grandiose
 *   pipeline. Diagnostics from v0.9.31 prove every layer is healthy:
 *     - The offscreen renderer produces beautiful 1920×1080 frames (saved
 *       as PNG to <userData>/ndi-debug/<stamp>/<scene>-frame-001.png).
 *     - The BGRA buffer is 8,294,400 bytes, matches `getSize()`, has real
 *       opaque pixel data (94 % non-zero in the bracket frame).
 *     - `sender.video(...)` returns success for every frame (631 frames sent,
 *       0 failures across a 25-second test run).
 *     - The NDI source name appears in Studio Monitor / OBS source lists,
 *       confirming the mDNS announcement is reaching receivers.
 *
 *   And yet receivers display BLACK when the source is selected. That
 *   pattern (source visible, video missing) is consistent with either:
 *     a) The NDI 5.5.2.0 runtime bundled with grandiose's master branch
 *        mishandling our specific BGRA byte layout (premultiplied alpha?
 *        non-broadcast resolution? something else NDI is silently
 *        rejecting after `send_send_video_v2` returns "OK"?).
 *     b) Windows Firewall silently blocking the TCP video-delivery port
 *        range (NDI uses 5960+ for video streams; mDNS is UDP multicast
 *        on 5353 and Windows allows that by default). Source appears
 *        because mDNS got through; video doesn't because TCP is blocked.
 *     c) A network-interface binding mismatch on multi-NIC machines.
 *
 *   This module isolates which side of the boundary the bug is on. It
 *   skips the offscreen `BrowserWindow` and React entirely — generates
 *   a known-good 1920×1080 BGRA color-bar buffer in pure JavaScript
 *   and pushes it through `sender.video()` at 30 fps for 30 seconds.
 *
 *   Receiver outcomes:
 *     - Test pattern visible in Studio Monitor → NDI pipeline is fine,
 *       our React content has some property NDI mishandles. Likely
 *       fixes: switch from BGRA premultiplied to BGRA straight-alpha,
 *       or use `BGRX` for opaque-only frames, or add a CSS-defined
 *       opaque background to the offscreen renderer.
 *     - Test pattern still black/missing → bug is below the buffer
 *       layer. Either the NDI runtime version, Windows Firewall, or
 *       the network interface NDI is binding to. None of those need
 *       JS code fixes; they need user-side configuration.
 *
 *   Either way we get a definitive answer in one round-trip.
 *
 * Test pattern design:
 *   Standard 8-bar SMPTE-style color bars (white, yellow, cyan, green,
 *   magenta, red, blue, black) plus a moving white square so the operator
 *   can confirm the receiver is actually showing live frames (not a
 *   stuck single image). Bars run vertically across the full 1080 height;
 *   the moving square sweeps the bottom 100 px every 30 frames.
 *
 *   We deliberately send fully-opaque pixels (alpha=255 everywhere) — if
 *   the receiver shows the bars but our scoreboard didn't, the issue is
 *   premultiplied-alpha-related and we know exactly where to look next.
 */
const ndiSender = require("./ndi-sender.js");

const TP_W = 1920;
const TP_H = 1080;
const TP_FPS = 30;
const TP_DEFAULT_DURATION_MS = 30_000;
const TP_NAME = "Mat Beast Test Pattern";

/** Standard 8-bar SMPTE color order (left to right). */
const TP_BARS_BGRA = [
  // BGRA: [B, G, R, A]
  [255, 255, 255, 255], // white
  [0, 255, 255, 255], // yellow (R+G)
  [255, 255, 0, 255], // cyan (G+B)
  [0, 255, 0, 255], // green
  [255, 0, 255, 255], // magenta (R+B)
  [0, 0, 255, 255], // red
  [255, 0, 0, 255], // blue
  [0, 0, 0, 255], // black
];

let activeRun = null;

/**
 * Allocate one frame's worth of BGRA bytes pre-painted with the standard
 * 8-bar pattern. We mutate a single buffer per tick to add the moving
 * square — Buffer.from on a 8.3 MB allocation is cheap (memcpy) but we
 * avoid the GC pressure by keeping one persistent canvas and only
 * touching the moving-square pixels each frame.
 *
 * Returns a Node Buffer (length TP_W * TP_H * 4) with full alpha.
 */
function paintInitialFrame() {
  const data = Buffer.alloc(TP_W * TP_H * 4);
  const barWidth = Math.floor(TP_W / TP_BARS_BGRA.length);
  for (let y = 0; y < TP_H; y += 1) {
    for (let x = 0; x < TP_W; x += 1) {
      const barIndex = Math.min(TP_BARS_BGRA.length - 1, Math.floor(x / barWidth));
      const [b, g, r, a] = TP_BARS_BGRA[barIndex];
      const off = (y * TP_W + x) * 4;
      data[off] = b;
      data[off + 1] = g;
      data[off + 2] = r;
      data[off + 3] = a;
    }
  }
  return data;
}

/**
 * Reset the bottom-100-px band to clean color bars (so previous moving-
 * square positions don't leave a trail) and then paint a fresh white
 * square. This is faster than re-painting the entire frame each tick.
 */
const SQUARE_SIZE = 80;
const SQUARE_BAND_TOP = TP_H - 100;
const SQUARE_Y_TOP = TP_H - 90;

function repaintBottomBandBars(data) {
  const barWidth = Math.floor(TP_W / TP_BARS_BGRA.length);
  for (let y = SQUARE_BAND_TOP; y < TP_H; y += 1) {
    for (let x = 0; x < TP_W; x += 1) {
      const barIndex = Math.min(TP_BARS_BGRA.length - 1, Math.floor(x / barWidth));
      const [b, g, r, a] = TP_BARS_BGRA[barIndex];
      const off = (y * TP_W + x) * 4;
      data[off] = b;
      data[off + 1] = g;
      data[off + 2] = r;
      data[off + 3] = a;
    }
  }
}

function paintMovingSquare(data, frameIndex) {
  /** Sweep the square left→right→left over the frame's full width. The
   * cycle is 60 frames (2 seconds at 30 fps); receivers should easily
   * detect the motion to confirm frames are arriving live. */
  const cyclePos = (frameIndex % 60) / 60; // 0..1
  const triangle = cyclePos < 0.5 ? cyclePos * 2 : (1 - cyclePos) * 2;
  const sx = Math.floor(triangle * (TP_W - SQUARE_SIZE));
  for (let y = SQUARE_Y_TOP; y < SQUARE_Y_TOP + SQUARE_SIZE; y += 1) {
    for (let x = sx; x < sx + SQUARE_SIZE; x += 1) {
      const off = (y * TP_W + x) * 4;
      data[off] = 255;
      data[off + 1] = 255;
      data[off + 2] = 255;
      data[off + 3] = 255;
    }
  }
}

/**
 * Run the test-pattern sender. Resolves with `{ ok, framesSent,
 * sendFailures, durationMs, error? }` once the duration elapses or the
 * sender is destroyed. At most one run at a time across the whole app.
 *
 * @param {{ durationMs?: number, onLog?: (line: string) => void }} opts
 */
async function runTestPattern(opts = {}) {
  if (activeRun) {
    return { ok: false, error: "Test pattern is already running." };
  }
  const log = typeof opts.onLog === "function" ? opts.onLog : () => {};
  const durationMs = Math.max(1000, Math.min(120_000, opts.durationMs || TP_DEFAULT_DURATION_MS));

  if (!ndiSender.isAvailable()) {
    const status = ndiSender.getStatus();
    return {
      ok: false,
      error: status.error || "NDI runtime not available.",
    };
  }

  log(`[ndi-test-pattern] starting "${TP_NAME}" @ ${TP_FPS}fps for ${durationMs}ms`);
  const senderResult = await ndiSender.createNdiSender({
    name: TP_NAME,
    frameRate: TP_FPS,
  });
  if (!senderResult.ok) {
    log(`[ndi-test-pattern] createNdiSender failed: ${senderResult.error}`);
    return { ok: false, error: senderResult.error };
  }
  const sender = senderResult.sender;

  /** Persistent paint buffer — initial fill with the static 8-bar pattern;
   * each tick repaints only the bottom band (square trail + moving square). */
  const data = paintInitialFrame();
  log(
    `[ndi-test-pattern] generated ${TP_W}x${TP_H} BGRA buffer` +
      ` (${data.length} bytes, all alpha=255). First 16 bytes = ${Array.from(
        data.subarray(0, 16),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`,
  );

  let framesSent = 0;
  let sendFailures = 0;
  let lastError = null;
  let frameIndex = 0;
  const startedAt = Date.now();
  const intervalMs = Math.round(1000 / TP_FPS);

  /** We can't call `sender.video()` directly with a JS-allocated Buffer
   * because grandiose retains the pointer until its async work completes.
   * Each frame allocates a fresh Buffer (8.3 MB) and copies the canvas in.
   * 8.3 MB * 30 fps = 250 MB/s of allocation churn — V8 handles this
   * fine for short test runs, and we explicitly release between frames
   * by letting `data` (per-tick) go out of scope. We DO NOT reuse the
   * single canvas Buffer across `sender.video()` calls — grandiose holds
   * the pointer beyond our function return. */
  const tick = async () => {
    if (!activeRun) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= durationMs) {
      stop("duration elapsed");
      return;
    }
    repaintBottomBandBars(data);
    paintMovingSquare(data, frameIndex);
    /** Per-frame buffer copy: grandiose holds the pointer in a napi_ref
     * until `videoSendComplete` fires, so we must hand it a buffer it
     * owns the lifetime of. `Buffer.from(data)` produces a fresh buffer
     * with copied bytes and grandiose's `napi_create_reference(... 1 ...)`
     * keeps it alive for exactly the duration of `NDIlib_send_send_video_v2`. */
    const frameBuf = Buffer.from(data);
    frameIndex += 1;
    try {
      await sender.video({
        type: "video",
        xres: TP_W,
        yres: TP_H,
        frameRateN: TP_FPS * 1000,
        frameRateD: 1000,
        pictureAspectRatio: TP_W / TP_H,
        frameFormatType: 1, // progressive
        timecode: [0, 0],
        lineStrideBytes: TP_W * 4,
        fourCC: ndiSender.NDI_FOURCC_BGRA,
        data: frameBuf,
      });
      framesSent += 1;
      if (framesSent === 1) {
        log(`[ndi-test-pattern] first frame sent (${Date.now() - startedAt}ms after start)`);
      }
    } catch (err) {
      sendFailures += 1;
      lastError = String(err?.message || err);
      if (sendFailures <= 5) {
        log(`[ndi-test-pattern] send failure #${sendFailures}: ${lastError}`);
      }
    }
  };

  let timer = setInterval(tick, intervalMs);
  let resolveDone = null;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function stop(reason) {
    if (!activeRun) return;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const totalMs = Date.now() - startedAt;
    log(
      `[ndi-test-pattern] stopped (${reason}). framesSent=${framesSent}` +
        ` sendFailures=${sendFailures}` +
        ` totalMs=${totalMs}` +
        (lastError ? ` lastError=${lastError}` : ""),
    );
    ndiSender.destroyNdiSender(sender);
    activeRun = null;
    resolveDone({
      ok: true,
      framesSent,
      sendFailures,
      durationMs: totalMs,
      lastError,
    });
  }

  activeRun = { stop };
  return donePromise;
}

function isTestPatternRunning() {
  return Boolean(activeRun);
}

function stopTestPattern() {
  if (activeRun) {
    activeRun.stop("manual stop");
  }
}

module.exports = {
  runTestPattern,
  isTestPatternRunning,
  stopTestPattern,
  TP_NAME,
};
