import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prism from "prism-media";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GREETING_PATH = path.join(__dirname, "..", "assets", "greeting.mp3");
const PRANK_SOUNDS = {
  rung: path.join(__dirname, "..", "assets", "rung.mp3"),
  jinny: path.join(__dirname, "..", "assets", "jinny.mp3"),
  jan: path.join(__dirname, "..", "assets", "jan.mp3"),
};
import { loadConfig } from "./config.js";
import {
  registerCommands,
  handleSettingCommand,
  handleSettingComponent,
  handleDebugCommand,
  handlePrankSound,
  isPrankCommand,
} from "./commands.js";
import {
  addTranscript,
  getRecent as getRecentTranscripts,
  getStats as getTranscriptStats,
  getCursingStats,
  loadFromDisk as loadTranscriptsFromDisk,
  setRemotePersist as setTranscriptRemotePersist,
  pruneNow as pruneTranscripts,
  flushNow as flushTranscripts,
} from "./transcripts.js";
import {
  loadOffenses,
  writeLocal as writeOffensesLocal,
} from "./offenses.js";
import {
  canPersistRemotely,
  commitOffenses,
  commitTranscripts,
} from "./github.js";
import {
  isAvailable as isTranscriberAvailable,
  enqueueTranscription,
  importError as transcriberImportError,
  prepareModel as prepareTranscriberModel,
  getStatus as getTranscribeStatus,
} from "./transcribe.js";
import {
  detectProfanity,
  generateRoastReply,
  getOffenseCount,
  nextEscalationSeconds,
  recordOffense,
  formatHumanDuration,
} from "./moderation.js";
import { generateReply, generateVisionReply, shouldEngage, aiAvailable } from "./ai.js";
import {
  detectObjects,
  drawBoxes,
  extractVideoFrames,
  extractVisionIntent,
  summarizeDetections,
  thaiLabel,
  annotateVideo,
} from "./vision.js";
import { isAdmin, runAgent } from "./agent.js";
import {
  listTimers as listTimersAll,
  dueTimers,
  cancelTimer,
  markFired,
  deleteTimer,
  setMessageId,
  getTimer,
  formatDurationShort,
  formatClockBangkok,
} from "./timers.js";
import { synthesizeThai } from "./tts.js";
import { getModelStatus } from "./ai.js";

// Force-load every crypto candidate eagerly so @discordjs/voice's lazy loader
// can pick whichever one is actually available, AND we can see in the boot log
// exactly which ones loaded vs failed (instead of silent-failing).
let cryptoLib = "unknown";
const cryptoTried = [];
async function tryCrypto(name, validate) {
  try {
    const mod = await import(name);
    if (validate) await validate(mod);
    cryptoTried.push(`✓ ${name}`);
    return true;
  } catch (err) {
    cryptoTried.push(`✗ ${name}: ${err?.message?.slice(0, 90)}`);
    return false;
  }
}
if (await tryCrypto("sodium-native")) cryptoLib = "sodium-native";
else if (
  await tryCrypto("@stablelib/xchacha20poly1305", async (m) => {
    if (!m.XChaCha20Poly1305) throw new Error("XChaCha20Poly1305 export missing");
    // smoke-test actual encrypt/decrypt to ensure WASM/JS path works
    const c = new m.XChaCha20Poly1305(new Uint8Array(32));
    const ct = c.seal(new Uint8Array(24), new Uint8Array([1, 2, 3]));
    if (!ct || ct.length < 3) throw new Error("seal returned invalid output");
  })
) cryptoLib = "@stablelib/xchacha20poly1305";
else if (await tryCrypto("@noble/ciphers/chacha")) cryptoLib = "@noble/ciphers";
else if (
  await tryCrypto("libsodium-wrappers", async (m) => {
    const sodium = m.default ?? m;
    if (!sodium?.ready) throw new Error(".ready missing");
    await sodium.ready;
  })
) cryptoLib = "libsodium-wrappers";
else cryptoLib = "none-found";
console.log(`[boot] crypto candidates:\n  ${cryptoTried.join("\n  ")}`);
console.log(`[boot] selected voice crypto library: ${cryptoLib}`);

// Print @discordjs/voice's own dependency report — the source of truth for
// what it actually picked (opus encoder, encryption lib, ffmpeg, DAVE).
try {
  const { generateDependencyReport } = await import("@discordjs/voice");
  console.log("[boot] @discordjs/voice dependency report:\n" + generateDependencyReport());
} catch (err) {
  console.error("[boot] could not load @discordjs/voice for report:", err?.message);
}

if (cryptoLib === "none-found") {
  console.error(
    "[boot] FATAL voice crypto failure — voice playback (/rung /jinny /jan, greeting) and voice receiving will NOT work.",
  );
}

const transcriptionAvailable = await isTranscriberAvailable();
if (!transcriptionAvailable) {
  console.warn(
    `[boot] voice transcription DISABLED — chat-only word ban will still work. Reason: ${transcriberImportError() || "unknown"}`,
  );
} else {
  console.log("[boot] voice transcription ENABLED");
  prepareTranscriberModel().catch((err) =>
    console.error("[boot] model prewarm failed:", err?.message),
  );
}

let config = loadConfig();
const TOKEN = process.env.DISCORD_PERSONAL_ACCESS_TOKEN;

if (!TOKEN) {
  throw new Error(
    "DISCORD_PERSONAL_ACCESS_TOKEN environment variable is required.",
  );
}

if (!config.guildId) {
  console.warn(
    "[boot] guildId is empty in config.json — bot will start but won't watch any guild until /setting is configured.",
  );
}

console.log("[boot] Alxcer Guard starting", {
  guildId: config.guildId || "(none)",
  notifyChannelId: config.notifyChannelId || "(none)",
  voiceChannelId: config.voiceChannelId || "(auto)",
  warningSeconds: config.warningSeconds,
  muteSeconds: config.muteSeconds,
  bannedWords: config.bannedWords,
  firstOffenseMuteSeconds: config.firstOffenseMuteSeconds,
  repeatOffenseMuteSeconds: config.repeatOffenseMuteSeconds,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const userState = new Map();
const subscribed = new Set();
const audioBuffers = new Map();

// Voice wake-word state. When a user says "การ์ด"/"guard" alone, we set their
// id here so the NEXT transcript from them (within WAKE_PENDING_MS) is treated
// as the actual command. Concurrent commands are rejected via wakeBusy.
const pendingWake = new Map();
const WAKE_PENDING_MS = 15_000;
let wakeBusy = false;

// Wake-word matcher. Be VERY tolerant of whisper transcription noise:
// - whisper often prepends junk like "อืม", "เอ่อ", "[เสียงเพลง]"
// - the same Thai word can come back as การ์ด / การด / ก๊าด / กาด / กาดด /
//   การ์ก / กาด์ / การ์ต / คาด / การ์ด์ depending on diction + accent
// - English versions: guard / gaurd / gard / god / gar / "hey guard"
// We match the wake token ANYWHERE in the first ~30 chars of the cleaned text
// so a leading filler word doesn't kill the trigger.
const WAKE_TOKEN_RE =
  /(?:การ[์์]?[ดตก]ดี้?|การ์[ดตก]|กา[รล]?[ดต]|ก[า๊]า?[ดต]|คา[รล]?ด|guard|gaurd|gard|alxcer\s+guard|hey\s+guard)/i;
const WAKE_LEADING_NOISE_RE = /^[\s,.!?\-:'"`()\[\]{}♪♫\*<>]+/;
// IMPORTANT: longest variants first — JS regex alternation is left-to-right,
// not longest-match. "อะ" before "อะนะ" would steal the match and break the
// stripping pass.
const WAKE_PROMPT_PREFIX_RE =
  /^(?:[\s,.;:!?\-]+|alxcer|อันนี้|อะนะ|อืม|เอ่อ|เออ|อ้า|โอ้|อะ|นี่|hey)\s*/i;

function cleanForWake(text) {
  if (!text) return "";
  let t = text.trim();
  // Strip whisper bracket annotations like "[เสียงเพลง]" / "(music)" / "♪♪♪"
  // FIRST so the regex finds the bracket — order matters because the leading
  // noise stripper would chew off the opening "[" by itself otherwise.
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t
      .replace(/^\[[^\]]{1,60}\]\s*/, "")
      .replace(/^\([^)]{1,60}\)\s*/, "")
      .replace(/^♪+[^♪]{0,60}♪+\s*/, "")
      .replace(WAKE_LEADING_NOISE_RE, "");
    if (t === before) break;
  }
  return t.trim();
}

function extractWakeCommand(text) {
  let cleaned = cleanForWake(text);
  if (!cleaned) return null;
  // Strip up to two leading filler particles ("อืม การ์ด" → "การ์ด").
  // After that, the wake token MUST be at position 0 to count as a wake call.
  // This prevents accidental triggers on sentences like "ผมเอาการ์ดเกม...".
  for (let i = 0; i < 2; i++) {
    const before = cleaned;
    cleaned = cleaned.replace(WAKE_PROMPT_PREFIX_RE, "");
    if (cleaned === before) break;
  }
  const m = cleaned.match(WAKE_TOKEN_RE);
  if (!m || m.index !== 0) return null;
  let rest = cleaned.slice(m[0].length).trim();
  rest = rest.replace(WAKE_PROMPT_PREFIX_RE, "").replace(/^[\s,.;:!?\-]+/, "").trim();
  return rest;
}

let currentChannelId = null;
let pollHandle = null;
let audioFlushHandle = null;
let timerHandle = null;
// Active wake-alarm sessions: timerId -> { stop: () => void, until: number }
const wakeSessions = new Map();
let joining = false;
let reevalQueued = false;
let activeReceiver = null;
let lastAnyAudio = Date.now();
let receiverProven = false;
let lastSpeakingFlag = 0;
let lastWatchdogRejoin = 0;
let receiverHealthLogged = false;
let notReadyTicks = 0;

const WATCHDOG_SECONDS = 60;
const WATCHDOG_COOLDOWN_MS = 3 * 60 * 1000;

const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_CHANNELS * 2;
// Lowered from 0.6 → 0.35 so a quick "การ์ด" (under 0.5s) still gets sent to
// whisper. Without this, single-word wake calls were dropped silently.
const MIN_UTTERANCE_SEC = 0.35;
const MAX_UTTERANCE_SEC = 5;
const IDLE_FLUSH_MS = 1500;

const offenses = loadOffenses();
loadTranscriptsFromDisk();
if (canPersistRemotely()) {
  setTranscriptRemotePersist((data) => commitTranscripts(data));
  console.log("[boot] transcripts will be persisted to repo (7-day retention, auto-prune)");
} else {
  console.log("[boot] transcripts kept in-memory only (no GITHUB_TOKEN to persist)");
}
const wordBanTimers = new Map();
let offensesPersistTimer = null;

const runtime = {
  getConfig: () => config,
  setConfig: (next) => {
    config = next;
    client.config = config;
  },
  requestRejoin: () => {
    if (!config.guildId) return;
    client.guilds
      .fetch(config.guildId)
      .then((g) => reevaluateAndJoin(g))
      .catch((err) => console.error("[rejoin] error", err?.message));
  },
  transcriptionAvailable: () => transcriptionAvailable,
  getRecentTranscripts: (opts) => getRecentTranscripts(opts),
  getTranscriptStats: () => getTranscriptStats(),
  getCursingStats: (opts) => getCursingStats(opts),
  playPrankSound: (name) => playPrankSound(name),
  snapshot: () => {
    const now = Date.now();
    const conn = config.guildId ? getVoiceConnection(config.guildId) : null;
    const connStatus = conn?.state?.status ?? "none";
    const allVoiceChannels = [];
    if (config.guildId) {
      const guild = client.guilds.cache.get(config.guildId);
      if (guild) {
        for (const ch of guild.channels.cache.values()) {
          if (
            ch.type !== ChannelType.GuildVoice &&
            ch.type !== ChannelType.GuildStageVoice
          )
            continue;
          const totalCount = ch.members.size;
          const humanCount = ch.members.filter((m) => !m.user.bot).size;
          if (totalCount > 0) {
            allVoiceChannels.push({ id: ch.id, totalCount, humanCount });
          }
        }
      }
    }
    return {
      connected: !!currentChannelId,
      connStatus,
      channelId: currentChannelId,
      cryptoLib,
      transcription: transcriptionAvailable,
      transcribeStatus: getTranscribeStatus(),
      lastAnyAudioAge: Math.round((now - lastAnyAudio) / 1000),
      allVoiceChannels,
      users: [...userState.entries()].map(([id, s]) => ({
        id,
        heardOnce: s.heardOnce,
        speaking: s.speaking,
        silentFor: Math.round((now - s.lastSpoke) / 1000),
        warned: s.warned,
        muted: s.muted,
      })),
    };
  },
};

client.config = config;

function getNotifyChannel(guild) {
  if (!config.notifyChannelId) return null;
  return guild.channels.cache.get(config.notifyChannelId) ?? null;
}

async function announce(guild, payload) {
  const ch = getNotifyChannel(guild);
  if (!ch || !ch.isTextBased()) return;
  try {
    await ch.send(payload);
  } catch (err) {
    console.error("[announce] failed", err?.message);
  }
}

function pickBestVoiceChannel(guild) {
  if (config.voiceChannelId) {
    const pinned = guild.channels.cache.get(config.voiceChannelId);
    if (
      pinned &&
      (pinned.type === ChannelType.GuildVoice ||
        pinned.type === ChannelType.GuildStageVoice)
    ) {
      const humanCount = pinned.members.filter(
        (m) => !(config.ignoreBots && m.user.bot),
      ).size;
      return humanCount > 0 ? pinned : null;
    }
  }

  const candidates = guild.channels.cache.filter(
    (c) =>
      (c.type === ChannelType.GuildVoice ||
        c.type === ChannelType.GuildStageVoice) &&
      c.members.size > 0,
  );
  let best = null;
  let bestCount = 0;
  for (const ch of candidates.values()) {
    const humanCount = ch.members.filter(
      (m) => !(config.ignoreBots && m.user.bot),
    ).size;
    if (humanCount > bestCount) {
      bestCount = humanCount;
      best = ch;
    }
  }
  return best;
}

function newUserState(now) {
  return {
    lastSpoke: now,
    warned: false,
    muted: false,
    speaking: false,
    heardOnce: false,
    silentTicks: 0,
  };
}

function syncUserState(channel) {
  const now = Date.now();
  for (const [, member] of channel.members) {
    if (config.ignoreBots && member.user.bot) continue;
    if (!userState.has(member.id)) {
      userState.set(member.id, newUserState(now));
    }
  }
}

function markHeard(userId, source) {
  const s = userState.get(userId);
  if (!s) return;
  const wasHeard = s.heardOnce;
  s.lastSpoke = Date.now();
  s.heardOnce = true;
  s.silentTicks = 0;
  if (s.warned) s.warned = false;
  if (source === "packet") {
    lastAnyAudio = Date.now();
    if (!receiverProven) {
      receiverProven = true;
      console.log("[health] receiver PROVEN working — first real audio packet decoded");
    }
    if (receiverHealthLogged) {
      console.log("[health] receiver recovered — audio flowing again");
      receiverHealthLogged = false;
    }
  }
  if (!wasHeard) {
    console.log(`[voice] first audio confirmed from ${userId} via ${source}`);
  }
}

function appendPcm(userId, pcm) {
  let buf = audioBuffers.get(userId);
  if (!buf) {
    buf = { chunks: [], totalBytes: 0, lastAppendAt: 0 };
    audioBuffers.set(userId, buf);
  }
  buf.chunks.push(pcm);
  buf.totalBytes += pcm.length;
  buf.lastAppendAt = Date.now();
  const maxBytes = PCM_BYTES_PER_SECOND * MAX_UTTERANCE_SEC;
  if (buf.totalBytes >= maxBytes) {
    flushUserAudio(userId, "max-length");
  }
}

function flushUserAudio(userId, reason) {
  const buf = audioBuffers.get(userId);
  if (!buf || buf.chunks.length === 0) return;
  const pcm = Buffer.concat(buf.chunks);
  buf.chunks = [];
  buf.totalBytes = 0;
  const durationSec = pcm.length / PCM_BYTES_PER_SECOND;
  if (durationSec < MIN_UTTERANCE_SEC) return;
  if (!transcriptionAvailable) return;
  if (!config.guildId) return;
  const enqueued = enqueueTranscription(
    pcm,
    handleVoiceTranscript,
    { userId, durationSec, reason },
  );
  if (enqueued) {
    console.log(
      `[transcribe] queued user=${userId} dur=${durationSec.toFixed(1)}s reason=${reason}`,
    );
  }
}

async function handleVoiceTranscript(text, meta) {
  if (!text) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  console.log(
    `[transcribe] user=${meta.userId} dur=${meta.durationSec?.toFixed(1)}s text="${trimmed.slice(0, 200)}"`,
  );

  const word = findBannedWord(trimmed);

  let username = "";
  try {
    if (config.guildId) {
      const guild = client.guilds.cache.get(config.guildId);
      if (guild) {
        const member = guild.members.cache.get(meta.userId);
        if (member) username = member.user.username;
      }
    }
  } catch {}

  // ── WAKE-WORD DETECTION ────────────────────────────────────────────────
  // 1. Did this user already say "การ์ด" alone in the last WAKE_PENDING_MS?
  //    → treat THIS transcript as the command body (no second beep).
  // 2. Otherwise, does this transcript START with the wake word?
  //    a) "การ์ด <command>"  → run command immediately
  //    b) "การ์ด" alone       → set pending state, beep, wait for next utterance
  let isWakeFlow = false;
  let wakeCommand = null;
  let isFollowUp = false;

  const pending = pendingWake.get(meta.userId);
  if (pending && Date.now() - pending.at < WAKE_PENDING_MS) {
    pendingWake.delete(meta.userId);
    isWakeFlow = true;
    isFollowUp = true;
    // If the user re-said "การ์ด <cmd>" instead of just <cmd>, strip wake word
    const stripped = extractWakeCommand(trimmed);
    wakeCommand = stripped !== null ? stripped : trimmed;
  } else {
    pendingWake.delete(meta.userId);
    const cmd = extractWakeCommand(trimmed);
    if (cmd !== null) {
      isWakeFlow = true;
      wakeCommand = cmd; // may be empty string
    }
  }
  console.log(
    `[wake] candidate user=${meta.userId} match=${isWakeFlow ? "Y" : "N"} followUp=${isFollowUp} text="${trimmed.slice(0, 80)}"${isWakeFlow ? ` cmd="${(wakeCommand || "").slice(0, 80)}"` : ""}`,
  );

  addTranscript({
    userId: meta.userId,
    username,
    text: trimmed,
    durationSec: meta.durationSec,
    source: "voice",
    flagged: !!word,
    flaggedWord: word || null,
    wake: isWakeFlow || undefined,
  });

  if (isWakeFlow) {
    // Don't apply word-ban to a guard wake-call even if a banned word is in
    // the prompt — the user is talking TO the bot, not in casual chat.
    handleWakeCommand({
      userId: meta.userId,
      username,
      command: wakeCommand,
      raw: trimmed,
      isFollowUp,
    }).catch((err) => console.error("[wake] handler failed", err?.message));
    return;
  }

  if (!word) return;
  if (!config.guildId) return;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    await applyWordBan(guild, meta.userId, word, "voice", trimmed);
  } catch (err) {
    console.error("[transcribe] wordban dispatch failed", err?.message);
  }
}

async function handleWakeCommand({ userId, username, command, raw, isFollowUp }) {
  if (!config.guildId) return;
  if (wakeBusy) {
    console.log(`[wake] busy — ignoring new wake from ${userId}`);
    return;
  }
  wakeBusy = true;
  let conn = getVoiceConnection(config.guildId);
  let donePlayed = false;

  const playDone = async () => {
    if (donePlayed) return;
    donePlayed = true;
    try {
      const c = getVoiceConnection(config.guildId);
      if (c) await playPcmBeep(c, DONE_BEEP_PCM, "wake-done", 3000);
    } catch (err) {
      console.warn("[wake] done beep failed", err?.message);
    }
  };

  try {
    // Stage 1: only beep on the FIRST wake utterance, not on the follow-up.
    // The user already heard "ติ๊ดๆ" and is now giving the command — playing
    // it again would be confusing and adds latency.
    if (!isFollowUp && conn) {
      await playPcmBeep(conn, WAKE_BEEP_PCM, "wake", 2500);
    }

    // Stage 2: command body empty → mark pending, await the next utterance
    if (!command) {
      pendingWake.set(userId, { at: Date.now() });
      console.log(
        `[wake] user=${userId} acknowledged — awaiting command (${WAKE_PENDING_MS}ms)`,
      );
      setTimeout(() => {
        const p = pendingWake.get(userId);
        if (p && Date.now() - p.at >= WAKE_PENDING_MS - 100) {
          pendingWake.delete(userId);
          console.log(`[wake] user=${userId} pending timed out`);
        }
      }, WAKE_PENDING_MS + 100).unref?.();
      return;
    }

    console.log(`[wake] user=${userId} command="${command.slice(0, 200)}"`);

    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) {
      console.warn("[wake] guild fetch failed");
      return;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    const replyChannel = pickReplyChannel(guild);

    // Stage 3 (visibility): post what we HEARD immediately, before the agent
    // even runs. This is the "voice → text" view the user wants — they see
    // the bot's interpretation of their voice instantly, even if the agent
    // takes 5-30 seconds to think.
    let statusMsg = null;
    if (replyChannel) {
      try {
        statusMsg = await replyChannel.send(
          `🎙 <@${userId}> ได้ยิน: \`${command.slice(0, 180)}\`\n_(กำลังประมวลผล...)_`,
        );
      } catch (err) {
        console.warn("[wake] status send failed", err?.message);
      }
    }

    // Admin gate removed — voice commands are open to everyone in the server.
    // The agent itself still enforces role-hierarchy guardrails for any
    // moderation action it performs (ban / mute / move).

    if (replyChannel) await replyChannel.sendTyping().catch(() => {});

    let result = "";
    let errMsg = "";
    try {
      result = await runAgent({
        userPrompt: `[คำสั่งเสียงจาก ${username || userId}]: ${command}`,
        ctx: {
          guild,
          channel: replyChannel,
          authorTag: username || userId,
          authorId: userId,
          offenses,
          persistOffenses: async () => persistOffenses(),
          chatHistory: [],
        },
      });
    } catch (err) {
      errMsg = err?.message?.slice(0, 200) || "unknown error";
      console.warn("[wake] agent failed:", errMsg);
    }

    const body = (result || "").trim();
    // Honest engine tag so the user can see which AI actually answered.
    let engineTag = "";
    try {
      const s = getModelStatus();
      if (s.lastProvider && s.lastModel) {
        const shortModel = s.lastModel.replace(/^.+\//, "").replace(/-preview-\d+-\d+$/, "");
        engineTag = ` _(via ${s.lastProvider}: ${shortModel})_`;
      }
    } catch {}
    let finalText;
    if (errMsg) {
      finalText = `🎙 <@${userId}> สั่ง: \`${command.slice(0, 180)}\`\n⚠️ เออร์เรอ: ${errMsg}${engineTag}`;
    } else if (!body) {
      finalText = `🎙 <@${userId}> สั่ง: \`${command.slice(0, 180)}\`\n✅ เสร็จแล้วครับ${engineTag}`;
    } else {
      finalText = `🎙 <@${userId}> สั่ง: \`${command.slice(0, 180)}\`\n${body.slice(0, 1800)}${engineTag}`;
    }
    try {
      if (statusMsg) await statusMsg.edit(finalText);
      else if (replyChannel) await replyChannel.send(finalText);
    } catch (err) {
      console.warn("[wake] reply edit/send failed", err?.message);
      if (replyChannel) await replyChannel.send(finalText).catch(() => {});
    }
  } catch (err) {
    console.error("[wake] outer handler error", err?.message, err?.stack);
  } finally {
    // ALWAYS play the done beep on success or failure (except for the
    // pending-acknowledgement path which already returned above)
    await playDone();
    wakeBusy = false;
  }
}

function pickReplyChannel(guild) {
  const voiceChan = currentChannelId ? guild.channels.cache.get(currentChannelId) : null;
  const me = guild.members.me;
  const canSend = (ch) => {
    if (!ch || !me) return false;
    const perms = ch.permissionsFor(me);
    return perms?.has(PermissionFlagsBits.SendMessages) && perms?.has(PermissionFlagsBits.ViewChannel);
  };
  if (canSend(voiceChan)) return voiceChan;
  if (canSend(guild.systemChannel)) return guild.systemChannel;
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && canSend(ch)) return ch;
  }
  return null;
}

function subscribeUser(receiver, userId) {
  if (subscribed.has(userId)) return;
  if (!userState.has(userId)) return;
  try {
    const sub = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    subscribed.add(userId);
    sub.on("data", () => markHeard(userId, "packet"));

    if (transcriptionAvailable) {
      const decoder = new prism.opus.Decoder({
        rate: PCM_SAMPLE_RATE,
        channels: PCM_CHANNELS,
        frameSize: 960,
      });
      sub.pipe(decoder);
      decoder.on("data", (pcm) => appendPcm(userId, pcm));
      decoder.on("error", (err) =>
        console.error("[opus] decode error", err?.message),
      );
    }

    const cleanup = () => {
      subscribed.delete(userId);
      const buf = audioBuffers.get(userId);
      if (buf) {
        buf.chunks = [];
        buf.totalBytes = 0;
      }
    };
    sub.on("error", cleanup);
    sub.on("end", cleanup);
    sub.on("close", cleanup);
  } catch (err) {
    console.error(`[voice] subscribe failed for ${userId}`, err?.message);
  }
}

function generateBeepFromSegments(segments, gain = 0.7) {
  const sampleRate = 48000;
  const channels = 2;
  const totalSamples = segments.reduce(
    (sum, seg) => sum + Math.floor((sampleRate * seg.ms) / 1000),
    0,
  );
  const buf = Buffer.alloc(totalSamples * channels * 2);
  let offset = 0;
  for (const seg of segments) {
    const samples = Math.floor((sampleRate * seg.ms) / 1000);
    const omega = (2 * Math.PI * seg.freq) / sampleRate;
    let phase = 0;
    const fade = Math.min(960, Math.floor(samples / 5));
    for (let i = 0; i < samples; i++) {
      let val = 0;
      if (seg.freq > 0) {
        const env = Math.min(1, i / fade, (samples - i) / fade);
        val = Math.sin(phase) * gain * env;
        phase += omega;
      }
      const sample = Math.max(-32767, Math.min(32767, Math.round(val * 32767)));
      buf.writeInt16LE(sample, offset);
      buf.writeInt16LE(sample, offset + 2);
      offset += 4;
    }
  }
  return buf;
}

function generateBeepPCM() {
  // Original 3-tone join greeting
  return generateBeepFromSegments([
    { freq: 0, ms: 200 },
    { freq: 880, ms: 280 },
    { freq: 0, ms: 120 },
    { freq: 660, ms: 320 },
    { freq: 0, ms: 100 },
    { freq: 1100, ms: 380 },
    { freq: 0, ms: 400 },
  ]);
}

// "ติ๊ดๆ" — short two-tone chirp meaning "I'm listening"
const WAKE_BEEP_PCM = generateBeepFromSegments([
  { freq: 0, ms: 40 },
  { freq: 1400, ms: 110 },
  { freq: 0, ms: 70 },
  { freq: 1700, ms: 130 },
  { freq: 0, ms: 80 },
], 0.55);

// Single longer descending tone — "done, you can speak again"
const DONE_BEEP_PCM = generateBeepFromSegments([
  { freq: 0, ms: 30 },
  { freq: 880, ms: 220 },
  { freq: 660, ms: 280 },
  { freq: 0, ms: 80 },
], 0.55);

let cachedBeepPCM = null;
let beepPlaying = false;
const playingFiles = new Set();

async function playSoundFile(connection, filePath, label = "sound", timeoutMs = 30000) {
  if (playingFiles.has(filePath)) {
    console.log(`[${label}] already playing this file — skipping`);
    return false;
  }
  if (!fs.existsSync(filePath)) {
    console.warn(`[${label}] file not found at ${filePath}`);
    return false;
  }
  // Diagnostics: surface file size + connection state before attempting playback
  try {
    const st = fs.statSync(filePath);
    console.log(
      `[${label}] file=${path.basename(filePath)} size=${st.size}B connState=${connection.state.status}`,
    );
  } catch {}
  if (connection.state.status !== VoiceConnectionStatus.Ready) {
    console.warn(
      `[${label}] connection not Ready (state=${connection.state.status}) — waiting up to 10s`,
    );
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      console.log(`[${label}] connection now Ready`);
    } catch {
      console.error(
        `[${label}] connection still not Ready (state=${connection.state.status}) — playback would be silent, aborting`,
      );
      return false;
    }
  }
  playingFiles.add(filePath);
  let subscription = null;
  let player = null;
  try {
    const resource = createAudioResource(filePath, {
      inputType: StreamType.Arbitrary,
      silencePaddingFrames: 5,
    });
    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    // Verbose audio events to diagnose silent-but-green-ring symptom
    player.on("stateChange", (oldS, newS) => {
      console.log(
        `[${label}] player ${oldS.status} -> ${newS.status}` +
          (newS.resource ? ` (started=${newS.resource.started}, ended=${newS.resource.ended})` : ""),
      );
    });
    player.on("debug", (msg) => {
      // prism-media + opus encoder diagnostics
      if (msg && (msg.includes("error") || msg.includes("ffmpeg") || msg.includes("opus"))) {
        console.log(`[${label}] player debug: ${msg.slice(0, 300)}`);
      }
    });
    subscription = connection.subscribe(player);
    if (!subscription) {
      console.warn(`[${label}] connection.subscribe returned null`);
      return false;
    }
    player.play(resource);
    console.log(`[${label}] play() called for ${path.basename(filePath)}`);
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(
          `[${label}] timed out after ${timeoutMs}ms (player=${player.state.status}, packetsRead=${resource?.playStream?.readableLength ?? "?"})`,
        );
        try { player.stop(); } catch {}
        resolve();
      }, timeoutMs);
      player.on(AudioPlayerStatus.Idle, () => {
        const dur = resource?.playbackDuration ?? 0;
        console.log(`[${label}] finished, playbackDuration=${dur}ms`);
        if (dur < 100) {
          console.warn(
            `[${label}] WARNING: playbackDuration <100ms — audio likely never reached Discord. ` +
              `Check ffmpeg/opus pipeline in dependency report above.`,
          );
        }
        clearTimeout(timeout);
        resolve();
      });
      player.on("error", (err) => {
        console.error(`[${label}] player error:`, err?.message, err?.stack?.split("\n")[1]?.trim());
        clearTimeout(timeout);
        resolve();
      });
    });
    return true;
  } catch (err) {
    console.error(`[${label}] play failed:`, err?.message, err?.stack);
    return false;
  } finally {
    if (subscription) {
      try { subscription.unsubscribe(); } catch {}
    }
    playingFiles.delete(filePath);
  }
}

async function playGreeting(connection) {
  return await playSoundFile(connection, GREETING_PATH, "greet", 20000);
}

async function playJoinSignal(connection) {
  const greeted = await playGreeting(connection);
  if (greeted) return;
  await playJoinBeep(connection);
}

async function playPrankSound(name) {
  const filePath = PRANK_SOUNDS[name];
  if (!filePath) {
    return { ok: false, reason: `ไม่รู้จักเสียง "${name}"` };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `ไม่พบไฟล์เสียง "${name}.mp3" ใน assets` };
  }
  if (!config.guildId) {
    return { ok: false, reason: "บอทยังไม่ได้ผูกกับเซิร์ฟเวอร์" };
  }
  const conn = getVoiceConnection(config.guildId);
  if (!conn || conn.state?.status === VoiceConnectionStatus.Destroyed) {
    return { ok: false, reason: "บอทยังไม่ได้อยู่ในห้องเสียง — รอให้มีคนเข้าห้องก่อน" };
  }
  const channelId = conn.joinConfig?.channelId ?? null;
  const ok = await playSoundFile(conn, filePath, `prank:${name}`, 30000);
  if (!ok) {
    return { ok: false, reason: "เล่นเสียงไม่สำเร็จ — ดู log บน GitHub Actions" };
  }
  return { ok: true, channelId };
}

async function playPcmBeep(connection, pcmBuffer, label = "beep", timeoutMs = 5000) {
  if (beepPlaying) {
    console.log(`[${label}] another beep already playing — skipping`);
    return;
  }
  if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) {
    console.warn(`[${label}] no live voice connection — skipping`);
    return;
  }
  beepPlaying = true;
  let subscription = null;
  let player = null;
  try {
    const stream = Readable.from([pcmBuffer], { objectMode: false });
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
      silencePaddingFrames: 5,
    });
    player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    subscription = connection.subscribe(player);
    if (!subscription) {
      console.warn(`[${label}] connection.subscribe returned null`);
      return;
    }
    player.play(resource);
    console.log(`[${label}] playing (${pcmBuffer.length} bytes PCM)`);
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[${label}] timed out after ${timeoutMs}ms`);
        try { player.stop(); } catch {}
        resolve();
      }, timeoutMs);
      player.on(AudioPlayerStatus.Idle, () => {
        console.log(`[${label}] finished`);
        clearTimeout(timeout);
        resolve();
      });
      player.on("error", (err) => {
        console.error(`[${label}] player error:`, err?.message);
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch (err) {
    console.error(`[${label}] play failed:`, err?.message, err?.stack);
  } finally {
    if (subscription) {
      try { subscription.unsubscribe(); } catch {}
    }
    beepPlaying = false;
  }
}

async function playJoinBeep(connection) {
  if (!cachedBeepPCM) cachedBeepPCM = generateBeepPCM();
  await playPcmBeep(connection, cachedBeepPCM, "beep", 5000);
}

// ===== Wake-alarm: TTS + music loop =====

const TTS_TMP_DIR = "/tmp/alxcer-tts";
try { fs.mkdirSync(TTS_TMP_DIR, { recursive: true }); } catch {}

async function speakThai(connection, text, label = "tts") {
  try {
    const buf = await synthesizeThai(text);
    const file = path.join(TTS_TMP_DIR, `${label}-${Date.now()}.mp3`);
    fs.writeFileSync(file, buf);
    await playSoundFile(connection, file, label, 30_000);
    try { fs.unlinkSync(file); } catch {}
    return true;
  } catch (err) {
    console.warn(`[${label}] tts failed: ${err?.message?.slice(0, 200)}`);
    return false;
  }
}

async function downloadToTmp(url, label = "wake-music") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const ab = await res.arrayBuffer();
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const ext =
      ct.includes("ogg") ? ".ogg" :
      ct.includes("wav") ? ".wav" :
      ct.includes("mpeg") || ct.includes("mp3") ? ".mp3" :
      ct.includes("aac") || ct.includes("mp4") ? ".m4a" :
      ".mp3";
    const file = path.join(TTS_TMP_DIR, `${label}-${Date.now()}${ext}`);
    fs.writeFileSync(file, Buffer.from(ab));
    return file;
  } finally {
    clearTimeout(t);
  }
}

// Generate a soft "twinkle" PCM melody as a no-music fallback.
const SOFT_CHIME_PCM = generateBeepFromSegments([
  { freq: 0,    ms: 80 },
  { freq: 880,  ms: 200 },   // A5
  { freq: 1108, ms: 200 },   // C#6
  { freq: 1318, ms: 240 },   // E6
  { freq: 0,    ms: 120 },
  { freq: 1108, ms: 200 },
  { freq: 880,  ms: 240 },
  { freq: 0,    ms: 80 },
], 0.45);

/**
 * Run a wake-alarm session: switch into the target user's voice channel,
 * play TTS + music in a loop until session.stopped is true (or hard timeout).
 * Safe to start multiple sessions for different users.
 */
async function runWakeSession({ guild, member, ttsText, musicUrl, timerId }) {
  const voiceCh = member.voice?.channel;
  if (!voiceCh) {
    return { ok: false, reason: "user not in any voice channel" };
  }

  // If the bot is already in a different channel, switch.
  let conn = getVoiceConnection(guild.id);
  const sameChannel = conn && conn.joinConfig?.channelId === voiceCh.id;
  if (!sameChannel) {
    try {
      conn = joinVoiceChannel({
        channelId: voiceCh.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      console.warn(`[wake:${timerId}] join failed: ${err?.message}`);
      return { ok: false, reason: "could not join voice channel" };
    }
  }

  // Try to download music ONCE up-front so the loop is fast & predictable.
  let musicFile = null;
  if (musicUrl) {
    try {
      musicFile = await downloadToTmp(musicUrl, `wake-${timerId}`);
      console.log(`[wake:${timerId}] music ready at ${musicFile}`);
    } catch (err) {
      console.warn(`[wake:${timerId}] music download failed (${err?.message}) — will use chime fallback`);
    }
  }

  const session = {
    stopped: false,
    until: Date.now() + 10 * 60 * 1000, // 10-min hard cap so a forgotten alarm can't run forever
  };
  session.stop = () => {
    session.stopped = true;
  };
  wakeSessions.set(timerId, session);

  (async () => {
    let iter = 0;
    try {
      // Initial TTS
      await speakThai(conn, ttsText || "ขออนุญาตปลุกนะครับ ตื่นได้แล้วเด้อ", `wake-${timerId}-greet`);
      while (!session.stopped && Date.now() < session.until) {
        iter++;
        if (musicFile && fs.existsSync(musicFile)) {
          // Re-add file to playingFiles guard between iterations by copying
          // each loop to a unique name (playSoundFile dedupes by filePath).
          const loopFile = path.join(TTS_TMP_DIR, `wake-${timerId}-loop-${iter}.mp3`);
          try { fs.copyFileSync(musicFile, loopFile); } catch {}
          await playSoundFile(conn, loopFile, `wake-${timerId}-music-${iter}`, 120_000);
          try { fs.unlinkSync(loopFile); } catch {}
        } else {
          await playPcmBeep(conn, SOFT_CHIME_PCM, `wake-${timerId}-chime-${iter}`, 4000);
          // gentle pause between chimes
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (session.stopped) break;
        // Repeat the TTS every 3rd iteration
        if (iter % 3 === 0) {
          await speakThai(conn, ttsText || "ตื่นได้แล้วน้า", `wake-${timerId}-rep`);
        }
      }
    } catch (err) {
      console.warn(`[wake:${timerId}] loop error: ${err?.message}`);
    } finally {
      wakeSessions.delete(timerId);
      if (musicFile) { try { fs.unlinkSync(musicFile); } catch {} }
      console.log(`[wake:${timerId}] session ended after ${iter} iterations`);
    }
  })();

  return { ok: true };
}

// ===== Embed builders =====

const TIMER_TYPE_META = {
  timer:            { emoji: "⏲️", color: 0x3498db, title: "ตัวจับเวลา" },
  alarm:            { emoji: "⏰", color: 0xe67e22, title: "นาฬิกาปลุก" },
  wake_alarm:       { emoji: "🌅", color: 0xe67e22, title: "นาฬิกาปลุก (พร้อมเพลง)" },
  sleep_disconnect: { emoji: "🛌", color: 0x9b59b6, title: "Sleep mode" },
  auto_unmute:      { emoji: "🔇", color: 0xe74c3c, title: "ปิดไมค์ชั่วคราว" },
};

function timerCreatedEmbed(t) {
  const meta = TIMER_TYPE_META[t.type] || TIMER_TYPE_META.timer;
  const remaining = Math.max(0, Math.round((t.fireAt - Date.now()) / 1000));
  const fireUnix = Math.round(t.fireAt / 1000);
  const lines = [
    `**${t.label || meta.title}**`,
    `จะแจ้งเตือน <t:${fireUnix}:R> (เวลา <t:${fireUnix}:T>)`,
    `อีกประมาณ \`${formatDurationShort(remaining)}\``,
    `ID: \`${t.id}\``,
  ];
  return new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${meta.title} ตั้งแล้ว`)
    .setDescription(lines.join("\n"))
    .setTimestamp(new Date());
}

function timerCreatedRow(t) {
  const row = new ActionRowBuilder();
  if (t.type === "auto_unmute") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`alxcer-cancel-mute:${t.id}`)
        .setStyle(ButtonStyle.Success)
        .setLabel("เปิดไมค์เลย"),
    );
  } else if (t.type === "sleep_disconnect") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`alxcer-cancel-sleep:${t.id}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel("ยกเลิก sleep"),
    );
  } else if (t.type === "wake_alarm" || t.type === "alarm" || t.type === "timer") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`alxcer-cancel-timer:${t.id}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("ยกเลิก"),
    );
  }
  return row.components.length ? row : null;
}

function timerFiredEmbed(t, extra = "") {
  const meta = TIMER_TYPE_META[t.type] || TIMER_TYPE_META.timer;
  const lines = [
    `**${t.label || meta.title}**`,
    extra,
    `ตั้งไว้เมื่อ <t:${Math.round(t.createdAt / 1000)}:t> · ครบเวลาเมื่อ <t:${Math.round(t.fireAt / 1000)}:T>`,
  ].filter(Boolean);
  return new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${meta.title} — ครบเวลาแล้ว!`)
    .setDescription(lines.join("\n"))
    .setTimestamp(new Date());
}

function wakeRunningRow(timerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`alxcer-stop-alarm:${timerId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel("หยุดปลุก"),
    new ButtonBuilder()
      .setCustomId(`alxcer-snooze:${timerId}:5`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Snooze 5 นาที"),
    new ButtonBuilder()
      .setCustomId(`alxcer-snooze:${timerId}:10`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Snooze 10 นาที"),
  );
}

// Post the "I just created a timer" embed in the channel where the agent ran.
export async function announceTimerCreated(timerId) {
  const t = getTimer(timerId);
  if (!t || !t.channelId) return;
  try {
    const guild = await client.guilds.fetch(t.guildId);
    const channel = await guild.channels.fetch(t.channelId);
    if (!channel?.isTextBased?.()) return;
    const row = timerCreatedRow(t);
    const msg = await channel.send({
      embeds: [timerCreatedEmbed(t)],
      components: row ? [row] : [],
    });
    setMessageId(t.id, msg.id);
  } catch (err) {
    console.warn(`[timer:${timerId}] announce failed: ${err?.message}`);
  }
}

// Fire a single timer: do its action + post the "fired" embed.
async function fireTimer(t) {
  if (t.fired || t.cancelled) return;
  markFired(t.id);
  try {
    const guild = await client.guilds.fetch(t.guildId);
    const channel = t.channelId ? await guild.channels.fetch(t.channelId).catch(() => null) : null;
    const mention = t.mentionUserId ? `<@${t.mentionUserId}> ` : "";

    if (t.type === "timer" || t.type === "alarm") {
      const embed = timerFiredEmbed(t, "🔔 ครบเวลา!");
      if (channel?.isTextBased?.()) {
        await channel.send({ content: mention.trim() || undefined, embeds: [embed] }).catch(() => {});
      }
      // Also chime in voice if the bot is connected
      const conn = getVoiceConnection(guild.id);
      if (conn && conn.state.status === VoiceConnectionStatus.Ready) {
        await speakThai(conn, `แจ้งเตือนครับ ${t.label || "ครบเวลาแล้ว"}`, `timer-${t.id}`);
      }
      deleteTimer(t.id);
      return;
    }

    if (t.type === "wake_alarm") {
      // Find the target member; only proceed if they're in voice.
      let member = null;
      try { member = await guild.members.fetch(t.userId); } catch {}
      if (!member?.voice?.channel) {
        if (channel?.isTextBased?.()) {
          await channel.send({
            content: mention,
            embeds: [
              timerFiredEmbed(t, "⚠️ ปลุกไม่ได้ — ผู้ใช้ไม่ได้อยู่ในห้องเสียง"),
            ],
          }).catch(() => {});
        }
        deleteTimer(t.id);
        return;
      }
      const ttsText = config.wakeTtsText || "ขออนุญาตปลุกนะครับ ตื่นได้แล้วเด้อ";
      const musicUrl = config.wakeMusicUrl || "";
      // Post embed FIRST (with stop button) so user has UI before audio kicks in
      let firedMsg = null;
      if (channel?.isTextBased?.()) {
        firedMsg = await channel.send({
          content: mention,
          embeds: [timerFiredEmbed(t, "🌅 กำลังปลุกในห้องเสียง — กดปุ่มเพื่อหยุด")],
          components: [wakeRunningRow(t.id)],
        }).catch(() => null);
      }
      // Kick off the actual loop (non-blocking)
      runWakeSession({ guild, member, ttsText, musicUrl, timerId: t.id }).catch((err) =>
        console.warn(`[wake:${t.id}] runWakeSession threw:`, err?.message),
      );
      // Don't deleteTimer — the stop button needs the record. We mark fired,
      // and clean up after the wake session finishes.
      const cleanupHandle = setInterval(() => {
        if (!wakeSessions.has(t.id)) {
          clearInterval(cleanupHandle);
          deleteTimer(t.id);
          if (firedMsg) {
            firedMsg.edit({
              embeds: [timerFiredEmbed(t, "✅ หยุดปลุกแล้ว")],
              components: [],
            }).catch(() => {});
          }
        }
      }, 5000);
      return;
    }

    if (t.type === "sleep_disconnect") {
      // Disconnect the user from voice
      let member = null;
      try { member = await guild.members.fetch(t.userId); } catch {}
      let outcome = "❌ ผู้ใช้ไม่อยู่ในเซิร์ฟเวอร์";
      if (member?.voice?.channel) {
        try {
          await member.voice.disconnect("Sleep mode timer");
          outcome = `🛌 เตะ ${member.displayName} ออกจาก ${member.voice.channel.name} เรียบร้อย — หลับสบาย`;
        } catch (err) {
          outcome = `❌ เตะไม่สำเร็จ: ${err?.message?.slice(0, 100)}`;
        }
      } else {
        outcome = "ℹ️ ผู้ใช้ไม่ได้อยู่ในห้องเสียงแล้ว — ข้ามการเตะ";
      }
      if (channel?.isTextBased?.()) {
        await channel.send({ content: mention, embeds: [timerFiredEmbed(t, outcome)] }).catch(() => {});
      }
      deleteTimer(t.id);
      return;
    }

    if (t.type === "auto_unmute") {
      let member = null;
      try { member = await guild.members.fetch(t.userId); } catch {}
      let outcome = "ℹ️ ผู้ใช้ไม่อยู่แล้ว";
      if (member?.voice?.channel) {
        try {
          await member.voice.setMute(false, "auto_unmute timer");
          outcome = `🔊 เปิดไมค์ ${member.displayName} แล้ว`;
        } catch (err) {
          outcome = `❌ เปิดไมค์ไม่สำเร็จ: ${err?.message?.slice(0, 100)}`;
        }
      } else if (member) {
        outcome = `ℹ️ ${member.displayName} ไม่ได้อยู่ในห้องเสียงแล้ว`;
      }
      if (channel?.isTextBased?.()) {
        await channel.send({ content: mention, embeds: [timerFiredEmbed(t, outcome)] }).catch(() => {});
      }
      deleteTimer(t.id);
      return;
    }
  } catch (err) {
    console.error(`[timer:${t.id}] fire crashed: ${err?.message}`);
    deleteTimer(t.id);
  }
}

async function tickTimers() {
  const due = dueTimers();
  if (!due.length) return;
  for (const t of due) {
    // Run them in parallel — they're independent and can each take a while
    fireTimer(t).catch((err) => console.warn(`[timer:${t.id}] fire error: ${err?.message}`));
  }
}

// Background sweeper: post "created" embeds for any timer that hasn't had one
// posted yet (in case the agent created several in one turn).
const announcedTimers = new Set();
async function announceNewTimers() {
  const all = listTimersAll();
  for (const t of all) {
    if (announcedTimers.has(t.id)) continue;
    announcedTimers.add(t.id);
    announceTimerCreated(t.id).catch(() => {});
  }
  // Trim memory
  if (announcedTimers.size > 500) {
    const arr = [...announcedTimers];
    arr.slice(0, arr.length - 200).forEach((id) => announcedTimers.delete(id));
  }
}

async function attachReceiver(connection, channel) {
  const receiver = connection.receiver;
  activeReceiver = receiver;
  subscribed.clear();
  audioBuffers.clear();
  receiverProven = false;

  receiver.speaking.on("start", (userId) => {
    lastSpeakingFlag = Date.now();
    const s = userState.get(userId);
    if (s) {
      s.speaking = true;
      markHeard(userId, "start");
    }
    subscribeUser(receiver, userId);
  });

  receiver.speaking.on("end", (userId) => {
    lastSpeakingFlag = Date.now();
    const s = userState.get(userId);
    if (s) {
      s.speaking = false;
      markHeard(userId, "end");
    }
    flushUserAudio(userId, "speaking-end");
  });

  for (const userId of userState.keys()) {
    subscribeUser(receiver, userId);
  }

  console.log(`[voice] receiver attached on #${channel.name}`);
}

function isReceiverHealthy() {
  if (receiverProven) return true;
  const sinceAudio = (Date.now() - lastAnyAudio) / 1000;
  return sinceAudio < WATCHDOG_SECONDS;
}

async function checkInactivity(guild) {
  if (!currentChannelId) return;
  const channel = guild.channels.cache.get(currentChannelId);
  if (!channel) return;

  const now = Date.now();

  for (const [, member] of channel.members) {
    if (config.ignoreBots && member.user.bot) continue;
    if (!userState.has(member.id)) {
      userState.set(member.id, newUserState(now));
      console.log(`[track] added ${member.user.tag}`);
    }
  }
  for (const userId of [...userState.keys()]) {
    if (!channel.members.has(userId)) {
      userState.delete(userId);
      subscribed.delete(userId);
      audioBuffers.delete(userId);
      console.log(`[track] removed ${userId}`);
    }
  }

  const conn = getVoiceConnection(guild.id);
  const connStatus = conn?.state?.status ?? "none";

  if (conn && connStatus !== VoiceConnectionStatus.Destroyed) {
    if (activeReceiver !== conn.receiver) {
      console.log(`[voice] receiver changed — re-attaching`);
      await attachReceiver(conn, channel);
    }
  }

  const humansInChannel = [...channel.members.values()].filter(
    (m) => !(config.ignoreBots && m.user.bot),
  );

  if (humansInChannel.length > 0 && !isReceiverHealthy()) {
    if (!receiverHealthLogged) {
      console.warn(
        `[health] receiver has no audio for ${WATCHDOG_SECONDS}s+ — pausing mute decisions until packets flow`,
      );
      receiverHealthLogged = true;
    }
    notReadyTicks++;
    if (
      notReadyTicks >= 12 &&
      Date.now() - lastWatchdogRejoin > WATCHDOG_COOLDOWN_MS
    ) {
      console.warn(
        `[health] receiver dead 1m+ (state=${connStatus}) — background rejoin`,
      );
      lastWatchdogRejoin = Date.now();
      notReadyTicks = 0;
      if (conn) safeDestroy(conn);
      currentChannelId = null;
      activeReceiver = null;
      subscribed.clear();
      reevaluateAndJoin(guild).catch((err) =>
        console.error("[health] background rejoin error", err?.message),
      );
    }
    return;
  }
  notReadyTicks = 0;

  for (const [userId, s] of userState) {
    const member = channel.members.get(userId);
    if (!member) continue;

    if (wordBanTimers.has(userId)) {
      s.muted = true;
      continue;
    }

    if (member.voice.serverMute) {
      s.muted = true;
      continue;
    } else if (s.muted) {
      s.muted = false;
      s.warned = false;
      s.lastSpoke = now;
      s.silentTicks = 0;
    }

    // === Skip self-muted / self-deafened users ===
    // ผู้ใช้ปิดไมค์เอง (หรือปิดหู) อยู่แล้ว ไม่ต้องไปปิดซ้ำ — บอทจัดการเฉพาะ
    // คนที่ "เปิดไมค์แต่เงียบ" เท่านั้น และต้องไม่ลงโทษเขาเมื่อกลับมา
    if (member.voice.selfMute || member.voice.selfDeaf) {
      s.lastSpoke = now;
      s.silentTicks = 0;
      if (s.warned) s.warned = false;
      continue;
    }

    if (s.speaking) {
      s.lastSpoke = now;
      s.silentTicks = 0;
      if (s.warned) s.warned = false;
      continue;
    }

    const silentFor = (now - s.lastSpoke) / 1000;
    s.silentTicks = silentFor >= config.warningSeconds ? s.silentTicks + 1 : 0;

    if (!s.warned && silentFor >= config.warningSeconds) {
      s.warned = true;
      console.log(
        `[warn] ${member.user.tag} silent for ${silentFor.toFixed(0)}s`,
      );
      const remaining = Math.max(
        0,
        Math.round(config.muteSeconds - silentFor),
      );
      const embed = new EmbedBuilder()
        .setColor(0xfacc15)
        .setTitle("⚠️ การแจ้งเตือนอัตโนมัติ")
        .setDescription(
          `<@${userId}> คุณไม่ได้มีการใช้เสียงบนห้อง **${channel.name}**\n\n` +
            `นี่เป็นการแจ้งเตือนอัตโนมัติก่อนจะปิดเสียงคุณ\n` +
            `เหลือเวลาอีก **${remaining} วินาที** ก่อนถูกปิดไมค์`,
        );
      await announce(guild, { content: `<@${userId}>`, embeds: [embed] });
      try {
        await member.send({ embeds: [embed] });
      } catch {}
    }

    if (
      !s.muted &&
      silentFor >= config.muteSeconds
    ) {
      try {
        await member.voice.setMute(true, "Alxcer Guard: inactive in voice");
        s.muted = true;
        console.log(
          `[mute] ${member.user.tag} (silent ${silentFor.toFixed(0)}s)`,
        );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`alxcer-unmute:${userId}`)
            .setLabel("🎙️ Unmute ตัวเอง")
            .setStyle(ButtonStyle.Success),
        );
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("🔇 ขออนุญาตปิดเสียงนะครับ")
          .setDescription(
            `<@${userId}> คุณถูกปิดไมค์อัตโนมัติเนื่องจากเงียบนานเกิน ${config.muteSeconds} วินาที\n\n` +
              `กดปุ่มด้านล่างเพื่อ unmute ตัวเอง`,
          );
        await announce(guild, {
          content: `<@${userId}>`,
          embeds: [embed],
          components: [row],
        });
        try {
          await member.send({ embeds: [embed], components: [row] });
        } catch {}
      } catch (err) {
        console.error(`[mute] failed for ${member.user.tag}`, err?.message);
      }
    }
  }
}

function safeDestroy(conn) {
  if (!conn) return;
  try {
    if (conn.state.status !== VoiceConnectionStatus.Destroyed) {
      conn.destroy();
    }
  } catch {}
}

async function reevaluateAndJoin(guild) {
  if (joining) {
    reevalQueued = true;
    return;
  }
  joining = true;
  try {
    const target = pickBestVoiceChannel(guild);

    if (!target) {
      const existing = getVoiceConnection(guild.id);
      if (existing) {
        console.log("[voice] no humans in any channel, leaving");
        safeDestroy(existing);
        currentChannelId = null;
        userState.clear();
        subscribed.clear();
        audioBuffers.clear();
        activeReceiver = null;
      }
      return;
    }

    if (currentChannelId === target.id) {
      const existing = getVoiceConnection(guild.id);
      if (
        existing &&
        existing.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        syncUserState(target);
        if (activeReceiver !== existing.receiver) {
          await attachReceiver(existing, target);
          playJoinSignal(existing).catch((err) =>
            console.error("[greet] reattach greeting failed:", err?.message),
          );
        }
        return;
      }
    }

    currentChannelId = target.id;

    const existing = getVoiceConnection(guild.id);
    if (existing) safeDestroy(existing);

    console.log(
      `[voice] joining #${target.name} (${target.members.size} members)`,
    );
    const connection = joinVoiceChannel({
      channelId: target.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    connection.on("stateChange", (oldS, newS) => {
      console.log(`[voice] state ${oldS.status} -> ${newS.status}`);
    });
    connection.on("error", (err) => {
      console.error("[voice] connection error:", err?.message);
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log("[voice] disconnected — attempting reconnect");
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        console.log("[voice] real disconnect — destroying & will rejoin next tick");
        safeDestroy(connection);
        currentChannelId = null;
        activeReceiver = null;
        subscribed.clear();
        audioBuffers.clear();
      }
    });

    const me = target.guild.members.me;
    if (me) {
      const perms = target.permissionsFor(me);
      console.log(
        `[perms] in #${target.name}: View=${perms?.has("ViewChannel")} Connect=${perms?.has("Connect")} Speak=${perms?.has("Speak")} MuteMembers=${perms?.has("MuteMembers")} UseVAD=${perms?.has("UseVAD")}`,
      );
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
      console.log(`[voice] connection READY for #${target.name}`);
    } catch (err) {
      console.warn(
        `[voice] not Ready after 60s (state=${connection.state.status}) — keeping connection alive, will retry mute decisions when Ready`,
      );
    }

    syncUserState(target);
    receiverHealthLogged = false;
    await attachReceiver(connection, target);
    console.log(`[voice] monitoring #${target.name}`);

    playJoinSignal(connection).catch((err) =>
      console.error("[greet] join greeting failed:", err?.message),
    );
  } finally {
    joining = false;
    if (reevalQueued) {
      reevalQueued = false;
      setImmediate(() => {
        reevaluateAndJoin(guild).catch((err) =>
          console.error("[voice] queued reeval error", err?.message),
        );
      });
    }
  }
}

function persistOffenses() {
  try {
    writeOffensesLocal(offenses);
  } catch (err) {
    console.error("[offenses] local write failed", err?.message);
  }
  if (!canPersistRemotely()) return;
  if (offensesPersistTimer) clearTimeout(offensesPersistTimer);
  offensesPersistTimer = setTimeout(async () => {
    offensesPersistTimer = null;
    try {
      await commitOffenses(offenses);
      console.log("[offenses] committed to repo");
    } catch (err) {
      console.error("[offenses] remote commit failed", err?.message);
    }
  }, 5_000);
}

function findBannedWord(text) {
  if (!text || !Array.isArray(config.bannedWords)) return null;
  const lower = text.toLowerCase();
  for (const word of config.bannedWords) {
    if (!word) continue;
    if (lower.includes(word.toLowerCase())) return word;
  }
  return null;
}

function scheduleWordBanUnmute(guild, userId, durationMs) {
  const existing = wordBanTimers.get(userId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(async () => {
    wordBanTimers.delete(userId);
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && member.voice.channel && member.voice.serverMute) {
        await member.voice.setMute(false, "Alxcer Guard: word-ban expired");
        console.log(`[wordban] unmuted ${member.user.tag} after timer`);
      }
    } catch (err) {
      console.error("[wordban] auto-unmute failed", err?.message);
    }
    const rec = offenses.users[userId];
    if (rec) {
      rec.muteUntil = 0;
      persistOffenses();
    }
    const s = userState.get(userId);
    if (s) {
      s.muted = false;
      s.warned = false;
      s.lastSpoke = Date.now();
      s.silentTicks = 0;
    }
  }, Math.max(1_000, durationMs));
  wordBanTimers.set(userId, handle);
}

async function restorePendingWordBans(guild) {
  const now = Date.now();
  for (const [userId, rec] of Object.entries(offenses.users)) {
    if (!rec || !rec.muteUntil || rec.muteUntil <= now) continue;
    const remaining = rec.muteUntil - now;
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (member.voice.channel) {
        try {
          await member.voice.setMute(true, "Alxcer Guard: pending word-ban");
        } catch {}
      }
      scheduleWordBanUnmute(guild, userId, remaining);
      console.log(
        `[wordban] restored mute for ${member.user.tag}, ~${Math.round(remaining / 1000)}s left`,
      );
    } catch (err) {
      console.error("[wordban] restore failed", err?.message);
    }
  }
}

function formatDuration(seconds) {
  if (seconds >= 3600) {
    const h = Math.round(seconds / 3600);
    return `${h} ชั่วโมง`;
  }
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m} นาที`;
  }
  return `${seconds} วินาที`;
}

async function applyWordBan(guild, userId, word, source, transcript) {
  const prev = offenses.users[userId] ?? {
    count: 0,
    lastOffenseAt: 0,
    muteUntil: 0,
    lastWord: "",
  };

  const newCount = (prev.count || 0) + 1;
  const isFirst = newCount <= 1;
  const muteSec = isFirst
    ? config.firstOffenseMuteSeconds
    : config.repeatOffenseMuteSeconds;

  offenses.users[userId] = {
    count: newCount,
    lastOffenseAt: Date.now(),
    muteUntil: Date.now() + muteSec * 1000,
    lastWord: word,
    lastSource: source,
  };
  persistOffenses();

  console.log(
    `[wordban] user=${userId} word="${word}" source=${source} count=${newCount} mute=${muteSec}s`,
  );

  let muteApplied = false;
  let muteError = null;
  const member = await guild.members.fetch(userId).catch(() => null);

  if (member && member.voice.channel) {
    try {
      await member.voice.setMute(
        true,
        `Alxcer Guard: banned word "${word}" via ${source} (#${newCount})`,
      );
      muteApplied = true;
      scheduleWordBanUnmute(guild, userId, muteSec * 1000);
      const s = userState.get(userId);
      if (s) {
        s.muted = true;
        s.warned = true;
        s.lastSpoke = Date.now();
      }
    } catch (err) {
      muteError = err?.message;
      console.error("[wordban] setMute failed", err?.message);
    }
  } else {
    scheduleWordBanUnmute(guild, userId, muteSec * 1000);
  }

  const sourceLabel = source === "voice" ? "พูดในห้องเสียง" : "พิมพ์ในแชท";
  const durationLabel = formatDuration(muteSec);
  const title = isFirst
    ? `⚠️ คำเตือน — ${sourceLabel}`
    : `🚫 ทำผิดซ้ำ — ${sourceLabel}`;
  const color = isFirst ? 0xfacc15 : 0xef4444;
  const lines = [`<@${userId}> ใช้คำต้องห้าม \`${word}\``, ""];
  if (muteApplied) {
    lines.push(`ปิดไมค์ไว้ **${durationLabel}**`);
  } else if (muteError) {
    lines.push(`ตั้งใจปิดไมค์แต่ทำไม่ได้: \`${muteError}\``);
  } else {
    lines.push(
      `ตอนนี้ยังไม่อยู่ในห้องเสียง — เมื่อเข้ามาจะถูกปิดไมค์ทันที (อีก **${durationLabel}**)`,
    );
  }
  if (source === "voice" && transcript) {
    const snippet = transcript.length > 120 ? transcript.slice(0, 117) + "..." : transcript;
    lines.push("");
    lines.push(`> ที่บอทได้ยิน: _${snippet}_`);
  }
  lines.push("");
  lines.push(
    isFirst
      ? `*ครั้งแรก: ปิดไมค์ ${formatDuration(config.firstOffenseMuteSeconds)} — ครั้งต่อไป: ${formatDuration(config.repeatOffenseMuteSeconds)}*`
      : `*ทำผิดครั้งที่ ${newCount} — โดนเต็มอัตราโทษ ${formatDuration(config.repeatOffenseMuteSeconds)}*`,
  );

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join("\n"));

  await announce(guild, { content: `<@${userId}>`, embeds: [embed] });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[ready] logged in as ${c.user.tag}`);

  try {
    await registerCommands(client);
  } catch (err) {
    console.error("[commands] register failed", err?.message);
  }

  if (!config.guildId) return;

  try {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.members.fetch().catch(() => {});
    await reevaluateAndJoin(guild);
    await restorePendingWordBans(guild);
    // Pre-load recent chat into the in-memory buffer so the agent has real
    // context on its very first interaction after a 6h restart.
    seedRecentFromGuild(guild).catch((err) =>
      console.warn("[ready] seed failed:", err?.message)
    );

    pollHandle = setInterval(async () => {
      try {
        const g = await client.guilds.fetch(config.guildId);
        await reevaluateAndJoin(g);
        await checkInactivity(g);
      } catch (err) {
        console.error("[loop] error", err?.message);
      }
    }, 5_000);

    audioFlushHandle = setInterval(() => {
      if (!transcriptionAvailable) return;
      const now = Date.now();
      for (const [uid, buf] of audioBuffers) {
        if (buf.totalBytes > 0 && now - buf.lastAppendAt > IDLE_FLUSH_MS) {
          flushUserAudio(uid, "idle");
        }
      }
    }, 1_000);

    // Timer / alarm / sleep / auto-unmute tick — sub-second precision.
    timerHandle = setInterval(() => {
      announceNewTimers().catch(() => {});
      tickTimers().catch((err) => console.warn("[timers] tick error", err?.message));
    }, 500);

    setInterval(() => {
      try {
        pruneTranscripts();
      } catch (err) {
        console.error("[transcripts] prune error", err?.message);
      }
    }, 60 * 60 * 1000);

    setInterval(() => {
      if (!currentChannelId) return;
      const lines = [];
      for (const [uid, s] of userState) {
        const age = Math.round((Date.now() - s.lastSpoke) / 1000);
        lines.push(
          `${uid} heard=${s.heardOnce} speak=${s.speaking} silent=${age}s warn=${s.warned} mute=${s.muted}`,
        );
      }
      console.log(`[stats] ${lines.length} tracked\n  ` + lines.join("\n  "));
    }, 30_000);
  } catch (err) {
    console.error("[ready] guild init failed", err?.message);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!config.guildId) return;
  if (newState.guild.id !== config.guildId) return;
  if (newState.member?.id === client.user?.id) return;
  if (oldState.member?.id === client.user?.id) return;

  const userId = newState.member?.id ?? oldState.member?.id;
  if (userId && userState.has(userId)) {
    const wasSelfMuted = oldState.selfMute || oldState.serverMute;
    const isSelfMuted = newState.selfMute || newState.serverMute;
    if (wasSelfMuted && !isSelfMuted && !wordBanTimers.has(userId)) {
      const s = userState.get(userId);
      s.lastSpoke = Date.now();
      s.warned = false;
      s.muted = false;
      s.silentTicks = 0;
      console.log(`[voice] ${newState.member.user.tag} unmuted — timer reset`);
    }
  }

  if (userId && wordBanTimers.has(userId)) {
    const wasInVoice = !!oldState.channelId;
    const nowInVoice = !!newState.channelId;
    if (!wasInVoice && nowInVoice) {
      try {
        const member = newState.member;
        if (member && !member.voice.serverMute) {
          await member.voice.setMute(true, "Alxcer Guard: word-ban active");
          console.log(`[wordban] applied mute on join for ${member.user.tag}`);
        }
      } catch (err) {
        console.error("[wordban] join-mute failed", err?.message);
      }
    }
  }

  try {
    await reevaluateAndJoin(newState.guild);
  } catch (err) {
    console.error("[voiceUpdate] error", err?.message);
  }
});

// ===== Recent message buffer per channel (in-memory, for AI context) =====
// Bigger window → bot can follow longer threads, references like "คนเดิม",
// multi-turn admin commands, and stays "in the conversation" rather than
// snapshotting one isolated message.
const recentByChannel = new Map(); // channelId -> [{author, authorId, content, at, isBot}]
const RECENT_LIMIT = 120;
function pushRecent(channelId, entry) {
  if (!recentByChannel.has(channelId)) recentByChannel.set(channelId, []);
  const arr = recentByChannel.get(channelId);
  arr.push(entry);
  if (arr.length > RECENT_LIMIT) arr.splice(0, arr.length - RECENT_LIMIT);
}
function getRecent(channelId) {
  return recentByChannel.get(channelId) || [];
}

// On startup, fetch the last ~50 messages from every text channel the bot
// can read so the agent has real context immediately, rather than waking up
// every 6h with empty memory.
async function seedRecentFromGuild(guild) {
  let totalSeeded = 0;
  for (const [, channel] of guild.channels.cache) {
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    const me = guild.members.me;
    if (!me) continue;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory)) continue;
    try {
      const fetched = await channel.messages.fetch({ limit: 50 });
      const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const m of sorted) {
        if (!m.content) continue;
        pushRecent(channel.id, {
          author: m.author?.username || "unknown",
          authorId: m.author?.id || "",
          content: m.content.slice(0, 500),
          at: m.createdTimestamp,
          isBot: !!m.author?.bot && m.author?.id === client.user?.id,
        });
        totalSeeded++;
      }
    } catch (err) {
      // Silently skip channels we can't read
    }
  }
  console.log(`[ready] seeded recent buffer with ${totalSeeded} messages across text channels`);
}

// Spontaneous engagement throttle: at most once per ~75s per channel.
const lastSpontaneousAt = new Map();
const SPONTANEOUS_COOLDOWN_MS = 75 * 1000;
const SPONTANEOUS_BASE_PROB = 0.18; // 18% chance per qualifying msg
const SPONTANEOUS_MIN_RECENT = 1; // start chiming after just 1 msg in buffer

function isBotTriggered(msg) {
  // Direct mention of the bot user
  if (client.user && msg.mentions?.users?.has(client.user.id)) return "mention";
  // Reply to one of the bot's messages
  if (msg.reference?.messageId) {
    // We can't easily resolve here without fetch; trust mention pings only
  }
  const text = msg.content || "";
  const lower = text.toLowerCase();
  // 1) Standalone-word match (English uses ASCII word-boundary heuristic).
  if (/(?:^|\s)(guard|gaurd)(?:[\s,.!?:]|$)/i.test(lower)) return "keyword";
  // 2) Thai name — Thai script has no spaces, so allow it touching other Thai
  //    words as long as it appears at the start of the message OR after a
  //    non-letter character. e.g. "การ์ดดูภาพนี้ให้หน่อย" → triggers.
  if (/(^|[^\u0E00-\u0E7Fa-zA-Z])(การ์ด|ก๊าด|กาด)/.test(text)) return "keyword";
  return null;
}

// Detect image / video attachments on a message.
function collectMediaAttachments(msg) {
  const images = [];
  const videos = [];
  for (const att of msg.attachments?.values?.() || []) {
    const ct = (att.contentType || "").toLowerCase();
    const name = (att.name || "").toLowerCase();
    const isImage =
      ct.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|bmp)$/.test(name);
    const isVideo =
      ct.startsWith("video/") ||
      /\.(mp4|mov|webm|mkv|avi)$/.test(name);
    if (isImage) images.push({ url: att.url, name: att.name, size: att.size });
    else if (isVideo) videos.push({ url: att.url, name: att.name, size: att.size });
  }
  // Discord also surfaces image embeds (e.g. pasted links). Treat as images.
  for (const emb of msg.embeds || []) {
    if (emb.image?.url) images.push({ url: emb.image.url, name: "embed", size: 0 });
  }
  return { images, videos };
}

async function handleProfanityChat(msg, detection) {
  const userId = msg.author.id;
  const guild = msg.guild;
  // Existing chat-offense count (with 7-day decay)
  const prevCount = getOffenseCount(offenses, userId);
  const seconds = nextEscalationSeconds(prevCount);

  // Delete the offending message (best-effort)
  let deleted = false;
  try {
    await msg.delete();
    deleted = true;
  } catch (err) {
    console.warn("[mod] delete failed:", err?.message);
  }

  // Apply server timeout
  let timedOut = false;
  try {
    const member = await guild.members.fetch(userId);
    await member.timeout(seconds * 1000, `Alxcer Guard chat: ${detection.reason}`);
    timedOut = true;
  } catch (err) {
    console.warn("[mod] timeout failed:", err?.message);
  }

  // Record + persist
  const newCount = recordOffense(offenses, userId, {
    at: Date.now(),
    severity: detection.severity ?? null,
    matched: detection.matched ?? null,
    reason: detection.reason ?? null,
    excerpt: (msg.content || "").slice(0, 200),
    action: timedOut ? `timeout_${seconds}s` : "timeout_failed",
    source: detection.source,
  });
  persistOffenses();

  // Roast reply (sassy but controlled)
  let roast;
  try {
    roast = await generateRoastReply({
      username: userId,
      matched: detection.matched ?? "คำหยาบ",
      severity: detection.severity ?? 7,
    });
  } catch {
    roast = `<@${userId}> โดน timeout ${formatHumanDuration(seconds)} เพราะใช้คำหยาบ`;
  }

  // Append the consequence so the user knows
  const status = timedOut
    ? `\n\n⛔ โดน timeout **${formatHumanDuration(seconds)}** (ครั้งที่ ${newCount})${deleted ? " · ลบข้อความแล้ว" : ""}`
    : `\n\n⚠️ พยายาม timeout แต่ไม่สำเร็จ (สิทธิ์ไม่พอ?)`;

  try {
    await msg.channel.send({ content: (roast + status).slice(0, 2000) });
  } catch (err) {
    console.warn("[mod] send roast failed:", err?.message);
  }

  console.log(
    `[mod] ${msg.author.tag} chat-offense#${newCount} (${detection.source}) → timeout ${seconds}s · matched="${detection.matched}"`,
  );
}

function aiFallbackLine() {
  const lines = [
    "ตอนนี้สมองช้านิดหน่อย เซิร์ฟ AI งอแง ลองอีกครั้งครับ 😅",
    "อึ้งไปแป๊บ — model ฟรีโดน rate-limit อยู่ พิมพ์มาใหม่",
    "เครื่องคิดงานล้น เดี๋ยวกลับมาตอบนะ",
    "ฮึ ขอเวลาคิดอีกหน่อย",
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

async function safeReply(msg, content) {
  try {
    await msg.reply({
      content: (content || aiFallbackLine()).slice(0, 2000),
      allowedMentions: { repliedUser: false },
    });
    return true;
  } catch (err) {
    console.warn("[reply] send failed:", err?.message);
    try {
      await msg.channel.send({ content: (content || aiFallbackLine()).slice(0, 2000) });
      return true;
    } catch (err2) {
      console.warn("[reply] channel send also failed:", err2?.message);
      return false;
    }
  }
}

// Fetch a remote URL and return the body as a Buffer (with a size cap).
async function fetchBuffer(url, maxBytes = 25 * 1024 * 1024) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > maxBytes) throw new Error(`file too large (${len} > ${maxBytes})`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error(`file too large after read`);
  return Buffer.from(ab);
}

// Run YOLO + LLM vision on a message that has image / video attachments and
// reply in chat with annotated images and a Thai description.
async function handleVisionReply(msg, triggerReason, media) {
  const channel = msg.channel;
  await channel.sendTyping().catch(() => {});

  const cleanText = (msg.content || "").replace(/<@!?\d+>/g, "").trim();
  // ── MODE PICK ────────────────────────────────────────────────────────────
  // Two distinct flows:
  //   • "detect" → run YOLO, draw boxes, show detection summary, brief LLM caption
  //   • "chat"   → skip YOLO entirely, just let the vision LLM chat about it
  // Default is chat (lighter, more conversational). Users opt-in to detection
  // by saying things like "ตรวจ", "วิเคราะห์", "อะไรในรูป", "scan", "detect".
  const mode = extractVisionIntent(cleanText);
  console.log(`[vision] mode=${mode} (text="${cleanText.slice(0, 80)}")`);

  const annotatedAttachments = []; // { attachment: Buffer, name }
  const detectionSummaries = [];   // string per asset (detect mode only)
  const visionImageUrls = [];      // urls passed to the LLM vision call

  // ---- IMAGES ----
  for (const img of media.images.slice(0, 4)) {
    visionImageUrls.push(img.url);
    if (mode !== "detect") continue;
    try {
      const buf = await fetchBuffer(img.url);
      const { detections, width, height } = await detectObjects(buf);
      const summary = summarizeDetections(detections);
      detectionSummaries.push(`📷 ${img.name || "image"}: ${summary}`);
      if (detections.length) {
        const annotated = await drawBoxes(buf, detections, width, height);
        annotatedAttachments.push({
          attachment: annotated,
          name: `yolo_${(img.name || "image").replace(/\.[^.]+$/, "")}.jpg`,
        });
      }
    } catch (err) {
      console.warn(`[vision] image processing failed: ${err.message?.slice(0, 200)}`);
      detectionSummaries.push(`📷 ${img.name || "image"}: ประมวลผลภาพล้มเหลว (${err.message?.slice(0, 80)})`);
    }
  }

  // ---- VIDEOS ----
  // Reply with an actual video, never just standalone frames:
  //   • chat   → re-attach the original clip (under Discord's 24 MB cap),
  //              after sampling a few frames internally so the vision LLM
  //              still perceives motion when composing its caption.
  //   • detect → run YOLO on a sampled frame stream, redraw each frame with
  //              labelled boxes, then re-encode as MP4 and attach THAT video.
  //              Falls back to the original clip if annotation fails.
  // Frames are never sent as separate image attachments.
  const VIDEO_FRAMES_FOR_LLM = 4;
  const DISCORD_FILE_CAP = 24 * 1024 * 1024;

  for (const vid of media.videos.slice(0, 1)) {
    const baseName = (vid.name || "video").replace(/\.[^.]+$/, "");
    let originalBuf = null;
    try {
      originalBuf = await fetchBuffer(vid.url, 50 * 1024 * 1024);
    } catch (err) {
      console.warn(`[vision] video fetch failed: ${err.message?.slice(0, 200)}`);
      if (mode === "detect") {
        detectionSummaries.push(`🎬 ${vid.name || "video"}: โหลดไฟล์ไม่ได้ (${err.message?.slice(0, 80)})`);
      }
      continue;
    }

    // Sample a few frames purely for the vision-LLM's chronological context.
    let llmFrames = [];
    try {
      llmFrames = await extractVideoFrames(originalBuf, VIDEO_FRAMES_FOR_LLM);
      for (const f of llmFrames.slice(0, VIDEO_FRAMES_FOR_LLM)) {
        visionImageUrls.push(`data:image/jpeg;base64,${f.buffer.toString("base64")}`);
      }
    } catch (err) {
      console.warn(`[vision] LLM frame sampling failed: ${err.message?.slice(0, 200)}`);
    }

    if (mode !== "detect") {
      // Chat mode: just hand the original clip back to the user.
      if (originalBuf.length <= DISCORD_FILE_CAP) {
        annotatedAttachments.push({
          attachment: originalBuf,
          name: vid.name || `${baseName}.mp4`,
        });
      }
      continue;
    }

    // ── Detect mode: build an annotated MP4 ────────────────────────────
    const allClasses = new Map();
    let processedFrames = 0;
    let detectedFrames = 0;
    let annotatedBuf = null;

    try {
      const result = await annotateVideo(
        originalBuf,
        async (frameBuf) => {
          processedFrames++;
          try {
            const { detections, width, height } = await detectObjects(frameBuf);
            if (!detections.length) return null;
            detectedFrames++;
            for (const d of detections) {
              allClasses.set(d.class, (allClasses.get(d.class) || 0) + 1);
            }
            return await drawBoxes(frameBuf, detections, width, height);
          } catch (err) {
            console.warn(`[vision] frame annotate failed: ${err.message?.slice(0, 200)}`);
            return null;
          }
        },
        { maxFrames: 90, targetFpsCap: 6 },
      );
      annotatedBuf = result.buffer;
      console.log(
        `[vision] annotated video: ${result.frames} frames @ ${result.fps.toFixed(2)} fps, ${result.annotated} drawn, ${(annotatedBuf.length / 1024).toFixed(0)} KB`,
      );
    } catch (err) {
      console.warn(`[vision] annotateVideo failed: ${err.message?.slice(0, 200)}`);
    }

    // Pick the best video to attach: annotated (if it fits Discord) else original.
    if (annotatedBuf && annotatedBuf.length <= DISCORD_FILE_CAP) {
      annotatedAttachments.push({
        attachment: annotatedBuf,
        name: `yolo_${baseName}.mp4`,
      });
    } else if (originalBuf.length <= DISCORD_FILE_CAP) {
      annotatedAttachments.push({
        attachment: originalBuf,
        name: vid.name || `${baseName}.mp4`,
      });
    }

    const top = [...allClasses.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([cls, n]) => `${thaiLabel(cls)} ${n}`)
      .join(", ");
    const sampleNote = processedFrames > 0
      ? `(วิเคราะห์ ${processedFrames} เฟรม, เจอวัตถุ ${detectedFrames} เฟรม)`
      : "(วิเคราะห์เฟรมไม่สำเร็จ)";
    detectionSummaries.push(
      `🎬 ${vid.name || "video"} ${sampleNote} — รวม: ${top || "ไม่เจอวัตถุที่รู้จัก"}`,
    );
  }

  // ---- ASK VISION-LLM TO DESCRIBE / CHAT ----
  let descriptionText = "";
  if (visionImageUrls.length) {
    try {
      const hasVideo = media.videos.length > 0;
      const sequenceHint = hasVideo
        ? ` ภาพที่ส่งให้คือเฟรมจากวิดีโอเรียงตามเวลา (เฟรมแรก → เฟรมสุดท้าย) ใช้ลำดับนี้บรรยายการเคลื่อนไหวหรือเหตุการณ์ที่เกิดขึ้นในคลิป`
        : "";
      const systemExtra = mode === "detect"
        ? `Trigger: ${triggerReason}. ผู้ใช้ขอให้วิเคราะห์/ตรวจวัตถุในสื่อ. มีผล YOLO แนบมาให้ — สรุปสิ่งที่เห็นแบบกระชับ ไม่ต้องอ่านผล YOLO ซ้ำเพราะระบบจะแสดงให้แล้ว.${sequenceHint}`
        : `Trigger: ${triggerReason}. ผู้ใช้ส่งสื่อมาคุยเล่น/ขอความเห็น ไม่ได้สั่งให้สแกน. ตอบคุยเล่น เป็นกันเอง สั้น กระชับ มีคาแรกเตอร์ ไม่ต้องลิสต์วัตถุแบบรายงาน.${sequenceHint}`;
      const reply = await generateVisionReply({
        imageUrls: visionImageUrls.slice(0, 6),
        userText: cleanText || undefined,
        detectionContext: mode === "detect" ? detectionSummaries.join(" | ") : "",
        systemExtra,
      });
      descriptionText = (reply?.content || "").trim();
    } catch (err) {
      console.warn(`[vision] LLM describe failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // ---- COMPOSE FINAL REPLY ----
  const parts = [];
  if (descriptionText) parts.push(descriptionText);
  if (mode === "detect" && detectionSummaries.length) {
    parts.push("```\n🔎 YOLO detections\n" + detectionSummaries.join("\n") + "\n```");
  }
  const fallback = mode === "detect"
    ? "วิเคราะห์ภาพไม่ออกแฮะ ลองอีกที"
    : "ดูแล้วแต่นึกอะไรไม่ออก ลองพิมพ์อีกหน่อยสิ";
  const content = (parts.join("\n\n") || fallback).slice(0, 1900);

  try {
    await msg.reply({
      content,
      files: annotatedAttachments,
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.warn(`[vision] reply send failed: ${err.message}`);
    try {
      await channel.send({ content, files: annotatedAttachments });
    } catch {
      await safeReply(msg, content);
    }
  }
}

async function handleAgentOrChatReply(msg, triggerReason) {
  const author = msg.author;
  const channel = msg.channel;
  const guild = msg.guild;
  const member = msg.member;

  // Build conversational context — bigger window so the bot follows the
  // thread instead of replying in a vacuum.
  const recent = getRecent(channel.id);
  const ctxLines = recent
    .slice(-40)
    .map((m) => ({
      role: m.isBot ? "assistant" : "user",
      content: m.isBot ? m.content : `${m.author}: ${m.content}`,
    }));

  // Strip mention markup, but keep a list of mentioned users so the agent can
  // act on them directly (e.g. "ปิดไมค์ @Alex" works even after we strip "<@id>").
  const rawText = msg.content || "";
  const mentionedUsers = [...msg.mentions.users.values()]
    .filter((u) => u.id !== client.user.id) // ignore the bot's own mention
    .map((u) => {
      const m = guild.members.cache.get(u.id);
      return { id: u.id, name: m?.displayName || u.username };
    });
  let cleanText = rawText.replace(/<@!?\d+>/g, "").trim();
  if (!cleanText) cleanText = "(empty mention)";
  const userPrompt = mentionedUsers.length
    ? `${cleanText}\n\n[mentioned users in this message]: ${mentionedUsers.map((m) => `${m.name} (id: ${m.id})`).join(", ")}`
    : cleanText;

  await channel.sendTyping().catch(() => {});

  // Admin agent path — try first, but if it fails fall through to plain chat
  let attemptedAgent = false;
  if (isAdmin(member)) {
    attemptedAgent = true;
    try {
      const result = await runAgent({
        userPrompt,
        ctx: {
          guild,
          channel,
          authorTag: author.tag,
          authorId: author.id,
          offenses,
          persistOffenses: async () => persistOffenses(),
          // Pass the last 50 messages so the agent has rich conversation
          // memory — references like "ทำอีกที", "คนเดิม", "ห้องเดิม" work.
          chatHistory: recent.slice(-50).map((m) => ({
            author: m.author,
            authorId: m.authorId,
            content: m.content,
            isBot: !!m.isBot,
            at: m.at,
          })),
        },
      });
      const trimmed = (result || "").trim();
      if (trimmed) {
        await safeReply(msg, trimmed);
        return;
      }
      console.warn("[agent] returned empty — falling through to plain chat");
    } catch (err) {
      console.warn("[agent] failed:", err?.message?.slice(0, 200));
    }
  }

  // Plain chat reply (also used as fallback for failed admin agent)
  try {
    const reply = await generateReply({
      history: [
        ...ctxLines,
        { role: "user", content: `${author.username}: ${cleanText}` },
      ],
      systemExtra: attemptedAgent
        ? `Trigger: ${triggerReason}. (Admin agent path failed — just chat normally and tell them tools are temporarily unavailable if they were asking for an action.)`
        : `Trigger: ${triggerReason}. The user is NOT a server admin — do not perform actions, just chat.`,
      max_tokens: 350,
    });
    const text = (reply?.content || "").trim();
    if (text) {
      await safeReply(msg, text);
      return;
    }
    console.warn("[chat] empty reply content");
  } catch (err) {
    console.warn("[chat] reply failed:", err?.message?.slice(0, 200));
  }

  // Final fallback so the user always gets something
  await safeReply(msg, aiFallbackLine());
}

async function maybeSpontaneousChime(msg) {
  if (!aiAvailable()) return;
  if (msg.author.bot) return;
  const now = Date.now();
  const last = lastSpontaneousAt.get(msg.channel.id) || 0;
  if (now - last < SPONTANEOUS_COOLDOWN_MS) return;
  if (Math.random() > SPONTANEOUS_BASE_PROB) return;

  const recent = getRecent(msg.channel.id);
  if (recent.length < SPONTANEOUS_MIN_RECENT) return;
  const interested = await shouldEngage(recent);
  if (!interested) return;

  // Set cooldown BEFORE sending so a long generation doesn't spawn duplicates.
  lastSpontaneousAt.set(msg.channel.id, now);
  try {
    await msg.channel.sendTyping().catch(() => {});
    const reply = await generateReply({
      history: recent.slice(-25).map((m) => ({
        role: m.isBot ? "assistant" : "user",
        content: m.isBot ? m.content : `${m.author}: ${m.content}`,
      })),
      systemExtra:
        "You are spontaneously chiming in to an ongoing Discord chat — uninvited but welcome. Be witty, brief (1–2 short sentences), playful, and add real flavor. React, joke, agree, or gently push back. Don't quote, don't summarize. Just talk.",
      max_tokens: 200,
    });
    const text = (reply?.content || "").trim();
    if (text) await msg.channel.send({ content: text.slice(0, 500) });
    else lastSpontaneousAt.set(msg.channel.id, 0); // empty result — release cooldown
  } catch (err) {
    console.warn("[chime] failed:", err?.message?.slice(0, 200));
    lastSpontaneousAt.set(msg.channel.id, 0); // failed — release cooldown
  }
}

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!msg.guild) return;
    if (!config.guildId || msg.guild.id !== config.guildId) return;
    if (!msg.content) return;

    // Track ALL messages (including the bot's own replies) so the agent has
    // a faithful conversation log to reason over. Without this, when the
    // admin says "ทำอีกที" or "ใช่นั่นแหละ" the agent only sees its own
    // questions vanishing into a void.
    pushRecent(msg.channel.id, {
      author: msg.author.username,
      authorId: msg.author.id,
      content: msg.content.slice(0, 500),
      at: Date.now(),
      isBot: !!msg.author?.bot && msg.author?.id === client.user?.id,
    });

    // Bots (including ourselves) are tracked above but never moderated /
    // trigger the agent path.
    if (msg.author?.bot) return;

    // ===== EXISTING: legacy voice-mute on configured banned word (PRESERVED) =====
    const legacyWord = findBannedWord(msg.content);
    if (legacyWord) {
      await applyWordBan(msg.guild, msg.author.id, legacyWord, "chat");
      // Continue — also run new chat moderation to also delete + timeout text-side.
    }

    // ===== NEW: extended profanity detection (multi-language + AI) =====
    const detection = await detectProfanity({
      content: msg.content,
      extraWords: config.bannedWords,
      useAI: aiAvailable(),
    });
    if (detection.profane) {
      await handleProfanityChat(msg, detection);
      return;
    }

    // ===== NEW: AI reply when the bot is addressed =====
    const triggered = isBotTriggered(msg);
    if (triggered && aiAvailable()) {
      // If the message has image / video attachments, route through the
      // vision pipeline (YOLO + vision-LLM) instead of plain chat.
      const media = collectMediaAttachments(msg);
      if (media.images.length || media.videos.length) {
        try {
          await handleVisionReply(msg, triggered, media);
        } catch (err) {
          console.warn("[vision] handler crashed:", err?.message?.slice(0, 200));
          await handleAgentOrChatReply(msg, triggered);
        }
        return;
      }
      await handleAgentOrChatReply(msg, triggered);
      return;
    }

    // ===== NEW: spontaneous chime-in (rare, throttled) =====
    await maybeSpontaneousChime(msg);
  } catch (err) {
    console.error("[message] handler error", err?.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setting") {
        await handleSettingCommand(interaction, runtime);
        return;
      }
      if (interaction.commandName === "debug") {
        await handleDebugCommand(interaction, runtime);
        return;
      }
      if (isPrankCommand(interaction.commandName)) {
        await handlePrankSound(interaction, runtime, interaction.commandName);
        return;
      }
    }

    if (
      interaction.isButton() ||
      interaction.isAnySelectMenu?.() ||
      interaction.isModalSubmit()
    ) {
      const handled = await handleSettingComponent(interaction, runtime);
      if (handled) return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("alxcer-unmute:")
    ) {
      const targetUserId = interaction.customId.split(":")[1];
      if (interaction.user.id !== targetUserId) {
        await interaction.reply({
          content: "ปุ่มนี้สำหรับเจ้าของไมค์เท่านั้นครับ",
          ephemeral: true,
        });
        return;
      }
      if (wordBanTimers.has(targetUserId)) {
        const rec = offenses.users[targetUserId];
        const remaining = rec?.muteUntil
          ? Math.max(0, Math.round((rec.muteUntil - Date.now()) / 1000))
          : 0;
        await interaction.reply({
          content: `คุณถูกปิดไมค์เนื่องจากใช้คำต้องห้าม — รออีก ${formatDuration(remaining)}`,
          ephemeral: true,
        });
        return;
      }
      const guild = await client.guilds.fetch(config.guildId);
      const member = await guild.members.fetch(targetUserId);
      if (!member.voice.channel) {
        await interaction.reply({
          content: "คุณไม่ได้อยู่ในห้องเสียงตอนนี้",
          ephemeral: true,
        });
        return;
      }
      await member.voice.setMute(false, "Alxcer Guard: user requested unmute");

      const s = userState.get(targetUserId);
      if (s) {
        s.muted = false;
        s.warned = false;
        s.lastSpoke = Date.now();
        s.silentTicks = 0;
      }

      await interaction.reply({
        content: "✅ Unmute เรียบร้อย — พูดได้เลยครับ",
        ephemeral: true,
      });
      return;
    }

    // ===== Timer / alarm / sleep / wake-music buttons =====
    if (interaction.isButton()) {
      const cid = interaction.customId;

      // Cancel a regular timer or alarm
      if (cid.startsWith("alxcer-cancel-timer:")) {
        const id = cid.split(":")[1];
        const t = getTimer(id);
        if (!t) {
          await interaction.reply({ content: "ตัวจับเวลานี้หายไปแล้ว (ครบเวลา หรือถูกยกเลิกไปก่อนหน้านี้)", ephemeral: true });
          return;
        }
        cancelTimer(id);
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("❎ ยกเลิกแล้ว")
              .setDescription(`ยกเลิก **${t.label || t.type}** เรียบร้อย`),
          ],
          components: [],
        }).catch(() => {});
        return;
      }

      // Cancel a sleep mode (auto-disconnect)
      if (cid.startsWith("alxcer-cancel-sleep:")) {
        const id = cid.split(":")[1];
        const t = getTimer(id);
        if (!t) {
          await interaction.reply({ content: "Sleep mode นี้หมดอายุไปแล้ว", ephemeral: true });
          return;
        }
        // Only the targeted user (or an admin) can cancel
        if (interaction.user.id !== t.userId && !isAdmin(interaction.member)) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับเจ้าของ sleep mode เท่านั้น", ephemeral: true });
          return;
        }
        cancelTimer(id);
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🛌 ยกเลิก sleep mode แล้ว")
              .setDescription("ตื่นแล้วเหรอครับ — งั้นไม่เตะออกแล้ว"),
          ],
          components: [],
        }).catch(() => {});
        return;
      }

      // Cancel an auto-unmute and immediately un-mute the user
      if (cid.startsWith("alxcer-cancel-mute:")) {
        const id = cid.split(":")[1];
        const t = getTimer(id);
        if (!t) {
          await interaction.reply({ content: "ตัวจับเวลานี้หมดอายุไปแล้ว", ephemeral: true });
          return;
        }
        if (!isAdmin(interaction.member) && interaction.user.id !== t.ownerId) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับแอดมินหรือคนที่สั่ง mute เท่านั้น", ephemeral: true });
          return;
        }
        try {
          const guild = await client.guilds.fetch(t.guildId);
          const member = await guild.members.fetch(t.userId);
          if (member.voice?.channel) {
            await member.voice.setMute(false, "manual cancel via button");
          }
        } catch (err) {
          console.warn("[cancel-mute] unmute failed", err?.message);
        }
        cancelTimer(id);
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🔊 เปิดไมค์แล้ว")
              .setDescription("ปลด mute เรียบร้อยครับ"),
          ],
          components: [],
        }).catch(() => {});
        return;
      }

      // Stop a wake-alarm session
      if (cid.startsWith("alxcer-stop-alarm:")) {
        const id = cid.split(":")[1];
        const t = getTimer(id);
        const session = wakeSessions.get(id);
        // Either the user being woken or an admin can stop it
        if (t && interaction.user.id !== t.userId && !isAdmin(interaction.member)) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับคนที่ถูกปลุก (หรือแอดมิน) เท่านั้น", ephemeral: true });
          return;
        }
        if (session) {
          session.stop();
        }
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("✅ หยุดปลุกแล้ว")
              .setDescription("ตื่นแล้วเหรอครับ ขอให้เป็นวันที่ดีนะ ☀️"),
          ],
          components: [],
        }).catch(() => {});
        return;
      }

      // Snooze: stop the current alarm and re-create it +N minutes
      if (cid.startsWith("alxcer-snooze:")) {
        const parts = cid.split(":");
        const id = parts[1];
        const minutes = Number(parts[2]) || 5;
        const t = getTimer(id);
        const session = wakeSessions.get(id);
        if (t && interaction.user.id !== t.userId && !isAdmin(interaction.member)) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับคนที่ถูกปลุกเท่านั้น", ephemeral: true });
          return;
        }
        if (session) session.stop();
        const { createTimer: createTimerFn } = await import("./timers.js");
        const next = createTimerFn({
          type: t?.type === "wake_alarm" ? "wake_alarm" : "alarm",
          fireAt: Date.now() + minutes * 60 * 1000,
          label: `${t?.label || "Alarm"} (snooze ${minutes}น)`,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: t?.userId || interaction.user.id,
          mentionUserId: t?.mentionUserId || interaction.user.id,
          ownerId: t?.ownerId || interaction.user.id,
          payload: t?.payload || {},
        });
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0xf1c40f)
              .setTitle(`💤 Snooze ${minutes} นาที`)
              .setDescription(`เด๋วผมมาปลุกใหม่อีก ${minutes} นาที — ID ใหม่: \`${next.id}\``),
          ],
          components: [],
        }).catch(() => {});
        return;
      }
    }
  } catch (err) {
    console.error("[interaction] error", err?.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "เกิดข้อผิดพลาด", ephemeral: true })
        .catch(() => {});
    }
  }
});

async function shutdown(signal) {
  console.log(`[shutdown] received ${signal}`);
  if (pollHandle) clearInterval(pollHandle);
  if (audioFlushHandle) clearInterval(audioFlushHandle);
  if (timerHandle) clearInterval(timerHandle);
  // Stop any running wake-alarm sessions so the process can exit cleanly.
  for (const session of wakeSessions.values()) {
    try { session.stop(); } catch {}
  }
  wakeSessions.clear();
  for (const handle of wordBanTimers.values()) clearTimeout(handle);
  wordBanTimers.clear();
  try {
    await flushTranscripts();
    console.log("[shutdown] transcripts flushed");
  } catch (err) {
    console.error("[shutdown] transcript flush failed", err?.message);
  }
  for (const guildId of client.guilds.cache.keys()) {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
  }
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(TOKEN);
