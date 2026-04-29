/**
 * NDI feed = one offscreen overlay source + one NDI sender.
 *
 * v0.9.29 ships exactly one feed at a time (the scoreboard). v0.9.30+ will
 * add the bracket feed alongside it. This module is parameterised by scene
 * so the bracket feed will require no new code here.
 *
 * Lifecycle:
 *   startNdiFeed(scene)
 *     1. Lazy-load grandiose. If unavailable → return error to caller.
 *     2. Create offscreen overlay source (offscreen window + capture loop).
 *     3. Create NDI sender named per `getDefaultSourceName(scene)`.
 *     4. Wire each captured BGRA frame into `sender.video(...)` —
 *        fire-and-forget so `setInterval(33ms)` can keep ticking even if
 *        an individual `send` is still in flight (NDI's own queue is fine
 *        with this).
 *     5. Track stats and expose them via `getStatus(scene)`.
 *
 *   stopNdiFeed(scene)
 *     1. Destroy the offscreen source (stops the capture pump, closes
 *        the BrowserWindow).
 *     2. Destroy the NDI sender (drops our reference; underlying
 *        NDIlib_send_destroy runs on JS GC — see ndi-sender.js).
 *
 *   stopAllNdiFeeds()  — used from app.before-quit.
 *
 * Concurrency / ordering invariants:
 *   - At most one feed per scene. Calling startNdiFeed("scoreboard")
 *     twice is idempotent — the existing feed is returned.
 *   - Feeds are independent: stopping the scoreboard feed does not affect
 *     a running bracket feed.
 *   - If the renderer in the offscreen window crashes mid-stream, the
 *     capture loop will start failing and we'll log it; we do NOT auto-
 *     restart in v0.9.29 (planned for v0.9.31).
 *
 * Error policy:
 *   - Send failures (e.g. NDI runtime not present despite the binding
 *     loading) increment `sendFailures` but do not stop the feed —
 *     receivers may come back, and silently dropping frames is the same
 *     behaviour as broadcast TV.
 *   - Capture failures from the offscreen source cascade through
 *     `onError`; first occurrence is logged, subsequent failures are
 *     counted only.
 */
const path = require("node:path");

const { createOffscreenSource } = require("./ndi-source.js");
const ndiSender = require("./ndi-sender.js");

const NDI_FRAME_RATE_DEFAULT = 30;

/**
 * NDI source names. Burned in for v0.9.29. v0.9.31 adds operator-editable
 * names persisted in `desktopPreferences.ndiSourceNames`.
 */
const DEFAULT_SOURCE_NAMES = {
  scoreboard: "Mat Beast Scoreboard",
  bracket: "Mat Beast Bracket",
};

function getDefaultSourceName(scene) {
  return DEFAULT_SOURCE_NAMES[scene] || "Mat Beast";
}

/** @type {Map<string, FeedRecord>} */
const activeFeeds = new Map();

/**
 * @typedef {Object} FeedRecord
 * @property {"scoreboard"|"bracket"} scene
 * @property {string}  sourceName
 * @property {number}  frameRate
 * @property {object}  source     OffscreenSourceHandle from ndi-source
 * @property {object}  sender     grandiose Sender object
 * @property {number}  startedAt
 * @property {number}  framesSent
 * @property {number}  sendFailures
 * @property {string|null} lastSendError
 */

/**
 * Start the NDI feed for the given scene. Returns the feed status object
 * (or a `{ ok: false, error }` if startup failed at any layer).
 *
 * @param {{
 *   scene: "scoreboard"|"bracket",
 *   appUrl: string,
 *   preloadPath: string,
 *   userDataDir: string,
 *   frameRate?: number,
 *   sourceName?: string,
 *   onLog?: (line: string) => void,
 * }} opts
 */
async function startNdiFeed(opts) {
  const { scene } = opts;
  if (scene !== "scoreboard" && scene !== "bracket") {
    return { ok: false, error: `startNdiFeed: unknown scene "${scene}"` };
  }
  if (activeFeeds.has(scene)) {
    return {
      ok: true,
      already: true,
      status: getStatus(scene),
    };
  }

  const log = typeof opts.onLog === "function" ? opts.onLog : () => {};

  if (!ndiSender.isAvailable()) {
    const status = ndiSender.getStatus();
    return {
      ok: false,
      error:
        status.error ||
        "NDI runtime not available. Install NDI Tools (https://www.ndi.video/tools/).",
      ndiStatus: status,
    };
  }

  const frameRate = Math.max(1, Math.min(60, opts.frameRate || NDI_FRAME_RATE_DEFAULT));
  const sourceName = opts.sourceName || getDefaultSourceName(scene);
  const frameRateN = frameRate * 1000;
  const frameRateD = 1000;

  log(
    `[ndi-feed/${scene}] starting "${sourceName}" @ ${frameRate}fps` +
      ` (${frameRateN}/${frameRateD})`,
  );

  let senderResult;
  try {
    senderResult = await ndiSender.createNdiSender({ name: sourceName, frameRate });
  } catch (err) {
    return { ok: false, error: `createNdiSender threw: ${String(err?.message || err)}` };
  }
  if (!senderResult.ok) {
    return { ok: false, error: senderResult.error };
  }

  /** @type {FeedRecord} */
  const record = {
    scene,
    sourceName,
    frameRate,
    source: null,
    sender: senderResult.sender,
    startedAt: Date.now(),
    framesSent: 0,
    framesSkipped: 0,
    sendFailures: 0,
    lastSendError: null,
    /** v0.9.34: audio counters. Populated by `pushAudioForScene` as the
     *  AudioWorklet PCM tap forwards frames via IPC. Useful both for
     *  diagnostics ("did the receiver get any audio frames yet?") and
     *  for the future `NDI:` status pill subtitle. */
    audioFramesSent: 0,
    audioSendFailures: 0,
    audioFramesDropped: 0,
    lastAudioSendError: null,
    audioFirstFrameAt: null,
  };

  /**
   * Frames to drop at the start of the stream before submitting any to
   * NDI. Two reasons:
   *
   *   1. The very first frames after `did-finish-load` come from a
   *      mid-hydration React tree — fonts haven't loaded, the scoreboard
   *      data hasn't fetched, the layout's first scale-to-fit pass hasn't
   *      run. Sending them as the receiver's first frames would make the
   *      operator-confidence preview in NDI Studio Monitor flash white /
   *      empty / wrong-sized for ~1 s before the real scoreboard appears.
   *
   *   2. Some NDI receivers latch onto the format of the very first
   *      frame they observe (xres × yres, fourCC, line stride) and
   *      silently drop subsequent frames whose format disagrees. If our
   *      first frame is partially-rendered at an unexpected size
   *      (capture happened before `image.resize()` had stable input),
   *      we'd permanently confuse the receiver until they re-subscribe.
   *      Better to skip a beat and start the receiver-visible stream
   *      with a fully-laid-out frame.
   *
   * 30 frames at 30 fps = 1 s of warmup, matching the smoke test's
   * `SMOKE_TEST_WARMUP_MS = 1500` ish (slightly tighter; we already
   * delay the capture loop until `did-finish-load` so most of the
   * smoke test's warmup work is done). We log the skip count once at
   * the end of warmup so the operator can confirm it from `updater.log`.
   */
  const NDI_FEED_WARMUP_FRAMES = 30;

  /**
   * Fire-and-forget per-frame send. We return the promise from
   * `sender.video(...)` to grandiose's internal queue and immediately
   * release control back to setInterval. If a send rejects (NDI runtime
   * disappeared, sender was destroyed mid-flight) we count it but keep
   * the loop alive — receivers tolerate dropped frames better than they
   * tolerate the source vanishing. Only persistent failures (>50 in a
   * row) would warrant tearing down the feed; we'll add that policy if
   * we ever observe it in practice.
   */
  /**
   * v0.9.31 diagnostic: capture the very first post-warmup frame as a
   * PNG to `<userData>/ndi-debug/<timestamp>/<scene>-frame-001.png` so
   * we have ground truth on what the offscreen renderer is producing
   * at the moment we hand it to NDI. v0.9.30's per-frame log showed
   * `firstBytes=00000000…` (top-left 4 px all zero) which is consistent
   * with both a) the operator's all-black-screen complaint and b) a
   * scoreboard whose top-left corner is just normal transparent
   * background — we can't tell which without seeing the whole frame.
   */
  let firstFramePngWritten = false;
  const writeFirstFramePng = (image) => {
    if (firstFramePngWritten) return;
    firstFramePngWritten = true;
    try {
      const fs = require("fs");
      const path = require("path");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      const debugDir = path.join(opts.userDataDir, "ndi-debug", stamp);
      fs.mkdirSync(debugDir, { recursive: true });
      const file = path.join(debugDir, `${scene}-frame-001.png`);
      fs.writeFileSync(file, image.toPNG());
      log(`[ndi-feed/${scene}] wrote first-frame PNG: ${file}`);
      const data = image.toBitmap();
      const sizes = image.getSize();
      const w = sizes.width;
      const h = sizes.height;
      const sampleCounts = (() => {
        const samplePoint = (px, py) => {
          if (px < 0 || py < 0 || px >= w || py >= h) return null;
          const off = (py * w + px) * 4;
          return [data[off], data[off + 1], data[off + 2], data[off + 3]];
        };
        return {
          topLeft: samplePoint(0, 0),
          topRight: samplePoint(w - 1, 0),
          bottomLeft: samplePoint(0, h - 1),
          bottomRight: samplePoint(w - 1, h - 1),
          center: samplePoint(Math.floor(w / 2), Math.floor(h / 2)),
          quarterX: samplePoint(Math.floor(w / 4), Math.floor(h / 2)),
          threeQuarterX: samplePoint(Math.floor((3 * w) / 4), Math.floor(h / 2)),
        };
      })();
      let nonZeroBytes = 0;
      let zeroAlphaCount = 0;
      const stride = 1024;
      for (let i = 0; i < data.length; i += stride) {
        if (data[i] !== 0) nonZeroBytes += 1;
        if (i + 3 < data.length && data[i + 3] === 0) zeroAlphaCount += 1;
      }
      log(
        `[ndi-feed/${scene}] frame analysis ${w}x${h}` +
          ` totalBytes=${data.length}` +
          ` sampledBytes=${Math.ceil(data.length / stride)}` +
          ` nonZeroSamples=${nonZeroBytes}` +
          ` zeroAlphaSamples=${zeroAlphaCount}` +
          ` topLeft=[${sampleCounts.topLeft?.join(",")}]` +
          ` topRight=[${sampleCounts.topRight?.join(",")}]` +
          ` center=[${sampleCounts.center?.join(",")}]` +
          ` quarterX=[${sampleCounts.quarterX?.join(",")}]` +
          ` threeQuarterX=[${sampleCounts.threeQuarterX?.join(",")}]` +
          ` bottomLeft=[${sampleCounts.bottomLeft?.join(",")}]` +
          ` bottomRight=[${sampleCounts.bottomRight?.join(",")}]`,
      );
    } catch (err) {
      log(
        `[ndi-feed/${scene}] first-frame PNG write failed: ${String(err?.message || err)}`,
      );
    }
  };

  let warmupAnnounced = false;
  const onFrame = (image) => {
    if (!record.sender) return;
    if (record.framesSkipped < NDI_FEED_WARMUP_FRAMES) {
      record.framesSkipped += 1;
      if (!warmupAnnounced && record.framesSkipped === NDI_FEED_WARMUP_FRAMES) {
        warmupAnnounced = true;
        log(
          `[ndi-feed/${scene}] warmup complete (skipped first ${NDI_FEED_WARMUP_FRAMES} frames);` +
            ` now broadcasting to receivers.`,
        );
      }
      return;
    }
    if (!firstFramePngWritten) {
      writeFirstFramePng(image);
    }
    const sendPromise = ndiSender.sendNdiVideoFrame(
      record.sender,
      image,
      frameRateN,
      frameRateD,
      log,
    );
    if (sendPromise && typeof sendPromise.then === "function") {
      sendPromise
        .then(() => {
          record.framesSent += 1;
        })
        .catch((err) => {
          record.sendFailures += 1;
          record.lastSendError = String(err?.message || err);
          if (record.sendFailures <= 3) {
            log(`[ndi-feed/${scene}] send failure (${record.sendFailures}): ${record.lastSendError}`);
          }
        });
    } else {
      record.framesSent += 1;
    }
  };

  let source = null;
  try {
    source = await createOffscreenSource({
      scene,
      appUrl: opts.appUrl,
      preloadPath: opts.preloadPath,
      frameRate,
      onFrame,
      onError: (err) => {
        log(`[ndi-feed/${scene}] source error: ${String(err?.message || err)}`);
      },
      onLog: log,
    });
  } catch (err) {
    try {
      ndiSender.destroyNdiSender(record.sender);
    } catch {
      /* ignore */
    }
    return { ok: false, error: `createOffscreenSource threw: ${String(err?.message || err)}` };
  }
  if (!source) {
    try {
      ndiSender.destroyNdiSender(record.sender);
    } catch {
      /* ignore */
    }
    return { ok: false, error: "Offscreen source returned null (was destroyed during init)" };
  }

  record.source = source;
  activeFeeds.set(scene, record);
  log(`[ndi-feed/${scene}] running. Receivers should now see "${sourceName}".`);
  return { ok: true, status: getStatus(scene) };
}

/**
 * Stop the feed for the given scene. Idempotent.
 */
function stopNdiFeed(scene, onLog) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const record = activeFeeds.get(scene);
  if (!record) return { ok: true, alreadyStopped: true };
  activeFeeds.delete(scene);
  try {
    record.source?.destroy?.();
  } catch (err) {
    log(`[ndi-feed/${scene}] source.destroy threw: ${String(err?.message || err)}`);
  }
  try {
    ndiSender.destroyNdiSender(record.sender);
  } catch (err) {
    log(`[ndi-feed/${scene}] destroyNdiSender threw: ${String(err?.message || err)}`);
  }
  record.sender = null;
  record.source = null;
  log(
    `[ndi-feed/${scene}] stopped.` +
      ` framesSent=${record.framesSent}` +
      ` framesSkipped=${record.framesSkipped || 0}` +
      ` sendFailures=${record.sendFailures}`,
  );
  return { ok: true };
}

/**
 * Hard-shutdown all active feeds. Used from `app.before-quit`. Synchronous
 * because Electron does not give us an awaitable hook there.
 */
function stopAllNdiFeeds(onLog) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const scenes = Array.from(activeFeeds.keys());
  if (!scenes.length) return;
  log(`[ndi-feed] stopping ${scenes.length} active feed(s) on app shutdown`);
  for (const scene of scenes) {
    stopNdiFeed(scene, log);
  }
}

function isFeedRunning(scene) {
  return activeFeeds.has(scene);
}

/**
 * v0.9.34: forward one captured PCM frame to the active sender for
 * `scene`. Called from the `ndi-audio:push` IPC handler with the
 * payload posted by the offscreen renderer's AudioWorklet PCM tap.
 *
 * Drop policy:
 *   - No active feed → drop silently (audio path beats video path on
 *     mount; we expect a few orphan frames before video is up).
 *   - Send rejected → count failure, keep going. NDI receivers tolerate
 *     gaps; failing one frame should never tear down the feed.
 *
 * @param {"scoreboard"|"bracket"} scene
 * @param {{ sampleRate:number, numChannels:number, numSamples:number,
 *           planar: ArrayBuffer | Buffer | Uint8Array }} payload
 * @param {(line: string) => void} [onLog]
 */
function pushAudioForScene(scene, payload, onLog) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const record = activeFeeds.get(scene);
  if (!record || !record.sender) {
    /** Track drops separately so the diagnostic distinguishes "audio
     *  was running before the video started" (recoverable) from
     *  "send is failing repeatedly" (real fault). */
    return { ok: false, dropped: true, reason: "feed-not-running" };
  }
  let promise;
  try {
    promise = ndiSender.sendNdiAudioFrame(record.sender, payload, log);
  } catch (err) {
    record.audioSendFailures += 1;
    record.lastAudioSendError = String(err?.message || err);
    if (record.audioSendFailures <= 3) {
      log(
        `[ndi-feed/${scene}] audio sync send threw (${record.audioSendFailures}): ${record.lastAudioSendError}`,
      );
    }
    return { ok: false, error: record.lastAudioSendError };
  }
  if (promise && typeof promise.then === "function") {
    promise
      .then(() => {
        record.audioFramesSent += 1;
        if (record.audioFirstFrameAt === null) {
          record.audioFirstFrameAt = Date.now();
          log(
            `[ndi-feed/${scene}] first audio frame accepted by NDI` +
              ` (sampleRate=${payload.sampleRate}, numChannels=${payload.numChannels}, numSamples=${payload.numSamples})`,
          );
        }
      })
      .catch((err) => {
        record.audioSendFailures += 1;
        record.lastAudioSendError = String(err?.message || err);
        if (record.audioSendFailures <= 3) {
          log(
            `[ndi-feed/${scene}] audio send failure (${record.audioSendFailures}): ${record.lastAudioSendError}`,
          );
        }
      });
  } else {
    record.audioFramesSent += 1;
  }
  return { ok: true };
}

function getStatus(scene) {
  const record = activeFeeds.get(scene);
  if (!record) {
    return { running: false, scene };
  }
  return {
    running: true,
    scene: record.scene,
    sourceName: record.sourceName,
    frameRate: record.frameRate,
    startedAt: record.startedAt,
    framesSent: record.framesSent,
    framesSkipped: record.framesSkipped,
    sendFailures: record.sendFailures,
    lastSendError: record.lastSendError,
    sourceCounters: record.source?.counters || null,
    audioFramesSent: record.audioFramesSent,
    audioSendFailures: record.audioSendFailures,
    audioFirstFrameAt: record.audioFirstFrameAt,
    lastAudioSendError: record.lastAudioSendError,
  };
}

function getAllStatuses() {
  return {
    available: ndiSender.isAvailable(),
    ndi: ndiSender.getStatus(),
    feeds: Array.from(activeFeeds.keys()).map((scene) => getStatus(scene)),
  };
}

module.exports = {
  startNdiFeed,
  stopNdiFeed,
  stopAllNdiFeeds,
  isFeedRunning,
  pushAudioForScene,
  getStatus,
  getAllStatuses,
  getDefaultSourceName,
  NDI_FRAME_RATE_DEFAULT,
};
