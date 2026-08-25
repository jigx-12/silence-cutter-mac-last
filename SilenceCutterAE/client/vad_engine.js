// vad_engine.js — runs in the CEP panel's Node context (--enable-nodejs).
// Same math as the validated Python vad_engine.py: 512-sample windows at
// 16kHz, with the 64-sample rolling context prepend that Silero's v5 ONNX
// export requires (see README for how this was found/verified).

// --- SharedArrayBuffer workaround ---
// CEP's "mixed context" mode shares its V8 isolate with the Chromium
// renderer. Chromium hides the real SharedArrayBuffer constructor unless
// the page is cross-origin isolated (COOP/COEP headers) — impossible for a
// local file:// panel. onnxruntime-node's bundled JS (shared with the web
// backend) references `new SharedArrayBuffer(...)` unconditionally in some
// code paths and crashes with "SharedArrayBuffer is not a constructor" as a
// result, even though the actual native Node binding never needs real
// shared memory here. Probe it and swap in a plain ArrayBuffer if broken —
// patched on every global reference this context might expose (global,
// globalThis, and window if present), since mixed-context CEP can expose
// more than one name for what's nominally "the same" global object.
function patchSharedArrayBuffer() {
  let works = true;
  try {
    // eslint-disable-next-line no-new
    new SharedArrayBuffer(1);
  } catch (e) {
    works = false;
  }
  if (works) return;

  const targets = [global];
  if (typeof globalThis !== "undefined" && globalThis !== global) targets.push(globalThis);
  if (typeof window !== "undefined") targets.push(window);

  for (const t of targets) {
    try {
      Object.defineProperty(t, "SharedArrayBuffer", {
        value: ArrayBuffer,
        writable: true,
        configurable: true,
      });
    } catch (e) {
      try {
        t.SharedArrayBuffer = ArrayBuffer;
      } catch (e2) {
        /* ignore — best effort */
      }
    }
  }
}
patchSharedArrayBuffer();

let ort;
try {
  ort = require("onnxruntime-node");
} catch (e) {
  if (/SharedArrayBuffer/i.test(e.message || "")) {
    // The crash happened inside onnxruntime-node's own module evaluation —
    // Node drops failed modules from its require cache automatically, so a
    // clean re-require after patching again should get a fresh evaluation.
    patchSharedArrayBuffer();
    try {
      const resolved = require.resolve("onnxruntime-node");
      delete require.cache[resolved];
    } catch (e2) {
      /* ignore */
    }
    try {
      ort = require("onnxruntime-node");
    } catch (e3) {
      e3.message = e3.message + "\n[after SharedArrayBuffer patch + retry]\n" + (e3.stack || "");
      throw e3;
    }
  } else {
    e.message = e.message + "\n" + (e.stack || "");
    throw e;
  }
}

const SAMPLE_RATE = 16000;
const WINDOW = 512;
const CONTEXT = 64;

class SileroVAD {
  constructor() {
    this.session = null;
    this._state = null;
    this._context = null;
  }

  async load(modelPath, numThreads) {
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: numThreads || 4,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    });
    this.reset();
  }

  reset() {
    this._state = new Float32Array(2 * 1 * 128); // zeros
    this._context = new Float32Array(CONTEXT); // zeros
  }

  async process(chunk) {
    // chunk: Float32Array of exactly WINDOW samples
    const input = new Float32Array(CONTEXT + WINDOW);
    input.set(this._context, 0);
    input.set(chunk, CONTEXT);

    const feeds = {
      input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
      state: new ort.Tensor("float32", this._state, [2, 1, 128]),
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    };
    const results = await this.session.run(feeds);
    const out = results.output.data[0];
    this._state = results.stateN.data; // Float32Array
    this._context = input.slice(input.length - CONTEXT);
    return out;
  }
}

// Pure function of the probability trace — identical algorithm to
// vad_engine.py's get_speech_timestamps, validated bit-for-bit against it.
function segmentsFromProbs(probs, opts) {
  opts = opts || {};
  const threshold = opts.threshold !== undefined ? opts.threshold : 0.5;
  const minSpeechDurationMs = opts.minSpeechDurationMs !== undefined ? opts.minSpeechDurationMs : 250;
  const minSilenceDurationMs = opts.minSilenceDurationMs !== undefined ? opts.minSilenceDurationMs : 300;
  const speechPadMs = opts.speechPadMs !== undefined ? opts.speechPadMs : 150;
  const samplingRate = opts.samplingRate || SAMPLE_RATE;

  const minSpeechSamples = (samplingRate * minSpeechDurationMs) / 1000;
  const minSilenceSamples = (samplingRate * minSilenceDurationMs) / 1000;
  const speechPadSamples = (samplingRate * speechPadMs) / 1000;
  const negThreshold = Math.max(threshold - 0.15, 0.01);

  let triggered = false;
  let segStart = 0;
  let silenceRunStart = null;
  const raw = [];

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const samplePos = i * WINDOW;
    if (!triggered) {
      if (p >= threshold) {
        triggered = true;
        segStart = samplePos;
        silenceRunStart = null;
      }
    } else {
      if (p < negThreshold) {
        if (silenceRunStart === null) silenceRunStart = samplePos;
        if (samplePos - silenceRunStart >= minSilenceSamples) {
          raw.push([segStart, silenceRunStart]);
          triggered = false;
          silenceRunStart = null;
        }
      } else {
        silenceRunStart = null;
      }
    }
  }
  const totalSamples = probs.length * WINDOW;
  if (triggered) raw.push([segStart, totalSamples]);

  const padded = [];
  for (const [s0, e0] of raw) {
    if (e0 - s0 < minSpeechSamples) continue;
    const s = Math.max(0, s0 - speechPadSamples);
    const e = Math.min(totalSamples, e0 + speechPadSamples);
    padded.push([s, e]);
  }

  const merged = [];
  for (const [s, e] of padded) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  return merged.map(([s, e]) => ({
    start: Math.round((s / samplingRate) * 1000) / 1000,
    end: Math.round((e / samplingRate) * 1000) / 1000,
  }));
}

async function getSpeechTimestamps(audioFloat32, vad, opts) {
  vad.reset();
  const n = audioFloat32.length;
  const padLen = (WINDOW - (n % WINDOW)) % WINDOW;
  let audio = audioFloat32;
  if (padLen) {
    audio = new Float32Array(n + padLen);
    audio.set(audioFloat32, 0);
  }
  const probs = [];
  for (let i = 0; i < audio.length; i += WINDOW) {
    const chunk = audio.subarray(i, i + WINDOW);
    const p = await vad.process(chunk);
    probs.push(p);
  }
  return segmentsFromProbs(probs, opts);
}

module.exports = { SileroVAD, segmentsFromProbs, getSpeechTimestamps, SAMPLE_RATE, WINDOW };
