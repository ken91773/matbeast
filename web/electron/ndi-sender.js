/**
 * Lazy wrapper around `grandiose` (Streampunk's NDI N-API binding).
 *
 * Lazy-load is deliberate. The native `grandiose.node` is rebuilt against
 * Electron's Node ABI via `@electron/rebuild` (see `npm run
 * ndi:rebuild-electron`), and `Processing.NDI.Lib.x64.dll` rides along inside
 * the package. If either is missing or the operator's machine fails the
 * `NDIlib_initialize` CPU check, `require("grandiose")` will throw at the
 * first call site. We catch that here and degrade to "NDI unavailable" mode
 * so the app keeps working — only NDI features are disabled.
 *
 * What's exposed (v0.9.29):
 *  - `isAvailable()` — does the binding load and report a supported CPU?
 *  - `getStatus()` — diagnostic snapshot for menus / future Settings UI.
 *  - `createNdiSender({ name, frameRate })` — wraps `grandiose.send(...)`
 *    and returns `{ ok: true, sender }` or `{ ok: false, error }`. The
 *    returned `sender` has `.video(frame)` -> Promise from grandiose.
 *  - `sendNdiVideoFrame(sender, image, frameRateN, frameRateD)` —
 *    serialises an Electron `NativeImage` (BGRA on Windows) into the
 *    `VideoFrame` shape `grandiose` expects, then `await sender.video(...)`.
 *  - `destroyNdiSender(sender)` — drops the reference. grandiose's
 *    `finalizeSend` cleans up the underlying `NDIlib_send_destroy` on GC,
 *    but we make the GC happen sooner by clearing our reference.
 *
 * Why we don't import grandiose at the top of the file:
 *   1. Loading the `.node` binary triggers `NDIlib_initialize`, which logs
 *      "NewTek NDI Copyright …" to stderr. We don't want that on every app
 *      start — only when the operator turns NDI on.
 *   2. If the native binding fails to load (missing DLL, ABI mismatch) we
 *      want main.js to keep booting; only the NDI menu items should fail.
 *   3. Treats `grandiose` as a soft dependency: a future build that
 *      excludes it (e.g. for a non-NDI variant) doesn't crash.
 *
 * BGRA / alpha:
 *   Electron's `NativeImage.toBitmap()` returns BGRA on Windows. NDI
 *   FourCC code 1095911234 is "BGRA" (little-endian: 'B'=0x42, 'G'=0x47,
 *   'R'=0x52, 'A'=0x41 → 0x41524742 → 1095911234). The scoreboard
 *   overlay is rendered with `transparent: true`, so its alpha channel
 *   survives into the BGRA buffer — required for downstream NDI receivers
 *   that composite the scoreboard over their own background (vMix, OBS
 *   NDI source with "Allow alpha"). The bracket overlay is opaque, but
 *   we still ship BGRA — the alpha bytes are simply 0xFF for opaque
 *   pixels.
 */
const path = require("node:path");
const fs = require("node:fs");

const NDI_FOURCC_BGRA = 1095911234;
const NDI_FRAME_FORMAT_TYPE_PROGRESSIVE = 1;

let grandioseModule = null;
let loadAttempted = false;
let loadError = null;
let supportedCpu = null;
let ndiVersion = null;

function ensureLoaded() {
  if (grandioseModule || loadError) {
    return { ok: !loadError, error: loadError };
  }
  loadAttempted = true;
  try {
    grandioseModule = require("grandiose");
    try {
      supportedCpu = Boolean(grandioseModule.isSupportedCPU());
    } catch (err) {
      supportedCpu = false;
      loadError = `isSupportedCPU threw: ${String(err?.message || err)}`;
      return { ok: false, error: loadError };
    }
    if (!supportedCpu) {
      loadError = "NDI reports this CPU is not supported.";
      return { ok: false, error: loadError };
    }
    try {
      ndiVersion = String(grandioseModule.version() || "").trim();
    } catch {
      ndiVersion = null;
    }
    return { ok: true };
  } catch (err) {
    loadError = String(err?.message || err);
    return { ok: false, error: loadError };
  }
}

function isAvailable() {
  if (!loadAttempted) ensureLoaded();
  return Boolean(grandioseModule) && supportedCpu === true;
}

function getStatus() {
  if (!loadAttempted) ensureLoaded();
  let dllPath = null;
  try {
    dllPath = require.resolve(
      path.join("grandiose", "lib", "win_x64", "Processing.NDI.Lib.x64.dll"),
    );
  } catch {
    try {
      const guess = path.join(
        path.dirname(require.resolve("grandiose/package.json")),
        "lib",
        "win_x64",
        "Processing.NDI.Lib.x64.dll",
      );
      if (fs.existsSync(guess)) dllPath = guess;
    } catch {
      /* ignore */
    }
  }
  return {
    available: Boolean(grandioseModule) && supportedCpu === true,
    error: loadError,
    supportedCpu,
    ndiVersion,
    dllPath,
  };
}

/**
 * Create an NDI sender. Returns `{ ok: true, sender }` or `{ ok: false, error }`.
 *
 * `sender` is the object returned by `grandiose.send(...)` — opaque to
 * callers. The only methods we use are:
 *   - `sender.video(VideoFrame)` -> Promise (called by sendNdiVideoFrame)
 *   - `sender.audio(AudioFrame)` -> Promise (planned for v0.9.30, bracket
 *     music tap)
 *
 * `clockVideo: false` deliberately. With `clockVideo: true`, grandiose
 * paces our `video()` calls itself by sleeping inside the underlying
 * `NDIlib_send_send_video_v2` until the announced frame rate is met.
 * That throttles our event loop and risks back-pressure if the capture
 * loop is faster than the announced rate. Our offscreen capture loop
 * already runs at exactly 30 fps via `setInterval(33ms)`, so we do the
 * pacing ourselves and let NDI just pass each frame through.
 *
 * @param {{ name: string, frameRate?: number }} opts
 * @returns {Promise<{ ok: true, sender: object } | { ok: false, error: string }>}
 */
async function createNdiSender(opts) {
  const loaded = ensureLoaded();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (!opts?.name || typeof opts.name !== "string") {
    return { ok: false, error: "createNdiSender: opts.name is required" };
  }
  try {
    const sender = await grandioseModule.send({
      name: opts.name,
      clockVideo: false,
      clockAudio: false,
    });
    return { ok: true, sender };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Submit one BGRA frame to NDI. Returns the promise from `sender.video(...)`
 * so callers can `await` and apply back-pressure when needed (we do not, in
 * v0.9.30, since `setInterval(33ms)` paces the loop and NDI can buffer).
 *
 * Resolves the DIP-vs-pixel ambiguity in `NativeImage`:
 *   `image.getSize()` returns DIPs; `toBitmap()` returns physical pixels.
 *   On a 1.0 scale-factor monitor the two agree, but on the operator's
 *   2560×1600 / 150 % display (which v0.9.29 first ran on), `getSize()`
 *   reported 1920×1080 (post-resize, in DIPs) while `toBitmap()` returned
 *   the physical 2880×1620 buffer — 18.7 MB of pixel data laid out at
 *   stride 11520, but our advertised stride was 7680. NDI receivers
 *   would see "Mat Beast Scoreboard" appear (mDNS announcement worked)
 *   but no video, because the bytes after row 0 disagreed with the
 *   announced format and the receiver couldn't decode the frame.
 *
 * Fix: derive the true pixel dimensions from `toBitmap().length` /
 * (4 × yres) rather than trusting `getSize()`. If `image.resize()` or
 * `Skia` returned a 1.0-scale bitmap, the values agree; if they returned
 * a higher-DPR bitmap, we use the actual pixel count. Both paths produce
 * a coherent (xres, yres, lineStrideBytes, data) tuple.
 *
 * Diagnostic: the first `DIAG_FRAME_COUNT` calls log the discrepancy via
 * `opts.onLog` — `getSize` says X×Y, buffer says A×B. After confirmation
 * we leave the diagnostic in place but throttled, so production logs
 * don't drown in per-frame spam.
 *
 * @param {object} sender returned by createNdiSender
 * @param {Electron.NativeImage} image  BGRA frame from offscreen capture.
 * @param {number} frameRateN  frame rate numerator (e.g. 30000)
 * @param {number} frameRateD  frame rate denominator (e.g. 1000 → 30.000 fps)
 * @param {(line: string) => void} [onLog]
 */
const DIAG_FRAME_COUNT = 3;
const diagFrameCounters = new WeakMap();

async function sendNdiVideoFrame(sender, image, frameRateN, frameRateD, onLog) {
  if (!sender || typeof sender.video !== "function") {
    throw new Error("sendNdiVideoFrame: sender is invalid or already destroyed");
  }
  const reportedSize = image.getSize();
  const data = image.toBitmap();
  const bufferLength = data.length;

  /**
   * Derive true pixel dimensions from the buffer length. Two layouts are
   * possible:
   *   1. Buffer length == reportedSize.width * reportedSize.height * 4.
   *      DIPs and pixels agree (scale factor 1.0 or correctly-resized).
   *   2. Buffer length == (reportedSize.width * scale) * (reportedSize.height * scale) * 4.
   *      DIPs are smaller than physical pixels (high-DPR display).
   *
   * In case 2 we infer the integer scale factor and adjust width/height
   * accordingly. This handles the DPR == 1.5 (1920->2880, 1080->1620)
   * case the operator hit in v0.9.29 and any other ratio that produces
   * a buffer length consistent with a square scale.
   */
  const expectedAtReported = reportedSize.width * reportedSize.height * 4;
  let xres = reportedSize.width;
  let yres = reportedSize.height;
  let inferredFromBuffer = false;
  if (bufferLength !== expectedAtReported && reportedSize.width > 0 && reportedSize.height > 0) {
    const ratio = bufferLength / expectedAtReported;
    const linearScale = Math.sqrt(ratio);
    if (Number.isFinite(linearScale) && linearScale > 0) {
      const scaledWidth = Math.round(reportedSize.width * linearScale);
      const scaledHeight = Math.round(reportedSize.height * linearScale);
      if (scaledWidth * scaledHeight * 4 === bufferLength) {
        xres = scaledWidth;
        yres = scaledHeight;
        inferredFromBuffer = true;
      }
    }
  }
  const lineStrideBytes = xres * 4;

  const counters = diagFrameCounters.get(sender) || { count: 0 };
  if (counters.count < DIAG_FRAME_COUNT && typeof onLog === "function") {
    counters.count += 1;
    diagFrameCounters.set(sender, counters);
    const firstBytesHex = Array.from(data.subarray(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    onLog(
      `[ndi-sender] frame#${counters.count}` +
        ` reportedSize=${reportedSize.width}x${reportedSize.height}` +
        ` bufferLength=${bufferLength}` +
        ` expectedAtReported=${expectedAtReported}` +
        ` -> xres=${xres} yres=${yres} stride=${lineStrideBytes}` +
        ` inferredFromBuffer=${inferredFromBuffer}` +
        ` firstBytes=${firstBytesHex}`,
    );
  }

  return sender.video({
    type: "video",
    xres,
    yres,
    frameRateN,
    frameRateD,
    pictureAspectRatio: xres > 0 && yres > 0 ? xres / yres : 16 / 9,
    frameFormatType: NDI_FRAME_FORMAT_TYPE_PROGRESSIVE,
    timecode: [0, 0],
    lineStrideBytes,
    fourCC: NDI_FOURCC_BGRA,
    data,
  });
}

/**
 * v0.9.34: submit one planar Float32 audio frame to NDI.
 *
 * `payload.planar` is an ArrayBuffer (or Buffer) carrying channel-major
 * Float32 samples — channel 0 first (`numSamples` floats), then channel
 * 1, etc. NDI's audio_frame_v2 expects exactly this layout when
 * `channel_stride_in_bytes = numSamples * 4`. The patched grandiose
 * `sender.audio({...})` reads the buffer pointer + dimensions and calls
 * `NDIlib_send_send_audio_v2` directly — no copy, no reformat.
 *
 * Diagnostic: the first `DIAG_AUDIO_FRAME_COUNT` calls log sample-rate /
 * channel count / sample count / RMS amplitude so we can confirm the
 * AudioWorklet tap is producing real audio (not silence) before the
 * frame leaves our process. RMS near 0 = silent capture; ~0.05–0.5 =
 * normal music.
 *
 * @param {object} sender returned by createNdiSender (with audio support
 *                        from the patched grandiose).
 * @param {{ sampleRate:number, numChannels:number, numSamples:number,
 *           planar: ArrayBuffer | Buffer | Uint8Array }} payload
 * @param {(line: string) => void} [onLog]
 */
const DIAG_AUDIO_FRAME_COUNT = 3;
const diagAudioFrameCounters = new WeakMap();

async function sendNdiAudioFrame(sender, payload, onLog) {
  if (!sender || typeof sender.audio !== "function") {
    throw new Error(
      "sendNdiAudioFrame: sender.audio is missing — grandiose was not patched with audio support",
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("sendNdiAudioFrame: payload required");
  }
  const sampleRate = Number(payload.sampleRate);
  const numChannels = Number(payload.numChannels);
  const numSamples = Number(payload.numSamples);
  if (!sampleRate || !numChannels || !numSamples) {
    throw new Error(
      `sendNdiAudioFrame: invalid dims (sampleRate=${sampleRate}, numChannels=${numChannels}, numSamples=${numSamples})`,
    );
  }
  /**
   * Normalise input shapes:
   *   - ArrayBuffer  → wrap directly without copying (Buffer.from over
   *     ArrayBuffer shares memory).
   *   - Buffer       → use as-is.
   *   - Uint8Array   → wrap (also shares memory).
   * Anything else is rejected.
   */
  let buffer;
  if (payload.planar instanceof ArrayBuffer) {
    buffer = Buffer.from(payload.planar);
  } else if (Buffer.isBuffer(payload.planar)) {
    buffer = payload.planar;
  } else if (payload.planar instanceof Uint8Array) {
    buffer = Buffer.from(
      payload.planar.buffer,
      payload.planar.byteOffset,
      payload.planar.byteLength,
    );
  } else {
    throw new Error(
      "sendNdiAudioFrame: payload.planar must be an ArrayBuffer, Buffer, or Uint8Array",
    );
  }
  const channelStrideInBytes = numSamples * 4;
  const expectedLength = numChannels * channelStrideInBytes;
  if (buffer.length !== expectedLength) {
    throw new Error(
      `sendNdiAudioFrame: buffer length ${buffer.length} != ${expectedLength} (numChannels=${numChannels}, numSamples=${numSamples}, planar Float32)`,
    );
  }

  const counters = diagAudioFrameCounters.get(sender) || { count: 0 };
  if (counters.count < DIAG_AUDIO_FRAME_COUNT && typeof onLog === "function") {
    counters.count += 1;
    diagAudioFrameCounters.set(sender, counters);
    /**
     * RMS over channel 0, computed from a Float32Array view of the
     * buffer slice. Cheap (≤1024 samples per audio frame) and tells
     * us at a glance whether the tap is producing audio or silence.
     */
    const ch0 = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      numSamples,
    );
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < ch0.length; i++) {
      const s = ch0[i];
      sumSq += s * s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, ch0.length));
    onLog(
      `[ndi-sender] audio frame#${counters.count}` +
        ` sampleRate=${sampleRate}` +
        ` numChannels=${numChannels}` +
        ` numSamples=${numSamples}` +
        ` channelStrideInBytes=${channelStrideInBytes}` +
        ` ch0.rms=${rms.toFixed(5)}` +
        ` ch0.peak=${peak.toFixed(5)}`,
    );
  }

  return sender.audio({
    sampleRate,
    numChannels,
    numSamples,
    channelStrideInBytes,
    data: buffer,
  });
}

/**
 * Drop our reference to the sender. grandiose's `finalizeSend` C++ hook
 * (see `src/grandiose_send.cc`) calls `NDIlib_send_destroy` when the JS
 * object is GC'd. We don't have a synchronous teardown — `setImmediate`
 * + `global.gc()` (only in --expose-gc builds) are not reliable. The
 * receiver will see the source disappear within ~1–3 seconds when GC
 * actually runs.
 *
 * If we ever need a hard sync teardown (e.g. before-quit must complete in
 * <500 ms or Windows kills the process), we'll add a native `destroy()`
 * method to grandiose.
 */
function destroyNdiSender(sender) {
  if (!sender) return;
  try {
    if ("video" in sender) {
      delete sender.video;
    }
    if ("audio" in sender) {
      delete sender.audio;
    }
  } catch {
    /* ignore */
  }
}

module.exports = {
  isAvailable,
  getStatus,
  createNdiSender,
  sendNdiVideoFrame,
  sendNdiAudioFrame,
  destroyNdiSender,
  NDI_FOURCC_BGRA,
  NDI_FRAME_FORMAT_TYPE_PROGRESSIVE,
};
