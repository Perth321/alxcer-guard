import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MODEL_NAME = process.env.WHISPER_MODEL || "base";
const LANGUAGE = process.env.WHISPER_LANGUAGE || "th";

let nodewhisper = null;
let importChecked = false;
let modelReadyPromise = null;
let modelReadyAt = 0;
let lastImportError = null;
let totalProcessed = 0;
let totalEmpty = 0;
let totalErrors = 0;
let lastTextAt = 0;
let lastError = "";

async function tryImport() {
  if (importChecked) return nodewhisper;
  importChecked = true;
  try {
    const mod = await import("nodejs-whisper");
    nodewhisper = mod.nodewhisper || mod.default || null;
    if (!nodewhisper) throw new Error("nodewhisper export not found");
    console.log(`[transcribe] nodejs-whisper loaded — model="${MODEL_NAME}" lang="${LANGUAGE}"`);
  } catch (err) {
    lastImportError = err?.message || String(err);
    console.warn(`[transcribe] nodejs-whisper unavailable — voice STT disabled (${lastImportError})`);
    nodewhisper = null;
  }
  return nodewhisper;
}

export async function isAvailable() {
  return !!(await tryImport());
}

export function importError() {
  return lastImportError;
}

const queue = [];
let active = 0;
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 16;

export function enqueueTranscription(pcmBuffer, callback, meta = {}) {
  if (queue.length >= MAX_QUEUE) {
    console.warn(`[transcribe] queue FULL (${queue.length}/${MAX_QUEUE}) — dropping ${meta.userId || ""}`);
    return false;
  }
  queue.push({ pcm: pcmBuffer, callback, meta, queuedAt: Date.now() });
  pump();
  return true;
}

export function getStatus() {
  return {
    modelName: MODEL_NAME,
    language: LANGUAGE,
    modelReady: modelReadyAt > 0,
    modelReadyAt,
    queued: queue.length,
    active,
    maxConcurrent: MAX_CONCURRENT,
    maxQueue: MAX_QUEUE,
    totalProcessed,
    totalEmpty,
    totalErrors,
    lastTextAt,
    lastError,
    importError: lastImportError,
  };
}

export async function prepareModel() {
  const fn = await tryImport();
  if (!fn) {
    console.warn("[transcribe] cannot prepare model — import failed");
    return false;
  }
  if (modelReadyAt > 0) return true;
  console.log(
    `[transcribe] PRE-WARMING model "${MODEL_NAME}" (downloads if needed, ~30-90s for base, ~3min for small)...`,
  );
  const startedAt = Date.now();
  const silentPcm = Buffer.alloc(48000 * 2 * 2 * 1, 0);
  try {
    await transcribePcm(silentPcm);
    modelReadyAt = Date.now();
    console.log(
      `[transcribe] ✓ MODEL READY "${MODEL_NAME}" (warmup took ${((modelReadyAt - startedAt) / 1000).toFixed(1)}s)`,
    );
    return true;
  } catch (err) {
    lastError = err?.message || String(err);
    console.error(
      `[transcribe] ✗ model warmup FAILED: ${lastError}`,
    );
    return false;
  }
}

async function pump() {
  if (active >= MAX_CONCURRENT) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  const t0 = Date.now();
  const waitMs = t0 - job.queuedAt;
  console.log(
    `[transcribe] START user=${job.meta.userId} dur=${job.meta.durationSec?.toFixed(1)}s waited=${waitMs}ms (queue=${queue.length}, active=${active})`,
  );
  try {
    const text = await transcribePcm(job.pcm);
    const elapsed = Date.now() - t0;
    totalProcessed++;
    if (text && text.trim().length > 0) {
      lastTextAt = Date.now();
      console.log(
        `[transcribe] OK user=${job.meta.userId} took=${elapsed}ms text="${text.slice(0, 80)}"`,
      );
    } else {
      totalEmpty++;
      console.log(
        `[transcribe] EMPTY user=${job.meta.userId} took=${elapsed}ms (silence or non-speech)`,
      );
    }
    try {
      job.callback?.(text, job.meta);
    } catch (cbErr) {
      console.error("[transcribe] callback error", cbErr?.message);
    }
  } catch (err) {
    totalErrors++;
    lastError = err?.message || String(err);
    console.error("[transcribe] job error", lastError);
  } finally {
    active--;
    setImmediate(pump);
  }
}

function downmixAndResample(pcm) {
  const inSamples = pcm.length / 4;
  const ratio = 48000 / 16000;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.floor(i * ratio);
    const offset = srcIdx * 4;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + 2);
    const mono = Math.max(-32768, Math.min(32767, Math.round((left + right) / 2)));
    out.writeInt16LE(mono, i * 2);
  }
  return out;
}

function pcmToWav(pcm, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

let rawLogCount = 0;
const RAW_LOG_MAX = 5;

async function transcribePcm(pcm) {
  const fn = await tryImport();
  if (!fn) return null;

  const tmp = path.join(
    os.tmpdir(),
    `alxcer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );
  const monoPcm = downmixAndResample(pcm);
  try {
    fs.writeFileSync(tmp, pcmToWav(monoPcm));
  } catch (err) {
    console.error("[transcribe] write wav failed", err?.message);
    return null;
  }
  try {
    const result = await fn(tmp, {
      modelName: MODEL_NAME,
      autoDownloadModelName: MODEL_NAME,
      removeWavFileAfterTranscription: false,
      verbose: false,
      whisperOptions: {
        outputInText: true,
        outputInVtt: false,
        outputInSrt: false,
        outputInCsv: false,
        translateToEnglish: false,
        wordTimestamps: false,
        timestamps_length: 0,
        splitOnWord: false,
        language: LANGUAGE,
      },
    });
    let text = parseTranscript(result);
    if (!text) {
      const txtPath = `${tmp}.txt`;
      try {
        if (fs.existsSync(txtPath)) {
          const fileText = fs.readFileSync(txtPath, "utf8").trim();
          if (fileText) {
            text = parseTranscript(fileText);
            if (rawLogCount < RAW_LOG_MAX) {
              console.log(
                `[transcribe] recovered text from .txt file: "${fileText.slice(0, 100)}"`,
              );
            }
          }
        }
      } catch {}
    }
    if (rawLogCount < RAW_LOG_MAX) {
      rawLogCount++;
      const rawType = typeof result;
      const rawLen = result?.length ?? 0;
      const rawSnippet =
        rawType === "string"
          ? result.slice(0, 300).replace(/\n/g, "\\n")
          : JSON.stringify(result).slice(0, 300);
      console.log(
        `[transcribe] RAW#${rawLogCount} type=${rawType} len=${rawLen} snippet="${rawSnippet}" → parsed="${text.slice(0, 100)}"`,
      );
    }
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(`${tmp}.txt`); } catch {}
    return text;
  } catch (err) {
    console.error("[transcribe] whisper error", err?.message);
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(`${tmp}.txt`); } catch {}
    return null;
  }
}

function parseTranscript(raw) {
  if (!raw) return "";
  const stringified = typeof raw === "string" ? raw : String(raw);
  return stringified
    .split("\n")
    .map((line) =>
      line.replace(
        /^\[\s*\d+:\d+:\d+\.\d+\s*-->\s*\d+:\d+:\d+\.\d+\s*\]\s*/,
        "",
      ),
    )
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}
