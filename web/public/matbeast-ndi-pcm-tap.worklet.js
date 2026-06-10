/**
 * matbeast-ndi-pcm-tap.worklet.js — AudioWorklet processor that
 * passively taps the audio graph and posts NDI-sized planar Float32
 * frames back to the main thread via MessagePort.
 *
 * Why an AudioWorklet:
 *   - Runs on the audio rendering thread (real-time, no jitter from
 *     main-thread GC pauses) — the only correct place to capture PCM
 *     in modern Web Audio.
 *   - Sits in the audio graph, so it sees full-amplitude PCM regardless
 *     of any downstream mute/sink-id state. This means the operator
 *     can have MONITOR=off (silent local sink) and the NDI receiver
 *     still hears the music at full volume — the tap is upstream of
 *     the muted output.
 *   - The processor is also a pass-through: whatever comes in on
 *     `inputs[0]` is copied to `outputs[0]` unchanged, so connecting
 *     the tap inline (`source -> tap -> gain -> destination`) doesn't
 *     break the operator's MONITOR-on path.
 *
 * Frame batching:
 *   AudioWorklet processors are called in 128-sample blocks. NDI
 *   prefers moderately sized frames — we accumulate 256 samples per
 *   channel (~5.3 ms at 48 kHz) before posting to balance IPC overhead
 *   and latency. A `flush` message posts any partial tail when a cue
 *   ends so short one-shots are not clipped.
 *
 * Memory ownership:
 *   Each post allocates a fresh planar `Float32Array` and transfers
 *   its underlying buffer to the main thread (`postMessage(msg, [
 *   buffer])`). After transfer, the worklet thread cannot reuse that
 *   memory — which is exactly what we want, because preserving the
 *   buffer in the worklet would risk the main thread reading stale
 *   samples on a future block. New buffer per frame avoids any race.
 *
 * Channel handling:
 *   We honor whatever channel count the upstream graph gives us
 *   (mono = 1, stereo = 2, surround = N). NDI accepts any
 *   `no_channels` value with planar Float32 (`FLTP`). Mono music
 *   files end up as a single-channel NDI track and most receivers
 *   (Studio Monitor, OBS NDI, vMix) up-mix to stereo automatically.
 */

const BUFFER_SIZE = 256;

class MatBeastNdiPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[] | null} channel-major accumulator */
    this.channelBuffers = null;
    this.numChannels = 0;
    this.bufferOffset = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.flushPartial();
      }
    };
  }

  flushPartial() {
    if (!this.channelBuffers || this.bufferOffset <= 0) return;
    const numChannels = this.numChannels;
    const n = this.bufferOffset;
    const planar = new Float32Array(numChannels * n);
    for (let ch = 0; ch < numChannels; ch++) {
      planar.set(this.channelBuffers[ch].subarray(0, n), ch * n);
    }
    this.port.postMessage(
      {
        sampleRate,
        numChannels,
        numSamples: n,
        planar: planar.buffer,
      },
      [planar.buffer],
    );
    this.bufferOffset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const numChannels = input.length;
    const blockSize = input[0]?.length ?? 0;

    if (output && output.length > 0) {
      const passChannels = Math.min(numChannels, output.length);
      for (let ch = 0; ch < passChannels; ch++) {
        if (input[ch] && output[ch] && input[ch].length === output[ch].length) {
          output[ch].set(input[ch]);
        }
      }
    }

    if (blockSize === 0) {
      return true;
    }

    if (!this.channelBuffers || this.numChannels !== numChannels) {
      this.numChannels = numChannels;
      this.channelBuffers = new Array(numChannels);
      for (let ch = 0; ch < numChannels; ch++) {
        this.channelBuffers[ch] = new Float32Array(BUFFER_SIZE);
      }
      this.bufferOffset = 0;
    }

    let inputOffset = 0;
    while (inputOffset < blockSize) {
      const remainingInput = blockSize - inputOffset;
      const remainingBuffer = BUFFER_SIZE - this.bufferOffset;
      const copyCount = Math.min(remainingInput, remainingBuffer);
      for (let ch = 0; ch < numChannels; ch++) {
        const src = input[ch];
        const dst = this.channelBuffers[ch];
        for (let i = 0; i < copyCount; i++) {
          dst[this.bufferOffset + i] = src[inputOffset + i];
        }
      }
      this.bufferOffset += copyCount;
      inputOffset += copyCount;
      if (this.bufferOffset >= BUFFER_SIZE) {
        const planar = new Float32Array(numChannels * BUFFER_SIZE);
        for (let ch = 0; ch < numChannels; ch++) {
          planar.set(this.channelBuffers[ch], ch * BUFFER_SIZE);
        }
        this.port.postMessage(
          {
            sampleRate,
            numChannels,
            numSamples: BUFFER_SIZE,
            planar: planar.buffer,
          },
          [planar.buffer],
        );
        this.bufferOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor("matbeast-ndi-pcm-tap", MatBeastNdiPcmTap);
