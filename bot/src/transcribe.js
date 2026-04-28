import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MODEL_NAME = process.env.WHISPER_MODEL || "small";
const LANGUAGE = process.env.WHISPER_LANGUAGE || "th";

let nodewhisper = null;
let importChecked = false;
let modelReadyPromise = null;
let lastImportError = null;

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
const MAX_CONCURRENT = 1;
const MAX_QUEUE = 4;

export function enqueueTranscription(pcmBuffer, callback, meta = {}) {
  if (queue.length >= MAX_QUEUE) {
    console.warn(`[transcribe] queue full (${queue.length}/${MAX_QUEUE}) — dropping ${meta.userId || ""}`);
    return false;
  }
  queue.push({ pcm: pcmBuffer, callback, meta });
  pump();
  return true;
}

async function pump() {
  if (active >= MAX_CONCURRENT) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  try {
    const text = await transcribePcm(job.pcm);
    try {
      job.callback?.(text, job.meta);
    } catch (cbErr) {
      console.error("[transcribe] callback error", cbErr?.message);
    }
  } catch (err) {
    console.error("[transcribe] job error", err?.message);
  } finally {
    active--;
    setImmediate(pump);
  }
}

function pcmToWav(pcm, sampleRate = 48000, channels = 2, bitsPerSample = 16) {
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

async function transcribePcm(pcm) {
  const fn = await tryImport();
  if (!fn) return null;
  if (!modelReadyPromise) {
    modelReadyPromise = (async () => {
      console.log(`[transcribe] preparing model "${MODEL_NAME}" (first call may download ~466MB)`);
      return true;
    })();
  }
  await modelReadyPromise;

  const tmp = path.join(
    os.tmpdir(),
    `alxcer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );
  try {
    fs.writeFileSync(tmp, pcmToWav(pcm));
  } catch (err) {
    console.error("[transcribe] write wav failed", err?.message);
    return null;
  }
  try {
    const result = await fn(tmp, {
      modelName: MODEL_NAME,
      autoDownloadModelName: MODEL_NAME,
      removeWavFileAfterTranscription: true,
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
    const text = parseTranscript(result);
    return text;
  } catch (err) {
    console.error("[transcribe] whisper error", err?.message);
    try { fs.unlinkSync(tmp); } catch {}
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
