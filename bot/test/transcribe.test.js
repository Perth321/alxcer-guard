import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function pcmWithMarker(marker) {
  // Three 48 kHz stereo frames become one 16 kHz mono sample. Writing the same
  // value to both channels makes the marker survive downmixing exactly.
  const pcm = Buffer.alloc(12);
  for (let offset = 0; offset < pcm.length; offset += 4) {
    pcm.writeInt16LE(marker, offset);
    pcm.writeInt16LE(marker, offset + 2);
  }
  return pcm;
}

function deepgramResponse(marker) {
  return {
    ok: true,
    async json() {
      return {
        results: {
          channels: [{ alternatives: [{ transcript: `text-${marker}` }] }],
        },
      };
    },
  };
}

async function importFreshTranscriber() {
  const url = new URL("../src/transcribe.js", import.meta.url);
  url.searchParams.set("test", String(++importSequence));
  return import(url.href);
}

test("schedules guilds fairly, caps each guild, and preserves FIFO per guild+user", async () => {
  const previousKey = process.env.DEEPGRAM_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.DEEPGRAM_API_KEY = "test-key";

  const started = [];
  const responseGates = new Map();
  const callbackEvents = [];
  const callbackMeta = [];
  const firstCallbackGate = deferred();

  globalThis.fetch = async (_url, options) => {
    const marker = options.body.readInt16LE(44);
    started.push(marker);
    const gate = deferred();
    responseGates.set(marker, gate);
    await gate.promise;
    return deepgramResponse(marker);
  };

  try {
    const transcriber = await importFreshTranscriber();
    const callback = (marker, hold = false) => async (_text, meta) => {
      callbackEvents.push(`${marker}:start`);
      callbackMeta.push(meta);
      if (hold) await firstCallbackGate.promise;
      callbackEvents.push(`${marker}:end`);
    };

    assert.equal(
      transcriber.enqueueTranscription(
        pcmWithMarker(1),
        callback(1, true),
        { guildId: "guild-a", userId: "user-1", durationSec: 1 },
      ),
      true,
    );
    assert.equal(
      transcriber.enqueueTranscription(
        pcmWithMarker(2),
        callback(2),
        { guildId: "guild-a", userId: "user-1", durationSec: 1 },
      ),
      true,
    );
    assert.equal(
      transcriber.enqueueTranscription(
        pcmWithMarker(3),
        callback(3),
        { guildId: "guild-a", userId: "user-2", durationSec: 1 },
      ),
      true,
    );
    assert.equal(
      transcriber.enqueueTranscription(
        pcmWithMarker(4),
        callback(4),
        { guildId: "guild-b", userId: "user-3", durationSec: 1 },
      ),
      true,
    );

    await waitFor(
      () => started.length === 3,
      "expected three jobs to occupy the available per-guild slots",
    );
    assert.equal(started[0], 1);
    assert.equal(started.includes(2), false, "same speaker must not overlap");
    assert.equal(started.includes(3), true, "another user in the guild may run");
    assert.equal(started.includes(4), true, "another guild must get a fair slot");

    const runningStatus = transcriber.getStatus();
    assert.equal(runningStatus.active, 3);
    assert.equal(runningStatus.queued, 1);
    assert.equal(runningStatus.activeByGuild["guild-a"], 2);
    assert.equal(runningStatus.activeByGuild["guild-b"], 1);
    assert.equal(runningStatus.maxConcurrentPerGuild, 2);

    responseGates.get(1).resolve();
    await waitFor(
      () => callbackEvents.includes("1:start"),
      "first async callback did not start",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      started.includes(2),
      false,
      "the next utterance must wait until the prior async callback settles",
    );
    assert.equal(callbackMeta[0].guildId, "guild-a");
    assert.equal(callbackMeta[0].userId, "user-1");

    firstCallbackGate.resolve();
    await waitFor(
      () => started.includes(2),
      "second utterance did not start after the first callback settled",
    );

    for (const marker of [2, 3, 4]) responseGates.get(marker).resolve();
    await waitFor(
      () => transcriber.getStatus().active === 0,
      "transcription jobs did not drain",
    );

    assert.ok(
      callbackEvents.indexOf("1:end") < callbackEvents.indexOf("2:start"),
      "callbacks for one guild+user must remain FIFO",
    );
    assert.equal(transcriber.getStatus().queued, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previousKey;
  }
});

test("awaits and catches rejected async callbacks without blocking later jobs", async () => {
  const previousKey = process.env.DEEPGRAM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  process.env.DEEPGRAM_API_KEY = "test-key";

  globalThis.fetch = async (_url, options) => {
    const marker = options.body.readInt16LE(44);
    return deepgramResponse(marker);
  };
  console.error = () => {};

  try {
    const transcriber = await importFreshTranscriber();
    const events = [];
    const originalMeta = { guildId: 123, userId: 456, custom: "kept" };

    transcriber.enqueueTranscription(
      pcmWithMarker(10),
      async (_text, meta) => {
        events.push(`first:${meta.guildId}:${meta.userId}`);
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("expected callback failure");
      },
      originalMeta,
    );
    // Mutation after enqueue must not rewrite metadata already attached to job 1.
    originalMeta.guildId = "changed-after-enqueue";
    transcriber.enqueueTranscription(
      pcmWithMarker(11),
      async (_text, meta) => {
        events.push(`second:${meta.guildId}:${meta.userId}`);
      },
      { guildId: 123, userId: 456 },
    );

    await waitFor(
      () => transcriber.getStatus().active === 0 && transcriber.getStatus().queued === 0,
      "jobs did not continue after callback rejection",
    );

    assert.deepEqual(events, ["first:123:456", "second:123:456"]);
    const status = transcriber.getStatus();
    assert.equal(status.totalProcessed, 2);
    assert.equal(status.totalErrors, 0, "callback failures are not STT failures");
    assert.equal(status.totalCallbackErrors, 1);
  } finally {
    console.error = previousConsoleError;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previousKey;
  }
});

test("keeps legacy callers without guildId working", async () => {
  const previousKey = process.env.DEEPGRAM_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.DEEPGRAM_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    const marker = options.body.readInt16LE(44);
    return deepgramResponse(marker);
  };

  try {
    const transcriber = await importFreshTranscriber();
    let received;
    assert.equal(
      transcriber.enqueueTranscription(
        pcmWithMarker(20),
        async (text, meta) => {
          received = { text, meta };
        },
        { userId: "legacy-user", durationSec: 1 },
      ),
      true,
    );
    await waitFor(() => !!received, "legacy callback did not run");
    assert.equal(received.text, "text-20");
    assert.equal(received.meta.userId, "legacy-user");
    assert.equal(Object.hasOwn(received.meta, "guildId"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previousKey;
  }
});

test("falls back to Gemini when Deepgram rejects the request", async () => {
  const previousConsoleWarn = console.warn;
  console.warn = () => {};
  try {
    const { createVoiceTranscriber } = await importFreshTranscriber();
    const calls = [];
    const wav = Buffer.from("test-wav");
    const transcribe = createVoiceTranscriber({
      deepgramApiKey: "deepgram-test-key",
      geminiApiKey: "gemini-test-key",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).includes("deepgram.com")) {
          return { ok: false, status: 402 };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              candidates: [{ content: { parts: [{ text: "การ์ด ปิดไมค์ทุกคน" }] } }],
            };
          },
        };
      },
    });

    assert.equal(await transcribe(wav), "การ์ด ปิดไมค์ทุกคน");
    assert.deepEqual(transcribe.providers, ["deepgram", "gemini"]);
    assert.equal(transcribe.lastProvider, "gemini");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /deepgram\.com/);
    assert.match(calls[1].url, /gemini-2\.5-flash:generateContent/);
    assert.equal(calls[1].options.headers["x-goog-api-key"], "gemini-test-key");
    const geminiBody = JSON.parse(calls[1].options.body);
    assert.equal(
      geminiBody.contents[0].parts[1].inlineData.data,
      wav.toString("base64"),
    );
  } finally {
    console.warn = previousConsoleWarn;
  }
});

test("supports Gemini-only STT and keeps Deepgram first when healthy", async () => {
  const { createVoiceTranscriber } = await importFreshTranscriber();
  const geminiUrls = [];
  const geminiOnly = createVoiceTranscriber({
    deepgramApiKey: "",
    geminiApiKey: "gemini-test-key",
    fetchImpl: async (url) => {
      geminiUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "การ์ด" }] } }] };
        },
      };
    },
  });
  assert.equal(await geminiOnly(Buffer.from("wav")), "การ์ด");
  assert.deepEqual(geminiOnly.providers, ["gemini"]);
  assert.equal(geminiUrls.length, 1);
  assert.match(geminiUrls[0], /generativelanguage\.googleapis\.com/);

  let requestCount = 0;
  const deepgramHealthy = createVoiceTranscriber({
    deepgramApiKey: "deepgram-test-key",
    geminiApiKey: "gemini-test-key",
    fetchImpl: async () => {
      requestCount++;
      return deepgramResponse(99);
    },
  });
  assert.equal(await deepgramHealthy(Buffer.from("wav")), "text-99");
  assert.equal(deepgramHealthy.lastProvider, "deepgram");
  assert.equal(requestCount, 1, "healthy Deepgram must not call Gemini");
});
