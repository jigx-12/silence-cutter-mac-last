// main.js — panel logic. Runs with Node integration enabled (mixed-context).
//
// IMPORTANT: nothing here should ever fail silently. Every risky step (Node
// module loading, ffmpeg calls, evalScript into AE) is wrapped so failures
// show up in the on-screen log. If the panel ever looks "dead" on click,
// open Advanced -> Run Diagnostics first.

const logEl = document.getElementById("log");

function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// Catch anything that would otherwise die silently.
window.onerror = function (msg, url, lineNo, colNo, err) {
  log("Unexpected error: " + msg + " (line " + lineNo + ")", "err");
  return false;
};
window.addEventListener("unhandledrejection", function (ev) {
  log("Unexpected error: " + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason)), "err");
});

log("Panel loaded.", "dim");

// --- License gate DOM refs ---
const licenseGateEl = document.getElementById("licenseGate");
const mainUIEl = document.getElementById("mainUI");
const licenseKeyInputEl = document.getElementById("licenseKeyInput");
const activateBtn = document.getElementById("activateBtn");
const licenseErrorEl = document.getElementById("licenseError");

function showLicenseGate(message) {
  licenseGateEl.classList.add("visible");
  mainUIEl.classList.add("hidden");
  if (message) licenseErrorEl.textContent = message;
}
function showMainUI() {
  licenseGateEl.classList.remove("visible");
  mainUIEl.classList.remove("hidden");
}

function reasonToMessage(reason) {
  const map = {
    max_activations: "This key has reached its device limit. Deactivate another device or contact support.",
    empty_key: "Enter a license key.",
    refunded_or_disputed: "This purchase was refunded or disputed, so the key is no longer valid.",
  };
  if (reason && map[reason]) return map[reason];
  if (reason && reason.indexOf("offline_and_no_grace") === 0) {
    return "Couldn't reach the license server and the offline grace period has expired. Connect to the internet and try again.";
  }
  return reason || "License check failed.";
}

async function runLicenseCheck() {
  if (typeof require === "undefined") {
    // No Node integration at all — let the rest of the app's own diagnostics
    // explain that; don't block on licensing when nothing will work anyway.
    showMainUI();
    return;
  }
  let licenseModule;
  try {
    const path = require("path");
    initCSInterfaceForLicense();
    licenseModule = require(path.join(EXT_ROOT_FOR_LICENSE, "client", "license.js"));
  } catch (e) {
    log("License module failed to load: " + e.message, "err");
    showMainUI(); // fail open rather than bricking the panel over a license-loading bug
    return;
  }

  try {
    const result = await licenseModule.checkLicense();
    if (result.status === "valid") {
      showMainUI();
    } else if (result.status === "offline_grace") {
      showMainUI();
      log("Offline — running on grace period. Reconnect soon to re-verify your license.", "dim");
    } else {
      showLicenseGate(result.status === "unlicensed" ? "" : reasonToMessage(result.reason));
    }
  } catch (e) {
    log("License check error: " + e.message, "err");
    showLicenseGate("Couldn't verify your license: " + e.message);
  }
}

let csInterfaceForLicense = null;
let EXT_ROOT_FOR_LICENSE = null;
function initCSInterfaceForLicense() {
  if (csInterfaceForLicense) return csInterfaceForLicense;
  csInterfaceForLicense = new CSInterface();
  EXT_ROOT_FOR_LICENSE = decodeURI(csInterfaceForLicense.getSystemPath(SystemPath.EXTENSION));
  return csInterfaceForLicense;
}

activateBtn.addEventListener("click", async () => {
  activateBtn.disabled = true;
  licenseErrorEl.textContent = "";
  try {
    const path = require("path");
    initCSInterfaceForLicense();
    const licenseModule = require(path.join(EXT_ROOT_FOR_LICENSE, "client", "license.js"));
    const result = await licenseModule.activate(licenseKeyInputEl.value);
    if (result.status === "valid") {
      showMainUI();
    } else {
      licenseErrorEl.textContent = reasonToMessage(result.reason);
    }
  } catch (e) {
    licenseErrorEl.textContent = "Activation failed: " + e.message;
  } finally {
    activateBtn.disabled = false;
  }
});

runLicenseCheck();

// --- DOM refs (always safe, no Node needed) ---
const analyzeBtn = document.getElementById("analyzeBtn");
const applyBtn = document.getElementById("applyBtn");
const diagBtn = document.getElementById("diagBtn");
const thresholdEl = document.getElementById("threshold");
const thresholdRangeEl = document.getElementById("thresholdRange");
const minSilenceEl = document.getElementById("minSilence");
const paddingEl = document.getElementById("padding");
const minSpeechEl = document.getElementById("minSpeech");
const ffmpegPathEl = document.getElementById("ffmpegPath");
const combineToggleEl = document.getElementById("combineToggle");

thresholdEl.addEventListener("input", () => (thresholdRangeEl.value = thresholdEl.value));
thresholdRangeEl.addEventListener("input", () => (thresholdEl.value = thresholdRangeEl.value));

try {
  const savedFfmpeg = localStorage.getItem("silenceCutter.ffmpegPath");
  if (savedFfmpeg) {
    ffmpegPathEl.value = savedFfmpeg;
  } else if (typeof require !== "undefined") {
    // Look for a bundled ffmpeg next to the extension (installers can ship
    // one at client/ffmpeg/) before falling back to relying on system PATH.
    try {
      const path = require("path");
      const fs = require("fs");
      const cs = new CSInterface();
      const extRoot = decodeURI(cs.getSystemPath(SystemPath.EXTENSION));
      const bundled =
        process.platform === "win32"
          ? path.join(extRoot, "client", "ffmpeg", "ffmpeg.exe")
          : path.join(extRoot, "client", "ffmpeg", "ffmpeg");
      if (fs.existsSync(bundled)) {
        ffmpegPathEl.value = bundled;
      }
    } catch (e) {
      /* fall back to plain "ffmpeg" on PATH */
    }
  }
  ffmpegPathEl.addEventListener("change", () => {
    localStorage.setItem("silenceCutter.ffmpegPath", ffmpegPathEl.value);
  });
} catch (e) {
  log("localStorage unavailable (non-fatal): " + e.message, "dim");
}

// --- Node / CSInterface setup, done lazily + defensively ---
let csInterface = null;
let nodeReqs = null; // { path, os, fs, execFile, wav, vadModule }
let EXT_ROOT = null;
let MODEL_PATH = null;

function initCSInterface() {
  if (csInterface) return csInterface;
  csInterface = new CSInterface();
  EXT_ROOT = decodeURI(csInterface.getSystemPath(SystemPath.EXTENSION));
  return csInterface;
}

function initNode() {
  if (nodeReqs) return nodeReqs;
  if (typeof require === "undefined") {
    throw new Error(
      'Node.js is not available in this panel ("require" is undefined). ' +
      'This means CEP Node integration didn\'t activate. Check that ' +
      'CSXS/manifest.xml has --enable-nodejs and --mixed-context under ' +
      'CEFCommandLine, then fully restart After Effects.'
    );
  }
  const path = require("path");
  const os = require("os");
  const fs = require("fs");
  const { execFile } = require("child_process");

  // main.js is loaded via a <script> tag, not require()'d, so it has no
  // real module context — bare specifiers like require("node-wav") silently
  // fail to walk up to node_modules even though the files are right there.
  // Core built-ins (path/os/fs/child_process) are special-cased and still
  // resolve fine; everything else needs an explicit absolute path.
  initCSInterface();
  const clientDir = path.join(EXT_ROOT, "client");

  let wav, vadModule;
  try {
    wav = require(path.join(clientDir, "node_modules", "node-wav"));
  } catch (e) {
    throw new Error(
      '"node-wav" failed to load (' + e.message + '). Run "npm install" ' +
      "inside the extension's client/ folder, then restart After Effects."
    );
  }
  try {
    vadModule = require(path.join(clientDir, "vad_engine.js"));
  } catch (e) {
    throw new Error(
      '"onnxruntime-node" failed to load (' + e.message + '). This usually ' +
      "means npm install didn't fully complete (no internet during install, " +
      "or antivirus blocked the native binary). Run \"npm install\" inside " +
      "the extension's client/ folder, then restart After Effects."
    );
  }
  MODEL_PATH = path.join(clientDir, "model", "silero_vad.onnx");
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error("Model file missing at: " + MODEL_PATH);
  }
  nodeReqs = { path, os, fs, execFile, wav, vadModule };
  return nodeReqs;
}

function evalScript(script) {
  initCSInterface();
  return new Promise((resolve) => csInterface.evalScript(script, resolve));
}

function runFFmpeg(args) {
  const { execFile } = initNode();
  return new Promise((resolve, reject) => {
    execFile(ffmpegPathEl.value || "ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "ffmpeg failed").toString()));
      else resolve(stdout);
    });
  });
}

async function extractAudio16kMono(inputPath) {
  const { path, os } = initNode();
  const { SAMPLE_RATE } = initNode().vadModule;
  const tmpWav = path.join(os.tmpdir(), `silence_cutter_${Date.now()}.wav`);
  await runFFmpeg([
    "-y", "-i", inputPath,
    "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16",
    tmpWav,
  ]);
  return tmpWav;
}

function getOpts() {
  const { SAMPLE_RATE } = initNode().vadModule;
  return {
    threshold: parseFloat(thresholdEl.value),
    minSpeechDurationMs: parseInt(minSpeechEl.value, 10),
    minSilenceDurationMs: parseInt(minSilenceEl.value, 10),
    speechPadMs: parseInt(paddingEl.value, 10),
    samplingRate: SAMPLE_RATE,
  };
}

// --- Diagnostics: run every risky step individually and report pass/fail ---
async function runDiagnostics() {
  log("--- Diagnostics ---", "dim");
  try {
    initCSInterface();
    log("CSInterface: OK (extension root " + EXT_ROOT + ")", "ok");
  } catch (e) {
    log("CSInterface: FAILED — " + e.message, "err");
    return;
  }

  if (typeof require === "undefined") {
    log('Node.js integration: FAILED — "require" is undefined.', "err");
    log("Fix: confirm manifest.xml has --enable-nodejs and --mixed-context, then fully restart After Effects (not just reload the panel).", "dim");
    return;
  }
  log("Node.js integration: OK", "ok");

  try {
    const path = require("path");
    initCSInterface();
    const nodeWavPath = path.join(EXT_ROOT, "client", "node_modules", "node-wav");
    require(nodeWavPath);
    log("node-wav module: OK", "ok");
  } catch (e) {
    log("node-wav module: FAILED — " + e.message, "err");
    log('Fix: run "npm install" inside client/, then restart After Effects.', "dim");
  }

  try {
    const path = require("path");
    initCSInterface();
    const vadEnginePath = path.join(EXT_ROOT, "client", "vad_engine.js");
    require(vadEnginePath);
    log("onnxruntime-node module: OK", "ok");
    try {
      const fs = require("fs");
      const modelPath = path.join(EXT_ROOT, "client", "model", "silero_vad.onnx");
      if (fs.existsSync(modelPath)) {
        log("VAD model file: OK (" + modelPath + ")", "ok");
      } else {
        log("VAD model file: MISSING at " + modelPath, "err");
      }
    } catch (e) {
      log("Model path check: FAILED — " + e.message, "err");
    }
  } catch (e) {
    log("onnxruntime-node module: FAILED — " + e.message, "err");
    log('Fix: run "npm install" inside client/ with internet access, then restart After Effects.', "dim");
  }

  try {
    await runFFmpeg(["-version"]);
    log("ffmpeg: OK", "ok");
  } catch (e) {
    log("ffmpeg: FAILED — " + e.message, "err");
    log('Fix: install ffmpeg and ensure it\'s on PATH, or set its full path under Advanced.', "dim");
  }

  try {
    const infoRaw = await evalScript("getSelectedLayerInfo()");
    const info = JSON.parse(infoRaw);
    if (info.ok) {
      log("AE selection: OK (layer \"" + info.layerName + "\")", "ok");
    } else {
      log("AE selection: " + info.error, "dim");
    }
  } catch (e) {
    log("AE host script (evalScript): FAILED — " + e.message, "err");
  }

  log("--- Diagnostics done ---", "dim");
}

diagBtn.addEventListener("click", () => {
  diagBtn.disabled = true;
  runDiagnostics().finally(() => (diagBtn.disabled = false));
});

// --- Main flow ---
let currentLayerInfo = null;
let currentKeepSegments = null; // clipped, source-time seconds

analyzeBtn.addEventListener("click", async () => {
  applyBtn.disabled = true;
  currentKeepSegments = null;
  analyzeBtn.disabled = true;
  try {
    log("Reading selected layer from After Effects...");
    const infoRaw = await evalScript("getSelectedLayerInfo()");
    const info = JSON.parse(infoRaw);
    if (!info.ok) {
      log("Error: " + info.error, "err");
      return;
    }
    currentLayerInfo = info;
    log(`Layer: "${info.layerName}" in comp "${info.compName}"`);
    log(`Source file: ${info.filePath}`);

    log("Checking ffmpeg...");
    await runFFmpeg(["-version"]);

    log("Extracting audio (16kHz mono)...");
    const tmpWav = await extractAudio16kMono(info.filePath);

    log("Loading Silero VAD model (CPU)...");
    const { SileroVAD, getSpeechTimestamps } = initNode().vadModule;
    const { fs } = initNode();
    const vad = new SileroVAD();
    await vad.load(MODEL_PATH, 4);

    log("Decoding audio...");
    const wavMod = initNode().wav;
    const buf = fs.readFileSync(tmpWav);
    const decoded = wavMod.decode(buf);
    const audio = decoded.channelData[0];
    fs.unlink(tmpWav, () => {});

    log("Running VAD (this is fast, CPU-only)...");
    const t0 = Date.now();
    const segments = await getSpeechTimestamps(audio, vad, getOpts());
    log(`VAD done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

    const lo = info.visSourceStart;
    const hi = info.visSourceEnd;
    const clipped = segments
      .map((s) => ({ start: Math.max(s.start, lo), end: Math.min(s.end, hi) }))
      .filter((s) => s.end - s.start > 0.01);

    if (clipped.length === 0) {
      log("No speech detected within this layer's trimmed range.", "err");
      return;
    }

    const kept = clipped.reduce((a, s) => a + (s.end - s.start), 0);
    const total = hi - lo;
    const removed = total - kept;

    log(`Found ${clipped.length} speech segments.`, "stat");
    log(`Kept: ${kept.toFixed(2)}s   Removed: ${removed.toFixed(2)}s (${((removed / total) * 100).toFixed(1)}%)`, "stat");
    log('Click "Apply" to edit the timeline (this is undoable — Cmd/Ctrl+Z).');

    currentKeepSegments = clipped;
    applyBtn.disabled = false;
  } catch (e) {
    log("Error: " + (e && e.message ? e.message : String(e)), "err");
    log("Tip: open Advanced -> Run Diagnostics to narrow this down.", "dim");
  } finally {
    analyzeBtn.disabled = false;
  }
});

applyBtn.addEventListener("click", async () => {
  if (!currentKeepSegments || !currentLayerInfo) return;
  applyBtn.disabled = true;
  try {
    log("Applying to timeline...");
    const combine = !!combineToggleEl.checked;
    const resultRaw = await evalScript(
      `applySilenceRemoval(${JSON.stringify(JSON.stringify(currentKeepSegments))}, ${currentLayerInfo.layerIndex}, ${combine})`
    );
    const result = JSON.parse(resultRaw);
    if (!result.ok) {
      log("Error: " + result.error, "err");
      applyBtn.disabled = false;
      return;
    }
    log(`Done. ${result.segmentsApplied} segments placed, new duration ${result.newDuration.toFixed(2)}s.`, "ok");
    if (combine) {
      if (result.combined) {
        log(`Combined into one layer: "${result.combined}"`, "ok");
      } else if (result.combineWarning) {
        log(result.combineWarning, "err");
      }
    }
    log("(Undo with Cmd/Ctrl+Z if you want to revert.)", "dim");
    currentKeepSegments = null;
  } catch (e) {
    log("Error: " + (e && e.message ? e.message : String(e)), "err");
    applyBtn.disabled = false;
  }
});

const stackBtn = document.getElementById("stackBtn");
stackBtn.addEventListener("click", async () => {
  stackBtn.disabled = true;
  try {
    log("Stacking selected layers with no gap...");
    const resultRaw = await evalScript("stackSelectedLayers()");
    const result = JSON.parse(resultRaw);
    if (!result.ok) {
      log("Error: " + result.error, "err");
      return;
    }
    log(`Done. ${result.layersStacked} layers stacked, total span ${result.totalSpan.toFixed(2)}s.`, "ok");
    log("(Undo with Cmd/Ctrl+Z if you want to revert.)", "dim");
  } catch (e) {
    log("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    stackBtn.disabled = false;
  }
});
