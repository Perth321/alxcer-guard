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
let totalCallbackErrors = 0;
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

// Keep a separate waiting queue for each guild and select from them round-robin.
// A busy guild therefore cannot monopolize every global transcription slot.
const guildQueues = new Map();
const guildOrder = [];
const activeByGuild = new Map();
const activeStreams = new Set();
let active = 0;
let queued = 0;
let nextGuildIndex = 0;
let pumpScheduled = false;
let nextJobId = 1;
const MAX_CONCURRENT = 4;
const MAX_CONCURRENT_PER_GUILD = 2;
const MAX_QUEUE = 32;
const MAX_QUEUE_PER_GUILD = 16;

const LEGACY_GUILD_KEY = "__legacy__";
const ANONYMOUS_USER_KEY = "__anonymous__";

function normalizeMeta(meta) {
  const safeMeta = meta && typeof meta === "object" ? { ...meta } : {};
  if (safeMeta.guildId != null && safeMeta.guildId !== "") {
    safeMeta.guildId = String(safeMeta.guildId);
  }
  if (safeMeta.userId != null && safeMeta.userId !== "") {
    safeMeta.userId = String(safeMeta.userId);
  }
  return safeMeta;
}

function guildKeyFor(meta) {
  return meta.guildId || LEGACY_GUILD_KEY;
}

function streamKeyFor(guildKey, meta) {
  return `${guildKey}:${meta.userId || ANONYMOUS_USER_KEY}`;
}

function enqueueGuildJob(job) {
  let guildQueue = guildQueues.get(job.guildKey);
  if (!guildQueue) {
    guildQueue = [];
    guildQueues.set(job.guildKey, guildQueue);
    guildOrder.push(job.guildKey);
  }
  guildQueue.push(job);
  queued++;
}

function removeGuildAt(index) {
  const [guildKey] = guildOrder.splice(index, 1);
  if (guildKey) guildQueues.delete(guildKey);
  if (index < nextGuildIndex) nextGuildIndex--;
  if (nextGuildIndex < 0 || nextGuildIndex >= guildOrder.length) {
    nextGuildIndex = 0;
  }
}

// Pick one runnable job while preserving FIFO for each guild+user stream. Jobs
// for other users in the same guild may pass a blocked stream, which keeps the
// queue useful without ever running two callbacks for one speaker concurrently.
function takeNextJob() {
  if (!guildOrder.length) return null;
  const guildCount = guildOrder.length;

  for (let checked = 0; checked < guildCount; checked++) {
    if (!guildOrder.length) return null;
    const index = (nextGuildIndex + checked) % guildOrder.length;
    const guildKey = guildOrder[index];
    if ((activeByGuild.get(guildKey) || 0) >= MAX_CONCURRENT_PER_GUILD) {
      continue;
    }

    const guildQueue = guildQueues.get(guildKey);
    if (!guildQueue?.length) {
      removeGuildAt(index);
      return takeNextJob();
    }

    const jobIndex = guildQueue.findIndex(
      (job) => !activeStreams.has(job.streamKey),
    );
    if (jobIndex === -1) continue;

    const [job] = guildQueue.splice(jobIndex, 1);
    queued--;
    if (guildQueue.length === 0) {
      removeGuildAt(index);
    } else {
      nextGuildIndex = (index + 1) % guildOrder.length;
    }
    return job;
  }
  return null;
}

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(() => {
    pumpScheduled = false;
    pump();
  });
}

export function enqueueTranscription(pcmBuffer, callback, meta = {}) {
  if (!API_KEY) return false;
  const safeMeta = normalizeMeta(meta);
  const guildKey = guildKeyFor(safeMeta);
  const guildQueued = guildQueues.get(guildKey)?.length || 0;
  if (queued >= MAX_QUEUE || guildQueued >= MAX_QUEUE_PER_GUILD) {
    console.warn(
      `[transcribe] queue FULL guild=${safeMeta.guildId || "legacy"} ` +
        `(guild=${guildQueued}/${MAX_QUEUE_PER_GUILD}, total=${queued}/${MAX_QUEUE}) ` +
        `— dropping ${safeMeta.userId || ""}`,
    );
    return false;
  }
  const job = {
    id: nextJobId++,
    pcm: pcmBuffer,
    callback,
    meta: safeMeta,
    guildKey,
    streamKey: streamKeyFor(guildKey, safeMeta),
    queuedAt: Date.now(),
  };
  enqueueGuildJob(job);
  schedulePump();
  return true;
}

export function getStatus() {
  return {
    engine: "deepgram",
    model: MODEL,
    language: LANGUAGE,
    modelReady: !!API_KEY,
    modelReadyAt,
    queued,
    active,
    maxConcurrent: MAX_CONCURRENT,
    maxConcurrentPerGuild: MAX_CONCURRENT_PER_GUILD,
    maxQueue: MAX_QUEUE,
    maxQueuePerGuild: MAX_QUEUE_PER_GUILD,
    queuedByGuild: Object.fromEntries(
      [...guildQueues.entries()].map(([guildKey, jobs]) => [guildKey, jobs.length]),
    ),
    activeByGuild: Object.fromEntries(activeByGuild),
    totalProcessed,
    totalEmpty,
    totalErrors,
    totalCallbackErrors,
    lastTextAt,
    lastError,
    importError: lastImportError,
  };
}

function pump() {
  while (active < MAX_CONCURRENT) {
    const job = takeNextJob();
    if (!job) return;
    startJob(job);
  }
}

function startJob(job) {
  active++;
  activeByGuild.set(job.guildKey, (activeByGuild.get(job.guildKey) || 0) + 1);
  activeStreams.add(job.streamKey);
  void runJob(job);
}

async function runJob(job) {
  const t0 = Date.now();
  const waitMs = t0 - job.queuedAt;
  console.log(
    `[transcribe] START guild=${job.meta.guildId || "legacy"} user=${job.meta.userId} ` +
      `dur=${job.meta.durationSec?.toFixed(1)}s waited=${waitMs}ms ` +
      `(queue=${queued}, active=${active})`,
  );
  try {
    const text = await transcribePcm(job.pcm);
    const elapsed = Date.now() - t0;
    totalProcessed++;
    const trimmed = (text || "").trim();
    if (trimmed) {
      lastTextAt = Date.now();
      console.log(
        `[transcribe] OK guild=${job.meta.guildId || "legacy"} user=${job.meta.userId} ` +
          `took=${elapsed}ms text="${trimmed.slice(0, 80)}"`,
      );
    } else {
      totalEmpty++;
      console.log(
        `[transcribe] EMPTY guild=${job.meta.guildId || "legacy"} user=${job.meta.userId} ` +
          `took=${elapsed}ms (silence or non-speech)`,
      );
    }
    try {
      await job.callback?.(trimmed, job.meta);
    } catch (cbErr) {
      totalCallbackErrors++;
      console.error(
        `[transcribe] callback error guild=${job.meta.guildId || "legacy"} ` +
          `user=${job.meta.userId}:`,
        cbErr?.message,
      );
    }
  } catch (err) {
    totalErrors++;
    lastError = err?.message || String(err);
    console.error(
      `[transcribe] job error guild=${job.meta.guildId || "legacy"} ` +
        `user=${job.meta.userId}: ${lastError}`,
    );
  } finally {
    active--;
    const guildActive = (activeByGuild.get(job.guildKey) || 1) - 1;
    if (guildActive > 0) activeByGuild.set(job.guildKey, guildActive);
    else activeByGuild.delete(job.guildKey);
    activeStreams.delete(job.streamKey);
    schedulePump();
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
