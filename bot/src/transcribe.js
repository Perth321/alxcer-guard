import { Buffer } from "node:buffer";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "th";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_STT_MODEL || "gemini-2.5-flash";
const DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 30_000;
const GEMINI_TRANSCRIPTION_PROMPT = [
  "Transcribe the provided WAV audio exactly as spoken.",
  "Return only the transcript in the original spoken language.",
  "Do not translate, explain, summarize, identify speakers, add timestamps, or use Markdown.",
  "If there is no intelligible speech, return an empty response.",
].join(" ");

const HAS_TRANSCRIBER = !!(DEEPGRAM_API_KEY || GEMINI_API_KEY);
let lastImportError = HAS_TRANSCRIBER
  ? null
  : "DEEPGRAM_API_KEY and GEMINI_API_KEY env vars are not set";
let modelReadyAt = HAS_TRANSCRIBER ? Date.now() : 0;
let totalProcessed = 0;
let totalEmpty = 0;
let totalErrors = 0;
let totalCallbackErrors = 0;
let lastTextAt = 0;
let lastError = "";
let lastProvider = "";

function providerError(provider, message, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.provider = provider;
  if (status !== undefined) error.status = status;
  return error;
}

async function withTimeout(provider, timeoutMs, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw providerError(provider, `${provider} transcription timed out`, 408, error);
    }
    if (!error?.provider) error.provider = provider;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, provider) {
  try {
    return await response.json();
  } catch (error) {
    throw providerError(
      provider,
      `${provider} returned invalid JSON`,
      response.status,
      error,
    );
  }
}

function geminiTranscript(body) {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : [];
    const text = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

// Deepgram is the low-latency primary. Gemini is deliberately an independent
// fallback so exhausted Deepgram credit cannot silently disable the wake word.
// The injected fetch makes the provider chain testable without network calls.
export function createVoiceTranscriber({
  deepgramApiKey = DEEPGRAM_API_KEY,
  deepgramModel = MODEL,
  language = LANGUAGE,
  geminiApiKey = GEMINI_API_KEY,
  geminiModel = GEMINI_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function transcribeDeepgram(wavBuffer) {
    return withTimeout("deepgram", timeoutMs, async (signal) => {
      const url =
        `${DEEPGRAM_ENDPOINT}?model=${encodeURIComponent(deepgramModel)}` +
        `&language=${encodeURIComponent(language)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${deepgramApiKey}`,
          "Content-Type": "audio/wav",
        },
        body: wavBuffer,
        signal,
      });
      if (!response.ok) {
        throw providerError(
          "deepgram",
          `Deepgram HTTP ${response.status}`,
          response.status,
        );
      }
      const body = await readJson(response, "deepgram");
      return String(
        body?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "",
      ).trim();
    });
  }

  async function transcribeGemini(wavBuffer) {
    return withTimeout("gemini", timeoutMs, async (signal) => {
      const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(geminiModel)}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: GEMINI_TRANSCRIPTION_PROMPT },
                {
                  inlineData: {
                    mimeType: "audio/wav",
                    data: Buffer.from(wavBuffer).toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 512 },
        }),
        signal,
      });
      if (!response.ok) {
        throw providerError(
          "gemini",
          `Gemini HTTP ${response.status}`,
          response.status,
        );
      }
      return geminiTranscript(await readJson(response, "gemini"));
    });
  }

  const providers = [];
  if (deepgramApiKey) providers.push(["deepgram", transcribeDeepgram]);
  if (geminiApiKey) providers.push(["gemini", transcribeGemini]);

  const transcribe = async (wavBuffer) => {
    if (!providers.length) return "";
    const errors = [];
    for (const [provider, run] of providers) {
      try {
        const text = await run(wavBuffer);
        transcribe.lastProvider = provider;
        return text;
      } catch (error) {
        errors.push(error);
        console.warn(
          `[transcribe] ${provider} failed (${error?.status || error?.message || "unknown"})` +
            (providers.length > 1 ? " — trying fallback" : ""),
        );
      }
    }
    if (errors.length === 1) throw errors[0];
    const error = new AggregateError(errors, "All voice transcription providers failed");
    const finalError = errors.at(-1);
    error.provider = finalError?.provider;
    error.status = finalError?.status;
    throw error;
  };
  transcribe.available = providers.length > 0;
  transcribe.providers = providers.map(([provider]) => provider);
  transcribe.lastProvider = "";
  return transcribe;
}

const transcribeWav = createVoiceTranscriber();

export async function isAvailable() {
  return transcribeWav.available;
}

export function importError() {
  return lastImportError;
}

export async function prepareModel() {
  if (!transcribeWav.available) {
    console.warn(
      "[transcribe] no Deepgram/Gemini API key — voice STT disabled",
    );
    return false;
  }
  console.log(
    `[transcribe] ✓ READY — providers=${transcribeWav.providers.join("→")} ` +
      `deepgram="${MODEL}" gemini="${GEMINI_MODEL}" lang="${LANGUAGE}"`,
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
  if (!transcribeWav.available) return false;
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
    engine: transcribeWav.providers[0] || "none",
    providers: [...transcribeWav.providers],
    lastProvider,
    model: MODEL,
    geminiModel: GEMINI_MODEL,
    language: LANGUAGE,
    modelReady: transcribeWav.available,
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
    lastProvider = transcribeWav.lastProvider;
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
  if (!transcribeWav.available) return "";
  const monoPcm = downmixAndResample(pcm);
  const wav = pcmToWav(monoPcm);
  return normalizeThaiSpacing((await transcribeWav(wav)).trim());
}
