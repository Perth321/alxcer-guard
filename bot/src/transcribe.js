import { Buffer } from "node:buffer";

const API_KEY = process.env.DEEPGRAM_API_KEY || "";
const MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "th";
const ENDPOINT = "https://api.deepgram.com/v1/listen";

let lastImportError = API_KEY ? null : "DEEPGRAM_API_KEY env var not set";
let modelReadyAt = API_KEY ? Date.now() : 0;
let totalProcessed = 0;
let totalEmpty = 0;
let totalErrors = 0;
let lastTextAt = 0;
let lastError = "";

export async function isAvailable() {
  return !!API_KEY;
}

export function importError() {
  return lastImportError;
}

export async function prepareModel() {
  if (!API_KEY) {
    console.warn("[transcribe] DEEPGRAM_API_KEY not set — voice STT disabled");
    return false;
  }
  console.log(
    `[transcribe] ✓ READY — Deepgram model="${MODEL}" lang="${LANGUAGE}" (cloud, no warmup)`,
  );
  return true;
}

const queue = [];
let active = 0;
const MAX_CONCURRENT = 4;
const MAX_QUEUE = 32;

export function enqueueTranscription(pcmBuffer, callback, meta = {}) {
  if (!API_KEY) return false;
  if (queue.length >= MAX_QUEUE) {
    console.warn(
      `[transcribe] queue FULL (${queue.length}/${MAX_QUEUE}) — dropping ${meta.userId || ""}`,
    );
    return false;
  }
  queue.push({ pcm: pcmBuffer, callback, meta, queuedAt: Date.now() });
  pump();
  return true;
}

export function getStatus() {
  return {
    engine: "deepgram",
    model: MODEL,
    language: LANGUAGE,
    modelReady: !!API_KEY,
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
    const trimmed = (text || "").trim();
    if (trimmed) {
      lastTextAt = Date.now();
      console.log(
        `[transcribe] OK user=${job.meta.userId} took=${elapsed}ms text="${trimmed.slice(0, 80)}"`,
      );
    } else {
      totalEmpty++;
      console.log(
        `[transcribe] EMPTY user=${job.meta.userId} took=${elapsed}ms (silence or non-speech)`,
      );
    }
    try {
      job.callback?.(trimmed, job.meta);
    } catch (cbErr) {
      console.error("[transcribe] callback error", cbErr?.message);
    }
  } catch (err) {
    totalErrors++;
    lastError = err?.message || String(err);
    console.error(
      `[transcribe] job error user=${job.meta.userId}: ${lastError}`,
    );
  } finally {
    active--;
    setImmediate(pump);
  }
}

function downmixAndResample(pcm) {
  // Discord gives 48kHz stereo s16le; Deepgram does best with 16kHz mono s16le.
  const inSamples = pcm.length / 4;
  const ratio = 48000 / 16000;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.floor(i * ratio);
    const offset = srcIdx * 4;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + 2);
    const mono = Math.max(
      -32768,
      Math.min(32767, Math.round((left + right) / 2)),
    );
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

// Deepgram (with smart_format) tends to insert spaces between Thai syllables,
// e.g. "การ์ด" → "การ ์ ด". Native Thai text has no inter-word spaces, so we
// collapse any whitespace that sits between two Thai-script chars. This keeps
// the wake-word regex (and any other text matching) working naturally.
const THAI_RANGE = "\\u0E00-\\u0E7F";
const THAI_SPACING_RE = new RegExp(
  `([${THAI_RANGE}])\\s+(?=[${THAI_RANGE}])`,
  "g",
);
function normalizeThaiSpacing(s) {
  if (!s) return s;
  let prev;
  let cur = s;
  // Multiple passes because each replacement may expose a new adjacency.
  do {
    prev = cur;
    cur = cur.replace(THAI_SPACING_RE, "$1");
  } while (cur !== prev);
  return cur;
}

async function transcribePcm(pcm) {
  if (!API_KEY) return "";
  const monoPcm = downmixAndResample(pcm);
  const wav = pcmToWav(monoPcm);
  // smart_format & punctuate are tuned for English — for Thai they insert
  // syllable-level spaces that break downstream text matching, so we skip them.
  const url =
    `${ENDPOINT}?model=${encodeURIComponent(MODEL)}` +
    `&language=${encodeURIComponent(LANGUAGE)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${API_KEY}`,
        "Content-Type": "audio/wav",
      },
      body: wav,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Deepgram HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const transcript =
    json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return normalizeThaiSpacing(transcript.trim());
}
