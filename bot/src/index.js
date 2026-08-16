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
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
import {
  GuildRuntimeRegistry,
  disposeGuildRuntime,
  disposeUserSubscription,
  resetGuildReceiver,
} from "./guild-runtime.js";
import {
  cancelExpectedUnmute,
  clearMuteLease,
  consumeExpectedUnmute,
  createMuteLease,
  expectOwnedUnmute,
  flushMuteLeases,
  getMuteLease,
  listMuteLeases,
  loadMuteLeases,
  releaseMuteLease,
  setMuteLeaseRemotePersist,
} from "./mute-leases.js";
import { shouldMuteForInactivity } from "./inactivity-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GREETING_PATH = path.join(__dirname, "..", "assets", "greeting.mp3");
const PRANK_SOUNDS = {
  rung: path.join(__dirname, "..", "assets", "rung.mp3"),
  jinny: path.join(__dirname, "..", "assets", "jinny.mp3"),
  jan: path.join(__dirname, "..", "assets", "jan.mp3"),
};
import {
  getGuildConfig as resolveGuildConfig,
  loadConfigStore,
  setGuildConfig,
  toLegacyConfig,
  updateOwnerId,
  writeConfigStore,
} from "./config.js";
import {
  registerCommands,
  handleSettingCommand,
  handleSettingComponent,
  handleDebugCommand,
  handlePrankSound,
  isPrankCommand,
  handleAiCommand,
  handleAvatarCommand,
} from "./commands.js";
import {
  buildQuizFromAttachment,
  getActiveQuiz,
  setActiveQuiz,
  resetQuiz,
  getOrCreateProgress,
  getProgress,
  recordAnswer,
  jumpTo,
  submitFinal,
  resetUserProgress,
  listTakers,
  renderQuestion,
  renderResult,
  analyzeWeaknesses,
  buildReportEmbeds,
} from "./study.js";
import {
  startClass,
  stopClass,
  getClassByChannel,
  getClassByTeacher,
  listActive as listActiveClasses,
  takeExpired as takeExpiredClasses,
  removeClass,
} from "./classroom.js";
import {
  handleNotifyCommand,
  handleNotifyComponent,
  tickScheduler as tickNotifyScheduler,
} from "./notifications.js";
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
  commitConfig,
  commitOffenses,
  commitTranscripts,
  commitUpdateNotes,
  commitAutomations,
  commitTimers,
  commitMuteLeases,
} from "./github.js";
import {
  loadAutomations,
  allAutomations,
  getDueAutomations,
  markFiredAutomation,
  writeAutomationsLocal,
} from "./automations.js";
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
import { isAdmin, canManageBot, setOwnerId, runAgent, handleRolePanelButton } from "./agent.js";
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
  loadTimers,
  setRemotePersist as setTimerRemotePersist,
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

let configStore = loadConfigStore();
let config = toLegacyConfig(configStore);
if (configStore.ownerId) setOwnerId(configStore.ownerId);
const TOKEN = process.env.DISCORD_PERSONAL_ACCESS_TOKEN;
const VALIDATE_ONLY = process.argv.includes("--validate-only");

if (!TOKEN && !VALIDATE_ONLY) {
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

// Kept as a small compatibility seam while config.json migrates from the
// original single-guild shape to the v2 `guilds` map. Unknown guilds start in
// a safe mode: chat and explicit admin tools work, automatic moderation does
// not mutate members until an admin enables it for that guild.
function getConfigForGuild(guildId) {
  const key = guildId ? String(guildId) : "";
  return {
    ...resolveGuildConfig(configStore, key),
    guildId: key,
    ownerId: configStore.ownerId || "",
  };
}

const guildRuntimes = new GuildRuntimeRegistry();
const runtimeFor = (guildOrId) =>
  guildRuntimes.get(typeof guildOrId === "string" ? guildOrId : guildOrId?.id);

// Voice wake-word state. When a user says "การ์ด"/"guard" alone, we set their
// id here so the NEXT transcript from them (within WAKE_PENDING_MS) is treated
// as the actual command. Concurrent commands are rejected via wakeBusy.
const WAKE_PENDING_MS = 15_000;

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

let pollHandle = null;
let audioFlushHandle = null;
let timerHandle = null;
// Active wake-alarm sessions: timerId -> { stop: () => void, until: number }
const wakeSessions = new Map();
const botKickedUsers = new Set(); // `${guildId}:${userId}` recently disconnected by bot action
// Timestamp until which the bot's own TTS audio may echo back through room
// microphones. Any transcription arriving before this time is suppressed to
// prevent the bot from hearing itself and re-triggering the wake word.
const ECHO_SUPPRESS_MS = 3_500; // ms of suppression AFTER bot finishes speaking

const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_CHANNELS * 2;
// Lowered from 0.6 → 0.35 so a quick "การ์ด" (under 0.5s) still gets sent to
// whisper. Without this, single-word wake calls were dropped silently.
const MIN_UTTERANCE_SEC = 0.35;
const MAX_UTTERANCE_SEC = 5;
const IDLE_FLUSH_MS = 1500;

const offenses = loadOffenses();
loadAutomations();
loadTimers();
loadMuteLeases();
loadTranscriptsFromDisk();
if (canPersistRemotely()) {
  setTranscriptRemotePersist((data) => commitTranscripts(data));
  setTimerRemotePersist((data) => commitTimers(data));
  setMuteLeaseRemotePersist((data) => commitMuteLeases(data));
  console.log("[boot] transcripts will be persisted to repo (7-day retention, auto-prune)");
  console.log("[boot] active timers will be persisted to repo");
  console.log("[boot] mute ownership will be persisted to repo");
} else {
  console.log("[boot] transcripts kept in-memory only (no GITHUB_TOKEN to persist)");
  console.log("[boot] active timers kept local only (no GITHUB_TOKEN to persist)");
}
const wordBanTimers = new Map();
let offensesPersistTimer = null;

const guildUserKey = (guildId, userId) => `${guildId}:${userId}`;
const wordBanKey = guildUserKey;

function offenseKey(guildId, userId) {
  return guildUserKey(guildId, userId);
}

function getOffense(guildId, userId) {
  const scoped = offenses.users[offenseKey(guildId, userId)];
  if (scoped) return scoped;
  // One-time compatibility for the original primary guild's user-only keys.
  if (configStore.primaryGuildId === guildId) {
    return offenses.users[userId] || null;
  }
  return null;
}

async function unmuteOwnedLease(guild, member, expectedLeaseId, reason) {
  const current = getMuteLease(guild.id, member.id);
  if (!current || !expectedLeaseId || current.id !== String(expectedLeaseId)) {
    return { ok: false, code: current ? "lease_conflict" : "mute_not_owned" };
  }
  if (member.voice?.channel && member.voice.serverMute) {
    expectOwnedUnmute(guild.id, member.id, expectedLeaseId);
    try {
      await member.voice.setMute(false, reason);
    } catch (err) {
      cancelExpectedUnmute(guild.id, member.id, expectedLeaseId);
      throw err;
    }
  }
  const released = releaseMuteLease(guild.id, member.id, expectedLeaseId);
  if (released) return { ok: true };
  const replacement = getMuteLease(guild.id, member.id);
  if (replacement && member.voice?.channel) {
    await member.voice
      .setMute(true, `Alxcer Guard: preserving newer mute lease ${replacement.source}`)
      .catch(() => {});
  }
  return { ok: false, code: "lease_conflict" };
}

async function reconcilePersistedMuteLeases(guild) {
  for (const lease of listMuteLeases({ guildId: guild.id })) {
    const member = await guild.members.fetch(lease.userId).catch(() => null);
    if (!member?.voice?.channel || !member.voice.serverMute) {
      clearMuteLease(guild.id, lease.userId);
      continue;
    }
    if (lease.expiresAt && lease.expiresAt <= Date.now()) {
      await unmuteOwnedLease(
        guild,
        member,
        lease.id,
        `Alxcer Guard: expired persisted mute (${lease.source})`,
      ).catch((err) =>
        console.warn(`[mute-lease:${guild.id}] expired release failed`, err?.message),
      );
    }
  }
}

let configPersistQueue = Promise.resolve();

async function persistGuildConfig(guildId, next, message = "chore: update guild config") {
  const task = configPersistQueue
    .catch(() => {})
    .then(async () => {
      configStore = setGuildConfig(configStore, guildId, next);
      config = toLegacyConfig(configStore);
      client.config = config;
      writeConfigStore(configStore);
      if (canPersistRemotely()) await commitConfig(configStore, message);
      return getConfigForGuild(guildId);
    });
  configPersistQueue = task;
  return task;
}

const runtime = {
  getConfig: (guildId) => getConfigForGuild(guildId),
  persistConfig: (guildId, next) => persistGuildConfig(guildId, next),
  setConfig: (guildId, next) => {
    // commands.js v2 passes (guildId, next). Preserve the legacy single-arg
    // form until every caller has migrated.
    if (next === undefined) {
      next = guildId;
      guildId = next?.guildId;
    }
    configStore = setGuildConfig(configStore, guildId, next);
    config = toLegacyConfig(configStore);
    client.config = config;
    if (configStore.ownerId) setOwnerId(configStore.ownerId);
  },
  requestRejoin: (guildId) => {
    if (!guildId) return;
    client.guilds
      .fetch(guildId)
      .then((g) => reevaluateAndJoin(g))
      .catch((err) => console.error("[rejoin] error", err?.message));
  },
  transcriptionAvailable: () => transcriptionAvailable,
  getRecentTranscripts: (guildId, opts) => getRecentTranscripts({ ...opts, guildId }),
  getTranscriptStats: (guildId) => getTranscriptStats({ guildId }),
  getCursingStats: (guildId, opts) => getCursingStats({ ...opts, guildId }),
  playPrankSound: (guildId, name) => playPrankSound(guildId, name),
  markBotKick: (guildId, userId) => {
    if (!guildId || !userId) return;
    const key = guildUserKey(guildId, userId);
    botKickedUsers.add(key);
    setTimeout(() => botKickedUsers.delete(key), 8_000);
  },
  snapshot: (guildId) => {
    const rt = runtimeFor(guildId);
    const now = Date.now();
    const conn = getVoiceConnection(guildId);
    const connStatus = conn?.state?.status ?? "none";
    const allVoiceChannels = [];
    if (guildId) {
      const guild = client.guilds.cache.get(guildId);
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
      connected: !!rt.currentChannelId,
      connStatus,
      channelId: rt.currentChannelId,
      cryptoLib,
      transcription: transcriptionAvailable,
      transcribeStatus: getTranscribeStatus(),
      lastAnyAudioAge: Math.round((now - rt.lastAnyAudio) / 1000),
      allVoiceChannels,
      users: [...rt.userState.entries()].map(([id, s]) => ({
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
  const cfg = getConfigForGuild(guild.id);
  if (!cfg.notifyChannelId) return null;
  return guild.channels.cache.get(cfg.notifyChannelId) ?? null;
}

function canSendToChannel(channel, guild) {
  if (!channel?.isTextBased?.()) return false;
  const me = guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return (
    perms?.has(PermissionFlagsBits.ViewChannel) &&
    perms?.has(PermissionFlagsBits.SendMessages)
  );
}

async function findAnnouncementChannel(guild) {
  if (!guild) return null;
  const cfg = getConfigForGuild(guild.id);
  await guild.members.fetchMe().catch(() => null);
  if (cfg.notifyChannelId) {
    const configured = await guild.channels
      .fetch(cfg.notifyChannelId)
      .catch(() => null);
    if (canSendToChannel(configured, guild)) return configured;
    console.warn(
      `[announce] configured notify channel ${cfg.notifyChannelId} is unavailable or not sendable`,
    );
  }

  if (canSendToChannel(guild.systemChannel, guild)) return guild.systemChannel;

  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  for (const ch of channels.values()) {
    if (
      ch?.type === ChannelType.GuildText ||
      ch?.type === ChannelType.GuildAnnouncement
    ) {
      if (canSendToChannel(ch, guild)) return ch;
    }
  }
  return null;
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
  const cfg = getConfigForGuild(guild.id);
  if (cfg.voiceChannelId) {
    const pinned = guild.channels.cache.get(cfg.voiceChannelId);
    if (
      pinned &&
      (pinned.type === ChannelType.GuildVoice ||
        pinned.type === ChannelType.GuildStageVoice)
    ) {
      const humanCount = pinned.members.filter(
        (m) => !(cfg.ignoreBots && m.user.bot),
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
      (m) => !(cfg.ignoreBots && m.user.bot),
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
    lastPacketAt: 0,
    warned: false,
    muted: false,
    speaking: false,
    heardOnce: false,
    silentTicks: 0,
  };
}

function syncUserState(channel, rt = runtimeFor(channel.guild.id)) {
  const cfg = getConfigForGuild(channel.guild.id);
  const now = Date.now();
  const selfId = channel.client?.user?.id;
  for (const [, member] of channel.members) {
    if (selfId && member.id === selfId) continue; // Always exclude bot itself
    if (cfg.ignoreBots && member.user.bot) continue;
    if (!rt.userState.has(member.id)) {
      const s = newUserState(now);
      s.muted = member.voice?.serverMute ?? false; // Sync actual Discord mute state on join
      rt.userState.set(member.id, s);
    }
  }
}

function markHeard(rt, userId, source) {
  // Speaking start/end events are only flags and can fire without any
  // decodable audio. Only real packets prove that this user's receiver works.
  if (source !== "packet") return;
  const s = rt.userState.get(userId);
  if (!s) return;
  const wasHeard = s.heardOnce;
  s.lastSpoke = Date.now();
  s.lastPacketAt = s.lastSpoke;
  s.heardOnce = true;
  s.silentTicks = 0;
  if (s.warned) s.warned = false;
  if (source === "packet") {
    rt.lastAnyAudio = Date.now();
    if (!rt.receiverProven) {
      rt.receiverProven = true;
      console.log("[health] receiver PROVEN working — first real audio packet decoded");
    }
    if (rt.receiverHealthLogged) {
      console.log("[health] receiver recovered — audio flowing again");
      rt.receiverHealthLogged = false;
    }
  }
  if (!wasHeard) {
    console.log(`[voice] first audio confirmed from ${userId} via ${source}`);
  }
}

function appendPcm(rt, userId, pcm) {
  let buf = rt.audioBuffers.get(userId);
  if (!buf) {
    buf = { chunks: [], totalBytes: 0, lastAppendAt: 0 };
    rt.audioBuffers.set(userId, buf);
  }
  buf.chunks.push(pcm);
  buf.totalBytes += pcm.length;
  buf.lastAppendAt = Date.now();
  const maxBytes = PCM_BYTES_PER_SECOND * MAX_UTTERANCE_SEC;
  if (buf.totalBytes >= maxBytes) {
    flushUserAudio(rt, userId, "max-length");
  }
}

function flushUserAudio(rt, userId, reason) {
  const buf = rt.audioBuffers.get(userId);
  if (!buf || buf.chunks.length === 0) return;
  const pcm = Buffer.concat(buf.chunks);
  buf.chunks = [];
  buf.totalBytes = 0;
  const durationSec = pcm.length / PCM_BYTES_PER_SECOND;
  if (durationSec < MIN_UTTERANCE_SEC) return;
  if (!transcriptionAvailable) return;
  const enqueued = enqueueTranscription(
    pcm,
    handleVoiceTranscript,
    {
      guildId: rt.guildId,
      channelId: rt.currentChannelId,
      generation: rt.connectionGeneration,
      userId,
      durationSec,
      reason,
    },
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

  // Suppress transcription while bot is speaking (or within echo-decay window).
  // Without this, the bot's own TTS echoes through room mics → gets transcribed
  // → "การ์ด" in the TTS response re-triggers the wake word → infinite loop.
  if (!meta?.guildId) return;
  const rt = runtimeFor(meta.guildId);
  const cfg = getConfigForGuild(meta.guildId);
  if (
    meta.generation !== rt.connectionGeneration ||
    (meta.channelId && meta.channelId !== rt.currentChannelId)
  ) {
    console.log(`[transcribe] dropped stale completion guild=${meta.guildId} user=${meta.userId}`);
    return;
  }
  if (Date.now() < rt.botSpeakingUntil) {
    console.log(`[transcribe] suppressed — bot speaking/echo window user=${meta.userId} text="${trimmed.slice(0, 60)}"`);
    return;
  }

  console.log(
    `[transcribe] user=${meta.userId} dur=${meta.durationSec?.toFixed(1)}s text="${trimmed.slice(0, 200)}"`,
  );

  const word = findBannedWord(trimmed, cfg);

  let username = "";
  try {
    const guild = client.guilds.cache.get(meta.guildId);
    if (guild) {
      const member = guild.members.cache.get(meta.userId);
      if (member) username = member.user.username;
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

  const pending = rt.pendingWake.get(meta.userId);
  if (pending && Date.now() - pending.at < WAKE_PENDING_MS) {
    rt.pendingWake.delete(meta.userId);
    isWakeFlow = true;
    isFollowUp = true;
    // If the user re-said "การ์ด <cmd>" instead of just <cmd>, strip wake word
    const stripped = extractWakeCommand(trimmed);
    wakeCommand = stripped !== null ? stripped : trimmed;
  } else {
    rt.pendingWake.delete(meta.userId);
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
    guildId: meta.guildId,
    channelId: meta.channelId,
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
    await handleWakeCommand({
      guildId: meta.guildId,
      userId: meta.userId,
      username,
      command: wakeCommand,
      raw: trimmed,
      isFollowUp,
    }).catch((err) => console.error("[wake] handler failed", err?.message));
    return;
  }

  if (!word || cfg.voiceWordBanEnabled !== true) return;
  try {
    const guild = await client.guilds.fetch(meta.guildId);
    await applyWordBan(guild, meta.userId, word, "voice", trimmed);
  } catch (err) {
    console.error("[transcribe] wordban dispatch failed", err?.message);
  }
}

async function handleWakeCommand({ guildId, userId, username, command, raw, isFollowUp }) {
  if (!guildId) return;
  const rt = runtimeFor(guildId);
  const cfg = getConfigForGuild(guildId);
  if (rt.wakeBusy) {
    console.log(`[wake] busy — ignoring new wake from ${userId}`);
    return;
  }
  rt.wakeBusy = true;
  let conn = getVoiceConnection(guildId);
  let donePlayed = false;

  const playDone = async () => {
    if (donePlayed) return;
    donePlayed = true;
    try {
      const c = getVoiceConnection(guildId);
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
      rt.pendingWake.set(userId, { at: Date.now() });
      console.log(
        `[wake] user=${userId} acknowledged — awaiting command (${WAKE_PENDING_MS}ms)`,
      );
      setTimeout(() => {
        const p = rt.pendingWake.get(userId);
        if (p && Date.now() - p.at >= WAKE_PENDING_MS - 100) {
          rt.pendingWake.delete(userId);
          console.log(`[wake] user=${userId} pending timed out`);
        }
      }, WAKE_PENDING_MS + 100).unref?.();
      return;
    }

    console.log(`[wake] user=${userId} command="${command.slice(0, 200)}"`);

    const guild = await client.guilds.fetch(guildId).catch(() => null);
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

    if (replyChannel) await replyChannel.sendTyping().catch(() => {});

    let result = "";
    let errMsg = "";
    try {
      if (canManageBot(member)) {
        result = await runAgent({
          userPrompt: `[คำสั่งเสียงจาก ${username || userId}]: ${command}`,
          ctx: {
            guild,
            channel: replyChannel,
            authorTag: username || userId,
            authorId: userId,
            authorMember: member,
            ownerId: cfg.ownerId || config.ownerId || null,
            markBotKick: (targetId) => runtime.markBotKick(guild.id, targetId),
            voiceCommand: true,
            voiceConfirmed: /^(?:ยืนยัน(?:\s|[:,])|confirm\b)/i.test(command.trim()),
            offenses,
            persistOffenses: async () => persistOffenses(),
            chatHistory: [],
          },
        });
      } else {
        const reply = await generateReply({
          history: [{ role: "user", content: `${username || userId}: ${command}` }],
          systemExtra:
            "This came from a non-admin voice user. Chat naturally in Thai, but do not claim to run tools, access files, or change the Discord server.",
          max_tokens: 300,
        });
        result = _stripThink((reply?.content || "").trim());
      }
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
    rt.wakeBusy = false;
  }
}

function pickReplyChannel(guild) {
  const rt = runtimeFor(guild.id);
  const voiceChan = rt.currentChannelId ? guild.channels.cache.get(rt.currentChannelId) : null;
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

function subscribeUser(rt, receiver, userId) {
  if (rt.subscriptions.has(userId)) return;
  if (!rt.userState.has(userId)) return;
  if (rt.activeReceiver !== receiver) return;
  try {
    const sub = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const record = { stream: sub, decoder: null };
    rt.subscriptions.set(userId, record);
    sub.on("data", () => {
      if (rt.subscriptions.get(userId) === record && rt.activeReceiver === receiver) {
        markHeard(rt, userId, "packet");
      }
    });

    if (transcriptionAvailable) {
      const decoder = new prism.opus.Decoder({
        rate: PCM_SAMPLE_RATE,
        channels: PCM_CHANNELS,
        frameSize: 960,
      });
      sub.pipe(decoder);
      record.decoder = decoder;
      decoder.on("data", (pcm) => {
        if (rt.subscriptions.get(userId) === record && rt.activeReceiver === receiver) {
          appendPcm(rt, userId, pcm);
        }
      });
      decoder.on("error", (err) =>
        console.error("[opus] decode error", err?.message),
      );
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      disposeUserSubscription(rt, userId, record);
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

function runtimeFromConnection(connection) {
  return runtimeFor(connection?.joinConfig?.guildId);
}

async function playSoundFile(connection, filePath, label = "sound", timeoutMs = 30000) {
  const rt = runtimeFromConnection(connection);
  if (rt.playingFiles.has(filePath)) {
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
  rt.playingFiles.add(filePath);
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
    rt.playingFiles.delete(filePath);
  }
}

async function playGreeting(connection) {
  return await playSoundFile(connection, GREETING_PATH, "greet", 20000);
}

// channelId -> classObject — set by voiceStateUpdate when teacher joins.
// playJoinSignal consumes it (plays bell + TTS instead of greeting) so we
// avoid a race between startOfClassPlayback and reevaluateAndJoin's natural
// connect/destroy/rejoin cycle.
const pendingClassStart = new Map();

async function playJoinSignal(connection) {
  const cid = connection?.joinConfig?.channelId;
  const cfg = getConfigForGuild(connection?.joinConfig?.guildId);

  // If a teacher just joined this channel, play the class-start sequence
  // (bell + TTS) instead of greeting. This consumes the pending flag.
  if (cid && pendingClassStart.has(cid)) {
    const cls = pendingClassStart.get(cid);
    pendingClassStart.delete(cid);
    console.log(`[classroom] playJoinSignal → start-of-class for ${cid}`);
    await playClassStartSequence(connection).catch((err) =>
      console.error("[classroom] start sequence failed", err?.message),
    );
    return;
  }

  // Skip greeting entirely for channels marked as "silent join" (study/class rooms)
  if (cid && Array.isArray(cfg.silentJoinChannelIds) && cfg.silentJoinChannelIds.includes(cid)) {
    console.log(`[greet] silent-join channel ${cid} — skipping greeting`);
    return;
  }
  // A single short local beep is the only normal join greeting. It avoids
  // duplicate TTS/status spam and does not consume an external API credit.
  await playJoinBeep(connection);
}

async function playClassStartSequence(connection) {
  const bell = PRANK_SOUNDS.rung;
  const cfg = getConfigForGuild(connection?.joinConfig?.guildId);
  const ttsText = cfg.classStartTtsText ||
    "เริ่มคาบเรียนแล้ว ขอให้นักเรียนทุกท่านเตรียมตัวให้พร้อม และตั้งใจเรียน";
  try {
    await playSoundFile(connection, bell, "class-start-bell", 30_000);
    await new Promise((r) => setTimeout(r, 400));
    await speakThai(connection, ttsText, "class-start-tts");
  } catch (err) {
    console.error("[classroom:start] playback error", err?.message);
  }
}

async function playPrankSound(guildId, name) {
  const filePath = PRANK_SOUNDS[name];
  if (!filePath) {
    return { ok: false, reason: `ไม่รู้จักเสียง "${name}"` };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `ไม่พบไฟล์เสียง "${name}.mp3" ใน assets` };
  }
  if (!guildId) {
    return { ok: false, reason: "บอทยังไม่ได้ผูกกับเซิร์ฟเวอร์" };
  }
  const conn = getVoiceConnection(guildId);
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
  if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) {
    console.warn(`[${label}] no live voice connection — skipping`);
    return;
  }
  const rt = runtimeFromConnection(connection);
  if (rt.beepPlaying) {
    console.log(`[${label}] another beep already playing — skipping`);
    return;
  }
  rt.beepPlaying = true;
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
    rt.beepPlaying = false;
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
  const rt = runtimeFromConnection(connection);
  // Suppress transcription while bot is synthesizing + playing + echo-decay window.
  rt.botSpeakingUntil = Date.now() + 45_000;
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
  } finally {
    // After TTS finishes (or fails), add a short echo-decay window then release.
    rt.botSpeakingUntil = Date.now() + ECHO_SUPPRESS_MS;
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

function beginAuxiliaryVoiceMove(guildId) {
  const rt = runtimeFor(guildId);
  rt.auxiliaryVoiceDepth += 1;
  rt.connectionEpoch += 1;
  resetGuildReceiver(rt);
}

async function endAuxiliaryVoiceMove(guild) {
  const rt = runtimeFor(guild.id);
  rt.auxiliaryVoiceDepth = Math.max(0, rt.auxiliaryVoiceDepth - 1);
  if (rt.auxiliaryVoiceDepth > 0) return;
  rt.reevalQueued = false;
  await reevaluateAndJoin(guild).catch((err) =>
    console.warn(`[voice:${guild.id}] monitor restore failed`, err?.message),
  );
}

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
  const movedForPlayback = !sameChannel;
  if (!sameChannel) {
    beginAuxiliaryVoiceMove(guild.id);
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
      await endAuxiliaryVoiceMove(guild);
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
      if (movedForPlayback) await endAuxiliaryVoiceMove(guild);
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
  group_sleep:      { emoji: "🌙", color: 0x2c3e50, title: "Group sleep mode" },
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
  } else if (t.type === "group_sleep") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`alxcer-cancel-group-sleep:${t.id}`)
        .setStyle(ButtonStyle.Danger)
        .setLabel("🌙 ยกเลิก group sleep"),
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
      const cfg = getConfigForGuild(guild.id);
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
      const ttsText = cfg.wakeTtsText || "ขออนุญาตปลุกนะครับ ตื่นได้แล้วเด้อ";
      const musicUrl = cfg.wakeMusicUrl || "";
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


    if (t.type === "group_sleep") {
      // Disconnect ALL human voice members across every voice channel
      const allChannels = await guild.channels.fetch();
      const disconnected = [];
      const failed = [];
      for (const ch of allChannels.values()) {
        if (ch?.type !== ChannelType.GuildVoice) continue;
        for (const member of ch.members.values()) {
          if (member.user.bot) continue;
          try {
            await member.voice.disconnect("Group sleep mode");
            disconnected.push(member.displayName);
          } catch {
            failed.push(member.displayName);
          }
        }
      }
      let outcome;
      if (disconnected.length === 0) {
        outcome = "ℹ️ ไม่มีใครอยู่ในห้องเสียงเลยตอนนี้";
      } else {
        const names = disconnected.length <= 6
          ? disconnected.join(", ")
          : disconnected.slice(0, 6).join(", ") + ` +${disconnected.length - 6} คน`;
        outcome = `🌙 ส่งทุกคนนอนเรียบร้อย — เตะออก ${disconnected.length} คน\n> ${names}${failed.length > 0 ? `\n⚠️ เตะไม่สำเร็จ: ${failed.join(", ")}` : ""}`;
      }
      if (channel?.isTextBased?.()) {
        await channel.send({ embeds: [timerFiredEmbed(t, outcome)] }).catch(() => {});
      }
      deleteTimer(t.id);
      return;
    }

    if (t.type === "auto_unmute") {
      let member = null;
      try { member = await guild.members.fetch(t.userId); } catch {}
      let outcome = "ℹ️ ผู้ใช้ไม่อยู่แล้ว";
      const expectedLeaseId = t.payload?.leaseId || null;
      if (member && expectedLeaseId) {
        try {
          const released = await unmuteOwnedLease(
            guild,
            member,
            expectedLeaseId,
            "auto_unmute timer",
          );
          outcome = released.ok
            ? `🔊 เปิดไมค์ ${member.displayName} แล้ว`
            : `ℹ️ ไม่เปิดไมค์ เพราะ mute นี้ถูกแทนที่หรือไม่ได้เป็นของ Guard`;
        } catch (err) {
          outcome = `❌ เปิดไมค์ไม่สำเร็จ: ${err?.message?.slice(0, 100)}`;
        }
      } else if (member?.voice?.channel) {
        outcome = "ℹ️ ข้ามการเปิดไมค์: timer เก่าไม่มี mute lease";
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

async function tickAutomations(discordClient) {
  const due = getDueAutomations();
  if (!due.length) return;
  for (const auto of due) {
    markFiredAutomation(auto.id);
    try {
      writeAutomationsLocal(allAutomations());
      commitAutomations(allAutomations()).catch(() => {});
    } catch {}
    const guild = await discordClient.guilds.fetch(auto.guildId).catch(() => null);
    if (!guild) continue;
    const channel = await guild.channels.fetch(auto.channelId).catch(() => null);
    if (!channel) continue;
    const h = String(auto.hour).padStart(2,"0");
    const m = String(auto.minute).padStart(2,"0");
    try {
      await channel.send(`⏰ **Automation: ${auto.label}** (${h}:${m}) — กำลังทำงาน...`);
    } catch {}
    try {
      const result = await runAgent({
        userPrompt: auto.task,
        ctx: {
          guild,
          channel,
          authorTag: "automation",
          authorId: auto.createdBy || config.ownerId || "",
          ownerId: config.ownerId || null,
          offenses,
          persistOffenses: async () => persistOffenses(),
          chatHistory: [],
        },
      });
      if (result?.trim()) {
        try { await channel.send(result.slice(0, 2000)); } catch {}
      }
    } catch (err) {
      console.warn(`[automation:${auto.id}] run error:`, err?.message);
      try { await channel.send(`⚠️ Automation "${auto.label}" ล้มเหลว: ${err?.message?.slice(0,200)}`); } catch {}
    }
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
  const rt = runtimeFor(channel.guild.id);
  if (
    getVoiceConnection(channel.guild.id) !== connection ||
    connection.state?.status !== VoiceConnectionStatus.Ready ||
    connection.joinConfig?.channelId !== channel.id
  ) {
    return false;
  }
  const receiver = connection.receiver;
  resetGuildReceiver(rt);
  rt.activeReceiver = receiver;
  const generation = rt.connectionGeneration;

  // Reset silence timers so users aren't unfairly muted after a reconnect
  const _attachNow = Date.now();
  for (const _s of rt.userState.values()) {
    _s.lastSpoke = _attachNow;
    _s.lastPacketAt = 0;
    _s.heardOnce = false;
    _s.warned = false;
    _s.silentTicks = 0;
    _s.speaking = false; // reset stale speaking flag on receiver re-attach
  }

  receiver.speaking.on("start", (userId) => {
    if (rt.connectionGeneration !== generation || rt.activeReceiver !== receiver) return;
    rt.lastSpeakingFlag = Date.now();
    const s = rt.userState.get(userId);
    if (s) {
      s.speaking = true;
    }
    subscribeUser(rt, receiver, userId);
  });

  receiver.speaking.on("end", (userId) => {
    if (rt.connectionGeneration !== generation || rt.activeReceiver !== receiver) return;
    rt.lastSpeakingFlag = Date.now();
    const s = rt.userState.get(userId);
    if (s) {
      s.speaking = false;
    }
    flushUserAudio(rt, userId, "speaking-end");
  });

  for (const userId of rt.userState.keys()) {
    subscribeUser(rt, receiver, userId);
  }

  console.log(`[voice] receiver attached on #${channel.name}`);
  return true;
}

function isReceiverHealthy(connection, rt) {
  // A quiet room is healthy. Audio recency is not a connection health signal.
  return (
    !!connection &&
    connection.state?.status === VoiceConnectionStatus.Ready &&
    rt.activeReceiver === connection.receiver
  );
}

async function checkInactivity(guild) {
  const rt = runtimeFor(guild.id);
  const cfg = getConfigForGuild(guild.id);
  if (!rt.currentChannelId) return;
  const channel = guild.channels.cache.get(rt.currentChannelId);
  if (!channel) return;

  const now = Date.now();

  const _selfId = channel.client?.user?.id;
  for (const [, member] of channel.members) {
    if (_selfId && member.id === _selfId) continue; // Always exclude bot itself
    if (cfg.ignoreBots && member.user.bot) continue;
    if (!rt.userState.has(member.id)) {
      rt.userState.set(member.id, newUserState(now));
      console.log(`[track] added ${member.user.tag}`);
    }
  }
  for (const userId of [...rt.userState.keys()]) {
    if (!channel.members.has(userId)) {
      rt.userState.delete(userId);
      disposeUserSubscription(rt, userId);
      console.log(`[track] removed ${userId}`);
    }
  }

  const conn = getVoiceConnection(guild.id);
  const connStatus = conn?.state?.status ?? "none";

  if (conn?.joinConfig?.channelId !== rt.currentChannelId) return;

  if (conn && connStatus !== VoiceConnectionStatus.Destroyed) {
    if (rt.activeReceiver !== conn.receiver) {
      console.log(`[voice] receiver changed — re-attaching`);
      await attachReceiver(conn, channel);
    }
  }

  if (!isReceiverHealthy(conn, rt)) {
    if (!rt.receiverHealthLogged) {
      console.warn(
        `[health] voice connection is not Ready (state=${connStatus}) — pausing inactivity decisions`,
      );
      rt.receiverHealthLogged = true;
    }
    return;
  }
  rt.receiverHealthLogged = false;

  // Automatic inactivity muting is intentionally opt-in. New/unknown guilds
  // monitor and accept explicit admin commands without changing voice state.
  if (cfg.inactivityMuteEnabled !== true) return;

  for (const [userId, s] of rt.userState) {
    const member = channel.members.get(userId);
    if (!member) continue;

    if (wordBanTimers.has(wordBanKey(guild.id, userId))) {
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

    // Never infer silence for a user whose decoder has not produced a packet.
    if (!s.heardOnce || !s.lastPacketAt) continue;

    const silentFor = (now - s.lastPacketAt) / 1000;
    s.silentTicks = silentFor >= cfg.warningSeconds ? s.silentTicks + 1 : 0;

    if (!s.warned && silentFor >= cfg.warningSeconds) {
      s.warned = true;
      console.log(
        `[warn] ${member.user.tag} silent for ${silentFor.toFixed(0)}s`,
      );
      const remaining = Math.max(
        0,
        Math.round(cfg.muteSeconds - silentFor),
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

    if (shouldMuteForInactivity({
      enabled: cfg.inactivityMuteEnabled,
      state: s,
      voice: member.voice,
      now,
      muteSeconds: cfg.muteSeconds,
    })) {
      try {
        await member.voice.setMute(true, "Alxcer Guard: inactive in voice");
        const lease = createMuteLease({
          guildId: guild.id,
          userId,
          source: "inactivity",
        });
        s.muted = true;
        console.log(
          `[mute] ${member.user.tag} (silent ${silentFor.toFixed(0)}s)`,
        );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`alxcer-unmute:${userId}:${lease.id}`)
            .setLabel("🎙️ Unmute ตัวเอง")
            .setStyle(ButtonStyle.Success),
        );
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("🔇 ขออนุญาตปิดเสียงนะครับ")
          .setDescription(
            `<@${userId}> คุณถูกปิดไมค์อัตโนมัติเนื่องจากเงียบนานเกิน ${cfg.muteSeconds} วินาที\n\n` +
              `ปุ่มปลดไมค์จะทำงานเฉพาะคำสั่งล่าสุดของ Guard เท่านั้น`,
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
  const rt = runtimeFor(guild.id);
  if (rt.auxiliaryVoiceDepth > 0) {
    rt.reevalQueued = true;
    return;
  }
  if (rt.joining) {
    rt.reevalQueued = true;
    return;
  }
  rt.joining = true;
  try {
    const cfg = getConfigForGuild(guild.id);
    let target = pickBestVoiceChannel(guild);
    // In automatic mode stay with the current populated room. Constantly
    // chasing the largest room caused reconnect churn and repeated join beeps.
    if (!cfg.voiceChannelId && rt.currentChannelId) {
      const current = guild.channels.cache.get(rt.currentChannelId);
      const humans = current?.members?.filter(
        (member) => !(cfg.ignoreBots && member.user.bot),
      ).size ?? 0;
      if (humans > 0) target = current;
    }

    if (!target) {
      const existing = getVoiceConnection(guild.id);
      if (existing) {
        console.log("[voice] no humans in any channel, leaving");
        safeDestroy(existing);
      }
      disposeGuildRuntime(rt);
      return;
    }

    if (rt.currentChannelId === target.id) {
      const existing = getVoiceConnection(guild.id);
      if (
        existing &&
        existing.joinConfig?.channelId === target.id &&
        existing.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        if (existing.state.status === VoiceConnectionStatus.Ready) {
          rt.notReadySince = 0;
          syncUserState(target, rt);
          if (rt.activeReceiver !== existing.receiver) {
            await attachReceiver(existing, target);
          }
          return;
        }
        if (!rt.notReadySince) rt.notReadySince = Date.now();
        if (Date.now() - rt.notReadySince < 90_000) return;
        console.warn(
          `[voice:${guild.id}] connection stayed ${existing.state.status} for 90s — replacing`,
        );
      }
    }

    const existing = getVoiceConnection(guild.id);
    resetGuildReceiver(rt);
    rt.connectionEpoch += 1;
    const connectionEpoch = rt.connectionEpoch;
    rt.currentChannelId = target.id;
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
      if (
        getVoiceConnection(guild.id) !== connection ||
        rt.connectionEpoch !== connectionEpoch
      ) return;
      console.log("[voice] disconnected — attempting reconnect");
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (
          getVoiceConnection(guild.id) !== connection ||
          rt.connectionEpoch !== connectionEpoch
        ) return;
        console.log("[voice] real disconnect — destroying & will rejoin next tick");
        rt.connectionEpoch += 1;
        safeDestroy(connection);
        rt.currentChannelId = null;
        rt.notReadySince = 0;
        resetGuildReceiver(rt);
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
      rt.notReadySince ||= Date.now();
      return;
    }

    if (
      getVoiceConnection(guild.id) !== connection ||
      connection.joinConfig?.channelId !== target.id ||
      rt.currentChannelId !== target.id ||
      rt.connectionEpoch !== connectionEpoch
    ) return;

    syncUserState(target, rt);
    rt.notReadySince = 0;
    rt.receiverHealthLogged = false;

    await attachReceiver(connection, target);
    console.log(`[voice] monitoring #${target.name}`);

    playJoinSignal(connection).catch((err) =>
      console.error("[greet] join greeting failed:", err?.message),
    );
  } finally {
    rt.joining = false;
    if (rt.reevalQueued) {
      rt.reevalQueued = false;
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

function findBannedWord(text, cfg = config) {
  if (!text || !Array.isArray(cfg.bannedWords)) return null;
  const lower = text.toLowerCase();
  for (const word of cfg.bannedWords) {
    if (!word) continue;
    const wl = word.toLowerCase();
    // Very short words (<=3 chars, e.g. "หี"): require word-boundary so ASR
    // mishearing "หมี" -> "หี" or similar Thai syllables don't false-ban.
    // Longer phrases ("ดูหี", "ขอดูหี"): substring is fine — distinctive enough.
    if (wl.length <= 3) {
      if (lower === wl ||
          lower.startsWith(wl + " ") ||
          lower.endsWith(" " + wl) ||
          lower.includes(" " + wl + " ")) {
        return word;
      }
    } else if (lower.includes(wl)) {
      return word;
    }
  }
  return null;
}

function scheduleWordBanUnmute(guild, userId, durationMs, leaseId = null) {
  const key = wordBanKey(guild.id, userId);
  const existing = wordBanTimers.get(key);
  if (existing) clearTimeout(existing.handle || existing);
  const handle = setTimeout(async () => {
    const current = wordBanTimers.get(key);
    if (!current || (current.handle || current) !== handle) return;
    wordBanTimers.delete(key);
    let released = false;
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && current.leaseId) {
        const result = await unmuteOwnedLease(
          guild,
          member,
          current.leaseId,
          "Alxcer Guard: word-ban expired",
        );
        released = result.ok;
      }
      if (released) {
        console.log(`[wordban] unmuted ${member.user.tag} after timer`);
      }
    } catch (err) {
      console.error("[wordban] auto-unmute failed", err?.message);
    }
    const rec = getOffense(guild.id, userId);
    if (rec) {
      rec.muteUntil = 0;
      rec.muteLeaseId = null;
      persistOffenses();
    }
    const s = runtimeFor(guild.id).userState.get(userId);
    if (s) {
      s.muted = false;
      s.warned = false;
      s.lastSpoke = Date.now();
      s.silentTicks = 0;
    }
  }, Math.max(1_000, durationMs));
  wordBanTimers.set(key, { handle, leaseId });
}

async function restorePendingWordBans(guild) {
  const now = Date.now();
  const prefix = `${guild.id}:`;
  let changed = false;
  for (const [storedKey, rec] of Object.entries(offenses.users)) {
    const isScoped = storedKey.startsWith(prefix);
    const isLegacyPrimary = !storedKey.includes(":") &&
      configStore.primaryGuildId === guild.id;
    if (!isScoped && !isLegacyPrimary) continue;
    const userId = isScoped ? storedKey.slice(prefix.length) : storedKey;
    if (!rec || !rec.muteUntil || rec.muteUntil <= now) continue;
    const remaining = rec.muteUntil - now;
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      let leaseId = null;
      if (member.voice.channel && !member.voice.serverMute) {
        try {
          await member.voice.setMute(true, "Alxcer Guard: pending word-ban");
          const lease = createMuteLease({
            guildId: guild.id,
            userId,
            source: "word-ban:restore",
            expiresAt: rec.muteUntil,
          });
          leaseId = lease.id;
          rec.muteLeaseId = lease.id;
          changed = true;
        } catch {}
      } else if (member.voice.channel && member.voice.serverMute) {
        const current = getMuteLease(guild.id, userId);
        if (current?.source?.startsWith("word-ban:")) leaseId = current.id;
      }
      scheduleWordBanUnmute(guild, userId, remaining, leaseId);
      console.log(
        `[wordban] restored mute for ${member.user.tag}, ~${Math.round(remaining / 1000)}s left`,
      );
    } catch (err) {
      console.error("[wordban] restore failed", err?.message);
    }
  }
  if (changed) persistOffenses();
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
  if (!userId) { console.warn("[wordban] userId undefined, skipping"); return; }
  const cfg = getConfigForGuild(guild.id);
  const storedKey = offenseKey(guild.id, userId);
  const prev = getOffense(guild.id, userId) ?? {
    count: 0,
    lastOffenseAt: 0,
    muteUntil: 0,
    lastWord: "",
  };

  const newCount = (prev.count || 0) + 1;
  const isFirst = newCount <= 1;
  const muteSec = isFirst
    ? cfg.firstOffenseMuteSeconds
    : cfg.repeatOffenseMuteSeconds;

  offenses.users[storedKey] = {
    count: newCount,
    lastOffenseAt: Date.now(),
    muteUntil: Date.now() + muteSec * 1000,
    lastWord: word,
    lastSource: source,
    muteLeaseId: null,
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
      const existingLease = getMuteLease(guild.id, userId);
      if (member.voice.serverMute && !existingLease) {
        muteError = "ผู้ใช้อยู่ใต้ server-mute ของแอดมินอื่น — Guard จะไม่ยึดสิทธิ์ mute นี้";
      } else {
        if (!member.voice.serverMute) {
          await member.voice.setMute(
            true,
            `Alxcer Guard: banned word "${word}" via ${source} (#${newCount})`,
      );
      return;
    }

    if (
      getVoiceConnection(guild.id) !== connection ||
      connection.joinConfig?.channelId !== target.id ||
      rt.currentChannelId !== target.id
    ) return;
        const lease = createMuteLease({
          guildId: guild.id,
          userId,
          source: `word-ban:${source}`,
          expiresAt: Date.now() + muteSec * 1000,
        });
        offenses.users[storedKey].muteLeaseId = lease.id;
        persistOffenses();
        muteApplied = true;
        scheduleWordBanUnmute(guild, userId, muteSec * 1000, lease.id);
      }
      const s = runtimeFor(guild.id).userState.get(userId);
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
    scheduleWordBanUnmute(guild, userId, muteSec * 1000, null);
  }
  if (!wordBanTimers.has(wordBanKey(guild.id, userId))) {
    scheduleWordBanUnmute(guild, userId, muteSec * 1000, null);
  }

  const sourceLabel = source === "voice" ? "พูดในห้องเสียง" : "พิมพ์ในแชท";
  const durationLabel = formatDuration(muteSec);
  const title = isFirst
    ? `⚠️ คำเตือน — ${sourceLabel}`
    : `🚫 ทำผิดซ้ำ — ${sourceLabel}`;
  const color = isFirst ? 0xfacc15 : 0xef4444;
  const memberForAnn = await guild.members.fetch(userId).catch(() => null);
  const displayForAnn = memberForAnn?.displayName || userId;
  const lines = [userId ? `<@${userId}> (**${displayForAnn}**) ใช้คำต้องห้าม \`${word}\`` : `ใช้คำต้องห้าม \`${word}\``, ""];
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
      ? `*ครั้งแรก: ปิดไมค์ ${formatDuration(cfg.firstOffenseMuteSeconds)} — ครั้งต่อไป: ${formatDuration(cfg.repeatOffenseMuteSeconds)}*`
      : `*ทำผิดครั้งที่ ${newCount} — โดนเต็มอัตราโทษ ${formatDuration(cfg.repeatOffenseMuteSeconds)}*`,
  );

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join("\n"));

  await announce(guild, { content: `<@${userId}>`, embeds: [embed] });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[ready] logged in as ${c.user.tag}`);

  // Auto-detect the bot owner from the Discord token itself.
  //
  // DISCORD_PERSONAL_ACCESS_TOKEN is a *user* token — the account that logged
  // in IS the owner. c.user.id is their Discord ID directly.
  //
  // Fallback for bot tokens: try /oauth2/applications/@me (no "Bot " prefix
  // for user tokens; tries both). Whichever succeeds first wins.
  try {
    let detectedOwnerId = null;
    let detectedName = null;

    // Path A: user/personal token — logged-in account = owner
    // c.user is available right here in the ClientReady handler
    if (c.user && !c.user.bot) {
      // Self-bot / personal token: the account IS the owner
      detectedOwnerId = c.user.id;
      detectedName = c.user.tag || c.user.username;
    } else {
      // Path B: proper bot token — ask Discord who owns the application
      // Try without "Bot " prefix first (user token style), then with it
      for (const authHeader of [`${TOKEN}`, `Bot ${TOKEN}`]) {
        try {
          const appRes = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
            headers: { Authorization: authHeader },
          });
          if (appRes.ok) {
            const app = await appRes.json();
            detectedOwnerId = app.team ? app.team.owner_user_id : app.owner?.id;
            detectedName = app.owner?.username ?? app.team?.name ?? "unknown";
            break;
          }
        } catch {}
      }
    }

    if (detectedOwnerId) {
      const changed = configStore.ownerId !== detectedOwnerId;
      configStore = updateOwnerId(configStore, detectedOwnerId);
      config = toLegacyConfig(configStore);
      client.config = config;
      setOwnerId(detectedOwnerId);
      if (changed) {
        writeConfigStore(configStore);
      }
      console.log(`[boot] owner: ${detectedName} (id=${detectedOwnerId}) — full admin trust granted`);
    } else {
      console.warn("[boot] could not detect owner ID — set config.ownerId manually if needed");
    }
  } catch (err) {
    console.warn("[boot] owner auto-detect error:", err?.message);
  }

  try {
    await registerCommands(client);
  } catch (err) {
    console.error("[commands] register failed", err?.message);
  }
  // ── Post update announcement if update_notes.json has pending notes ──────────
  try {
    const notesPath = path.join(__dirname, "..", "update_notes.json");
    if (fs.existsSync(notesPath)) {
      const notes = JSON.parse(fs.readFileSync(notesPath, "utf8"));
      if (notes.pending && Array.isArray(notes.notes) && notes.notes.length) {
        const guild = config.guildId ? await client.guilds.fetch(config.guildId).catch(() => null) : null;
        const notifyCh = guild && config.notifyChannelId
          ? await guild.channels.fetch(config.notifyChannelId).catch(() => null)
          : null;
        if (notifyCh?.isTextBased?.()) {
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🤖 Alxcer Guard อัพเดทแล้ว!")
            .setDescription(notes.notes.join("\n"))
            .setFooter({ text: `v${notes.version || "?"} · ${notes.updatedAt || ""} · ✅ บอทพร้อมใช้งาน` })
            .setTimestamp();
          await notifyCh.send({ embeds: [embed] });
          console.log("[boot] posted update announcement to", config.notifyChannelId);
        }
        // Clear pending flag and commit back so next restart doesn't re-post
        const cleared = { ...notes, pending: false };
        fs.writeFileSync(notesPath, JSON.stringify(cleared, null, 2) + "\n");
        commitUpdateNotes(cleared).catch((e) => console.warn("[boot] commitUpdateNotes failed:", e?.message));
      }
    }
  } catch (err) {
    console.warn("[boot] update announcement failed:", err?.message);
  }

  try {
    const guilds = [...client.guilds.cache.values()];
    await Promise.allSettled(
      guilds.map(async (guild) => {
        runtimeFor(guild.id);
        await reevaluateAndJoin(guild);
        await reconcilePersistedMuteLeases(guild);
        await restorePendingWordBans(guild);
      }),
    );
    console.log(`[ready] initialized ${guilds.length} guild runtime(s)`);

    pollHandle = setInterval(async () => {
      const work = [...client.guilds.cache.values()].map(async (guild) => {
        await reevaluateAndJoin(guild);
        await checkInactivity(guild);
      });
      const results = await Promise.allSettled(work);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[loop] guild error", result.reason?.message);
        }
      }
    }, 30_000);

    audioFlushHandle = setInterval(() => {
      if (!transcriptionAvailable) return;
      const now = Date.now();
      for (const rt of guildRuntimes.values()) {
        for (const [uid, buf] of rt.audioBuffers) {
          if (buf.totalBytes > 0 && now - buf.lastAppendAt > IDLE_FLUSH_MS) {
            flushUserAudio(rt, uid, "idle");
          }
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

    // Automation tick — every 60s. Fires recurring tasks at scheduled Bangkok time.
    setInterval(() => {
      tickAutomations(client).catch(err => console.error("[automations] tick error", err?.message));
    }, 60_000);

    // Scheduled notifications tick — every 30s. Items fire once per day at
    // their configured Asia/Bangkok time.
    setInterval(() => {
      for (const guild of client.guilds.cache.values()) {
        const cfg = getConfigForGuild(guild.id);
        tickNotifyScheduler({
          client,
          guildId: guild.id,
          defaultChannelId: cfg.notifyChannelId,
        }).catch((err) => console.error(`[notify:${guild.id}] tick error`, err?.message));
      }
    }, 30_000);

    // Classroom end-of-class tick — every 15s. When a class timer expires,
    // the bot joins the voice channel, plays the bell + TTS announcement +
    // bell, then leaves.
    setInterval(() => {
      const expired = takeExpiredClasses();
      for (const cls of expired) {
        endOfClassPlayback(cls).catch((err) =>
          console.error("[classroom] end playback error", err?.message),
        ).finally(() => removeClass(cls.channelId));
      }
    }, 15_000);

    setInterval(() => {
      for (const rt of guildRuntimes.values()) {
        if (!rt.currentChannelId) continue;
        const lines = [];
        for (const [uid, s] of rt.userState) {
          const age = Math.round((Date.now() - s.lastSpoke) / 1000);
          lines.push(
            `${uid} heard=${s.heardOnce} speak=${s.speaking} silent=${age}s warn=${s.warned} mute=${s.muted}`,
          );
        }
        console.log(`[stats:${rt.guildId}] ${lines.length} tracked\n  ` + lines.join("\n  "));
      }
    }, 30_000);
  } catch (err) {
    console.error("[ready] guild init failed", err?.message);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  runtimeFor(guild.id);
  try {
    await reevaluateAndJoin(guild);
    await reconcilePersistedMuteLeases(guild);
    await restorePendingWordBans(guild);
    console.log(`[guild] initialized ${guild.id}`);
  } catch (err) {
    console.error(`[guild:${guild.id}] initialize failed`, err?.message);
  }
});

client.on(Events.GuildDelete, (guild) => {
  safeDestroy(getVoiceConnection(guild.id));
  guildRuntimes.delete(guild.id);
  for (const lease of listMuteLeases({ guildId: guild.id })) {
    clearMuteLease(guild.id, lease.userId);
  }
  console.log(`[guild] removed runtime ${guild.id}`);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  const rt = runtimeFor(guild.id);
  const cfg = getConfigForGuild(guild.id);
  if (newState.member?.id === client.user?.id) return;
  if (oldState.member?.id === client.user?.id) return;

  const userId = newState.member?.id ?? oldState.member?.id;
  const banKey = userId ? wordBanKey(guild.id, userId) : null;
  if (userId && oldState.serverMute && !newState.serverMute) {
    const expected = consumeExpectedUnmute(guild.id, userId);
    if (!expected) {
      clearMuteLease(guild.id, userId);
      const rec = getOffense(guild.id, userId);
      if (rec?.muteLeaseId) {
        rec.muteLeaseId = null;
        persistOffenses();
      }
    }
  }
  if (userId && rt.userState.has(userId)) {
    const wasMuted = oldState.selfMute || oldState.serverMute;
    const isMuted = newState.selfMute || newState.serverMute;
    if (wasMuted && !isMuted) {
      const s = rt.userState.get(userId);
      s.lastSpoke = Date.now();
      s.warned = false;
      s.muted = false;
      s.silentTicks = 0;
      console.log(`[voice] ${newState.member.user.tag} unmuted — timer reset`);
    }
  }

  if (userId && wordBanTimers.has(banKey)) {
    const wasInVoice = !!oldState.channelId;
    const nowInVoice = !!newState.channelId;
    if (!wasInVoice && nowInVoice) {
      try {
        const member = newState.member;
        if (member && !member.voice.serverMute) {
          await member.voice.setMute(true, "Alxcer Guard: word-ban active");
          const rec = getOffense(guild.id, userId);
          const lease = createMuteLease({
            guildId: guild.id,
            userId,
            source: "word-ban:join",
            expiresAt: rec?.muteUntil || null,
          });
          const timer = wordBanTimers.get(banKey);
          if (timer) timer.leaseId = lease.id;
          if (rec) {
            rec.muteLeaseId = lease.id;
            persistOffenses();
          }
          console.log(`[wordban] applied mute on join for ${member.user.tag}`);
        }
      } catch (err) {
        console.error("[wordban] join-mute failed", err?.message);
      }
    }
  }

  // ===== Voice room join/leave/move/kick announcements =====
  {
    const _vsaMember = newState.member ?? oldState.member;
    if (_vsaMember && !_vsaMember.user?.bot) {
      const _wasIn = !!oldState.channelId;
      const _nowIn = !!newState.channelId;
      const _name = _vsaMember.displayName || _vsaMember.user?.username || userId;
      const _avatar = _vsaMember.user?.displayAvatarURL?.({ size: 64 }) || undefined;
      const _guild = newState.guild || oldState.guild;
      let _voiceEmbed = null;

      if (!_wasIn && _nowIn) {
        _voiceEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setAuthor({ name: _name, iconURL: _avatar })
          .setTitle("🟢 เข้าห้องเสียง")
          .setDescription(`<@${userId}> เข้าร่วมห้อง **${newState.channel?.name ?? "unknown"}**`)
          .setTimestamp(new Date());
        console.log(`[voice-track] JOIN: ${_name} → ${newState.channel?.name}`);
      } else if (_wasIn && !_nowIn) {
        const _kickKey = guildUserKey(guild.id, userId);
        const _wasKicked = botKickedUsers.has(_kickKey);
        if (_wasKicked) botKickedUsers.delete(_kickKey);
        _voiceEmbed = new EmbedBuilder()
          .setColor(_wasKicked ? 0xe74c3c : 0x95a5a6)
          .setAuthor({ name: _name, iconURL: _avatar })
          .setTitle(_wasKicked ? "⛔ โดนเตะออกจากห้อง" : "🔴 ออกจากห้องเสียง")
          .setDescription(_wasKicked
            ? `<@${userId}> ถูกเตะออกจากห้อง **${oldState.channel?.name ?? "unknown"}** โดยระบบ`
            : `<@${userId}> ออกจากห้อง **${oldState.channel?.name ?? "unknown"}**`)
          .setTimestamp(new Date());
        console.log(`[voice-track] ${_wasKicked ? "KICK" : "LEAVE"}: ${_name} ← ${oldState.channel?.name}`);
      } else if (_wasIn && _nowIn && oldState.channelId !== newState.channelId) {
        _voiceEmbed = new EmbedBuilder()
          .setColor(0xf39c12)
          .setAuthor({ name: _name, iconURL: _avatar })
          .setTitle("🔀 ย้ายห้องเสียง")
          .setDescription(`<@${userId}> ย้ายจากห้อง **${oldState.channel?.name ?? "unknown"}** ➜ **${newState.channel?.name ?? "unknown"}**`)
          .setTimestamp(new Date());
        console.log(`[voice-track] MOVE: ${_name}: ${oldState.channel?.name} → ${newState.channel?.name}`);
      }

      if (_voiceEmbed && cfg.notifyChannelId) {
        announce(_guild, { embeds: [_voiceEmbed] }).catch(() => {});
      }
    }
  }

  // ===== Classroom: teacher join → start 1h class; teacher leave → cancel =====
  try {
    if (cfg.teacherRoleId && newState.member) {
      const isTeacher = newState.member.roles?.cache?.has(cfg.teacherRoleId);
      if (isTeacher) {
        const wasIn = !!oldState.channelId;
        const nowIn = !!newState.channelId;
        const teacherId = newState.member.id;
        const guildId = newState.guild.id;

        // Joined a voice channel (or moved to a different one) → start a fresh class
        if (nowIn && oldState.channelId !== newState.channelId) {
          // If teacher had a class running in old channel, cancel it
          if (wasIn) {
            pendingClassStart.delete(oldState.channelId);
            const old = getClassByChannel(oldState.channelId);
            if (old && old.teacherId === teacherId) {
              stopClass(oldState.channelId);
            }
          }
          const cls = startClass({
            guildId,
            channelId: newState.channelId,
            teacherId,
            durationMinutes: cfg.classDurationMinutes || 60,
          });
          console.log(
            `[classroom] start: teacher ${newState.member.user.tag} in ${newState.channel?.name} for ${cfg.classDurationMinutes}m`,
          );
          announceClassStart(newState.guild, cls, newState.channel, newState.member).catch(() => {});
          // Mark this channel as "pending class start" so the next playJoinSignal
          // call from reevaluateAndJoin plays bell+TTS instead of greeting.
          pendingClassStart.set(newState.channelId, cls);
        }

        // Left voice entirely → cancel class
        if (wasIn && !nowIn) {
          pendingClassStart.delete(oldState.channelId);
          const cls = getClassByTeacher(guildId, teacherId);
          if (cls) {
            stopClass(cls.channelId);
            pendingClassStart.delete(cls.channelId);
            console.log(`[classroom] cancelled — teacher ${newState.member.user.tag} left voice`);
            announceClassCancel(newState.guild, cls, newState.member).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.error("[classroom] voiceState hook error", err?.message);
  }

  try {
    await reevaluateAndJoin(newState.guild);
    // Fallback: if the bot was already connected to the same channel,
    // reevaluateAndJoin won't call playJoinSignal — fire the start sequence
    // directly so the bell still plays.
    if (newState.channelId && pendingClassStart.has(newState.channelId)) {
      const conn = getVoiceConnection(newState.guild.id);
      if (conn && conn.joinConfig?.channelId === newState.channelId) {
        pendingClassStart.delete(newState.channelId);
        playClassStartSequence(conn).catch((err) =>
          console.error("[classroom] fallback start sequence failed", err?.message),
        );
      }
    }
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
const lastReplyResponseAt = new Map(); // channelId → timestamp, prevents reply-chain loops
const SPONTANEOUS_COOLDOWN_MS = 90 * 1000;
const SPONTANEOUS_BASE_PROB = 0.07; // 7% chance per qualifying msg (reduced from 18%)
const SPONTANEOUS_MIN_RECENT = 4; // need at least 4 msgs before chiming

function isBotTriggered(msg) {
    // Direct mention of the bot user
    if (client.user && msg.mentions?.users?.has(client.user.id)) return "mention";
    // Reply to one of the bot's messages — only if meaningful + not in cooldown (prevents reply loops)
    if (msg.reference?.messageId) {
      const _ref = msg.channel.messages?.cache?.get(msg.reference.messageId);
      if (_ref?.author?.id === client.user?.id) {
        const _txt = (msg.content || "").replace(/<@!?\d+>/g, "").trim();
        const _words = _txt.split(/\s+/).filter(Boolean).length;
        const _hasQ = _txt.includes("?") || /ไหม|มั้ย|อะไร|ยังไง|ทำไม|เมื่อไร|กี่|ใคร|ที่ไหน|อย่างไร|หรือเปล่า/.test(_txt);
        if (_words < 3 && !_hasQ) return null; // skip "ok", "55555", "อ่อ", short reactions
        const _lastReply = lastReplyResponseAt.get(msg.channel.id) || 0;
        if (Date.now() - _lastReply < 60_000) return null; // 60s cooldown per channel
        return "reply";
      }
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
  if (!msg.author?.id) { console.warn("[profanity] msg.author undefined, skipping"); return; }
  const userId = msg.author.id;
  const guild = msg.guild;
  const storedUserId = offenseKey(guild.id, userId);
  // Existing chat-offense count (with 7-day decay)
  const prevCount = getOffenseCount(offenses, storedUserId);
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
  const newCount = recordOffense(offenses, storedUserId, {
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
    const memberForRoast = await msg.guild.members.fetch(userId).catch(() => null);
    const displayForRoast = memberForRoast?.displayName || msg.author.globalName || msg.author.username || userId;
    roast = await generateRoastReply({
      userId: userId,
      matched: detection.matched ?? "คำหยาบ",
      severity: detection.severity ?? 7,
    });
  } catch {
    roast = `<@${userId}> โดน timeout ${formatHumanDuration(seconds)} เพราะใช้คำหยาบครับ`;
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

function _stripThink(text) {
  if (typeof text !== "string") return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/^[\s\S]*?<\/think>\s*/i, "");
  out = out.replace(/<think>[\s\S]*/i, "");
  out = out.replace(/<\/?think>/gi, "");
  return out.trim();
}

const _lastSentByChannel = new Map(); // channelId -> last text sent

async function safeReply(msg, content) {
  if (!content) return;
  const key = msg.channel?.id;
  if (key && _lastSentByChannel.get(key) === content.trim()) {
    console.warn("[safeReply] dedup: identical to last sent, skipping");
    return;
  }
  if (key) _lastSentByChannel.set(key, content.trim());
  content = _stripThink(content);
  // Auto-trim: if reply is very long (wall-of-text), cut at last sentence boundary ≤600 chars
  if (content && content.length > 600) {
    const cutoff = content.slice(0, 600);
    const lastPeriod = Math.max(cutoff.lastIndexOf("。"), cutoff.lastIndexOf("ๆ "), cutoff.lastIndexOf(". "), cutoff.lastIndexOf("! "), cutoff.lastIndexOf("? "), cutoff.lastIndexOf("ค่ะ"), cutoff.lastIndexOf("ครับ"), cutoff.lastIndexOf("นะ"), cutoff.lastIndexOf("\n"));
    content = lastPeriod > 300 ? content.slice(0, lastPeriod + 1).trim() : cutoff.trim();
  }
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
      descriptionText = _stripThink((reply?.content || "").trim());
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

// ─── Real-time AI thinking embed ─────────────────────────────────────────────
const TOOL_LABEL = {
  // Web / OpenClaw
  web_search:       "🔍 ค้นหาเว็บ",
  fetch_url:        "📄 เปิด URL",
  wikipedia:        "📚 Wikipedia",
  get_weather:      "🌤️ ดูอากาศ",
  run_code:         "💻 รันโค้ด",
  deploy_webpage:   "🌐 Deploy เว็บ",
  read_own_log:     "📋 อ่าน Log",
  read_own_source:  "📁 อ่านซอร์ส",
  write_own_source: "✍️ แก้โค้ด + Repush",
  generate_image:       "🎨 สร้างรูป AI",
  setup_role_panel:     "🎭 สร้างปุ่มรับยศ",
  stylize_text:         "✨ แปลงฟอนต์",
  beautify_server:      "🌸 ตกแต่งทุกห้อง",
  set_channel_permissions: "🔒 ตั้งสิทธิ์ห้อง",
  full_server_setup:    "🏗️ Setup เซิร์ฟเวอร์",
  get_avatar:        "🖼️ ขยายรูปโปรไฟล์",
  // Discord tools
  voice_mute:        "🔇 ปิดไมค์",
  voice_unmute:      "🎙️ เปิดไมค์",
  voice_disconnect:  "🚪 เตะออก",
  voice_move:        "🚀 ย้ายห้อง",
  voice_mute_many:   "🔇 ปิดไมค์หลายคน",
  voice_unmute_many: "🎙️ เปิดไมค์หลายคน",
  set_timer:         "⏱️ ตั้งตัวจับเวลา",
  set_group_sleep:   "🌙 ตั้ง group sleep mode",
  set_alarm:         "⏰ ตั้งปลุก",
  list_timers:       "📋 ดูตัวจับเวลา",
  cancel_timer:      "❌ ยกเลิกตัวจับเวลา",
  ban_user:          "🔨 แบน",
  kick_user:         "👢 เตะ",
  timeout_user:      "🕐 Timeout",
  mute_user_for:     "🔇 ปิดไมค์ชั่วคราว",
  send_dm:           "✉️ ส่ง DM",
  lock_channel:      "🔒 ล็อคห้อง",
  set_slowmode:      "🐢 Slowmode",
  create_thread:     "🧵 สร้าง Thread",
  resolve_user:      "🔎 หาข้อมูล User",
  resolve_channel:   "🔎 หาข้อมูล Channel",
  get_server_info:   "📊 ดู Server Info",
  send_message:      "💬 ส่งข้อความ",
  bulk_delete_messages: "🗑️ ลบข้อความ",
  set_self_disconnect: "😴 Sleep Mode",
  get_recent_messages: "💬 ดูประวัติแชท",
};

function buildThinkingEmbed(steps, startedAt) {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const lines = steps.map((s, i) => {
    const label = TOOL_LABEL[s.tool] || `🔧 ${s.tool}`;
    const isLast = i === steps.length - 1;
    const icon = isLast ? "🔄" : "✅";
    const preview = s.preview ? ` \`${s.preview}\`` : "";
    return `${icon} **${label}**${preview}`;
  });
  return new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle("🤖 กำลังคิด...")
    .setDescription(lines.join("\n") || "_เริ่มประมวลผล..._")
    .setFooter({ text: `⏱️ ผ่านไป ${elapsed}s · OpenClaw AI Agent` });
}

// Simple arg preview for common tools (safe for Discord display)
function toolArgPreview(toolName, args) {
  if (!args || typeof args !== "object") return "";
  switch (toolName) {
    case "web_search":    return (args.query || "").slice(0, 40);
    case "fetch_url":     return (args.url || "").slice(0, 40);
    case "wikipedia":     return (args.topic || "").slice(0, 40);
    case "get_weather":   return args.city || "";
    case "run_code":      return args.language || "";
    case "deploy_webpage":return args.filename || "";
    case "read_own_source": return args.filepath || "";
    case "write_own_source": return args.filepath || "";
    case "read_own_log":  return args.filter ? `filter: ${args.filter}` : `${args.lines || 100} lines`;
    case "voice_mute": case "voice_unmute": case "voice_disconnect": return "";
    case "send_dm":       return "";
    case "resolve_user":  return args.query || "";
    case "resolve_channel": return args.query || "";
    default: return "";
  }
}

async function handleAgentOrChatReply(msg, triggerReason, media = null) {
  const author = msg.author;
  const channel = msg.channel;
  const guild = msg.guild;
  const cfg = getConfigForGuild(guild.id);
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
  // Include image URLs if provided (for Claude Vision / image search)
  const imageUrls = (media?.images || []).map((img) => img.url).filter(Boolean);
  const imageSection = imageUrls.length
    ? `\n\n[ภาพที่แนบมา ${imageUrls.length} รูป]:\n${imageUrls.map((u, i) => `รูปที่ ${i + 1}: ${u}`).join("\n")}\n\n[หมายเหตุ: ถ้าผู้ใช้ส่งรูปมาพร้อมคำถาม ให้ใช้ tool analyze_image เพื่อวิเคราะห์รูปและค้นหาข้อมูลที่เกี่ยวข้อง]`
    : "";
  const userPrompt = mentionedUsers.length
    ? `${cleanText}\n\n[mentioned users in this message]: ${mentionedUsers.map((m) => `${m.name} (id: ${m.id})`).join(", ")}${imageSection}`
    : `${cleanText}${imageSection}`;

  await channel.sendTyping().catch(() => {});

  // Admin agent path — try first, but if it fails fall through to plain chat
  let attemptedAgent = false;
  const canUseAgent = canManageBot(member);
  console.log('[agent] checking isAdmin for', author.tag, '| allowed:', canUseAgent, '| member perms bitfield:', member?.permissions?.bitfield?.toString(16));
  if (canUseAgent) {
    attemptedAgent = true;
    // Real-time thinking display
    let thinkingMsg = null;
    const thinkingSteps = [];
    const thinkingStartedAt = Date.now();
    const onToolCall = async (toolName, args) => {
      thinkingSteps.push({ tool: toolName, preview: toolArgPreview(toolName, args) });
      const embed = buildThinkingEmbed(thinkingSteps, thinkingStartedAt);
      try {
        if (!thinkingMsg) {
          thinkingMsg = await channel.send({ embeds: [embed] });
        } else {
          await thinkingMsg.edit({ embeds: [embed] });
        }
      } catch {}
    };
    const agentCtx = {
        guild,
        channel,
        authorTag: author.tag,
        authorDisplayName: member?.displayName || author.globalName || author.username,
        authorId: author.id,
        authorMember: member,
        offenses,
        persistOffenses: async () => persistOffenses(),
        ownerId: cfg.ownerId || config.ownerId || null,
        markBotKick: (targetId) => runtime.markBotKick(guild.id, targetId),
        chatHistory: recent.slice(-50).map((m) => ({
          author: m.author,
          authorId: m.authorId,
          content: m.content,
          isBot: !!m.isBot,
          at: m.at,
        })),
      };
    try {
      const result = await runAgent({
        userPrompt,
        onToolCall,
        ctx: agentCtx,
      });
      // Delete thinking embed and show final answer
      if (thinkingMsg) {
        await thinkingMsg.delete().catch(() => {});
        thinkingMsg = null;
      }
      const trimmed = _stripThink((result || "").trim());
      // If tool already sent a message (_toolSentMessage), keep reply short
      if (agentCtx._toolSentMessage && trimmed && trimmed.length > 20) {
        // Skip long echoes after tools that already sent to channel
      } else if (trimmed) {
        await safeReply(msg, trimmed);
      }
      return; // Agent ran — don't fall through to plain chat regardless of result
    } catch (err) {
      if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
      console.warn("[agent] failed:", err?.message?.slice(0, 200));
      // Exception only → fall through to plain chat below
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
      // 500 tokens leaves headroom for a real 3–5 sentence answer when the
      // user asks an actual question (vs. just "hi"). Replies still trend
      // short because PERSONA caps casual chat at 1–2 sentences.
      max_tokens: 500,
    });
    const text = _stripThink((reply?.content || "").trim());
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
    if (text) { const _ct = _stripThink(text); if (_ct) await msg.channel.send({ content: _ct.slice(0, 500) }); }
    else lastSpontaneousAt.set(msg.channel.id, 0); // empty result — release cooldown
  } catch (err) {
    console.warn("[chime] failed:", err?.message?.slice(0, 200));
    lastSpontaneousAt.set(msg.channel.id, 0); // failed — release cooldown
  }
}

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!msg.guild) return;
    const cfg = getConfigForGuild(msg.guild.id);
    if (!msg.content) return;

    // Track ALL messages (including the bot's own replies) so the agent has
    // a faithful conversation log to reason over. Without this, when the
    // admin says "ทำอีกที" or "ใช่นั่นแหละ" the agent only sees its own
    // questions vanishing into a void.
    const _trackedMember = msg.guild?.members?.cache?.get(msg.author.id);
    const _trackedName = _trackedMember?.displayName || msg.author.globalName || msg.author.username;
    pushRecent(msg.channel.id, {
      author: _trackedName,
      authorId: msg.author.id,
      content: msg.content.slice(0, 500),
      at: Date.now(),
      isBot: !!msg.author?.bot && msg.author?.id === client.user?.id,
    });

    // Bots (including ourselves) are tracked above but never moderated /
    // trigger the agent path.
    if (msg.author?.bot) return;

    // ===== EXISTING: legacy voice-mute on configured banned word (PRESERVED) =====
    const legacyWord = findBannedWord(msg.content, cfg);
    if (legacyWord && cfg.chatVoiceMuteEnabled === true) {
      await applyWordBan(msg.guild, msg.author.id, legacyWord, "chat");
      return; // Stop here — don't also run extended profanity (prevents double message)
    }

    // Extended chat moderation is opt-in per guild. This gates both the
    // local word matcher and the LLM path; a newly joined guild must never
    // delete/timeout people before an admin enables the feature.
    if (cfg.aiModerationEnabled === true) {
      const detection = await detectProfanity({
        content: msg.content,
        extraWords: cfg.bannedWords,
        useAI: aiAvailable(),
      });
      if (detection.profane) {
        await handleProfanityChat(msg, detection);
        return;
      }
    }

    // ===== NEW: AI reply when the bot is addressed =====
    const triggered = isBotTriggered(msg);
    if (triggered && aiAvailable()) {
      if (triggered === "reply") lastReplyResponseAt.set(msg.channel.id, Date.now());
      // If the message has image / video attachments, route through the
      // vision pipeline (YOLO + vision-LLM) instead of plain chat.
      const media = collectMediaAttachments(msg);
      if (media.images.length || media.videos.length) {
        // รูป/วิดีโอ → vision pipeline เสมอ (YOLO + Vision-LLM เห็นภาพจริง)
        // ไม่ว่าจะมีข้อความหรือไม่ก็ตาม — agent ไม่มี tool วิเคราะห์รูปจริง
        try {
          await handleVisionReply(msg, triggered, media);
        } catch (err) {
          console.warn("[vision] handler crashed:", err?.message?.slice(0, 200));
          await handleAgentOrChatReply(msg, triggered, media);
        }
        return;
      }
      await handleAgentOrChatReply(msg, triggered);
      return;
    }

    // ===== NEW: spontaneous chime-in (rare, throttled) =====
    if (cfg.spontaneousChatEnabled === true) {
      await maybeSpontaneousChime(msg);
    }
  } catch (err) {
    console.error("[message] handler error", err?.message);
  }
});

// ─── /study command + button handlers ────────────────────────────────────────

async function announceStudyAvailable(guildId, quiz, byUserId) {
  const cfg = getConfigForGuild(guildId);
  if (!cfg.notifyChannelId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const ch = await guild.channels.fetch(cfg.notifyChannelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setTitle("📚 มีข้อสอบใหม่!")
      .setDescription(
        `<@${byUserId}> ได้อัพไฟล์ **${quiz.fileName}** และให้บอทสร้างข้อสอบ **${quiz.questions.length} ข้อ** แล้ว\n\n` +
          `▶️ พิมพ์ \`/study\` แล้วกดปุ่ม **เริ่มทำข้อสอบ** ได้เลย — ทุกคนทำชุดเดียวกัน คะแนนของแต่ละคนเป็นของส่วนตัว`,
      );
    const content = cfg.studentRoleId ? `📣 <@&${cfg.studentRoleId}> มีข้อสอบใหม่!` : "";
    await ch.send({
      content,
      embeds: [embed],
      allowedMentions: cfg.studentRoleId
        ? { roles: [cfg.studentRoleId] }
        : { parse: [] },
    });
  } catch (err) {
    console.error("[study] announce failed", err?.message);
  }
}

function buildStudyPanel(guildId) {
  const quiz = getActiveQuiz(guildId);
  const takers = quiz ? listTakers(guildId) : [];
  const submitted = takers.filter((t) => t.submitted);
  const inProgress = takers.filter((t) => !t.submitted);

  const lines = [];
  if (quiz) {
    lines.push(`📂 **ไฟล์:** \`${quiz.fileName}\``);
    lines.push(`❓ **จำนวนข้อ:** ${quiz.questions.length}`);
    lines.push(`👤 **อัพโดย:** <@${quiz.createdBy}>`);
    lines.push("");
    lines.push(`✅ ส่งแล้ว: **${submitted.length} คน**`);
    if (submitted.length) {
      const top = submitted
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 10)
        .map((t) => `• <@${t.userId}> — ${t.score}/${t.outOf}`)
        .join("\n");
      lines.push(top);
    }
    if (inProgress.length) {
      lines.push(`\n🟡 กำลังทำ: **${inProgress.length} คน**`);
    }
  } else {
    lines.push("_ยังไม่มีข้อสอบ — แอดมินกดปุ่ม **📤 อัพไฟล์** เพื่อสร้าง_");
  }

  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle("📚 โหมดเรียนหนังสือ — Study Mode")
    .setDescription(lines.join("\n").slice(0, 4000))
    .setFooter({
      text: quiz
        ? "กด ▶️ เริ่มทำข้อสอบ ได้เลย — ทุกคนทำชุดเดียวกันแบบส่วนตัว"
        : "เริ่มต้น: แอดมินกด 📤 อัพไฟล์ เพื่อให้บอทสร้างข้อสอบ",
    });

  // Row 1 — for everyone
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("study:start")
      .setLabel("▶️ เริ่มทำข้อสอบ")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!quiz),
    new ButtonBuilder()
      .setCustomId("study:status")
      .setLabel("📊 ดูสถานะ + คะแนน")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!quiz),
    new ButtonBuilder()
      .setCustomId("study:refresh")
      .setLabel("🔄 รีเฟรช")
      .setStyle(ButtonStyle.Secondary),
  );

  // Row 2 — admin actions
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("study:upload-info")
      .setLabel("📤 อัพไฟล์ (แอดมิน)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("study:report")
      .setLabel("📑 รายงานครู (AI)")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!quiz || !submitted.length),
    new ButtonBuilder()
      .setCustomId("study:reset-confirm")
      .setLabel("🗑️ รีเซ็ตข้อสอบ")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!quiz),
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function handleStudyCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "ใช้ในเซิร์ฟเวอร์เท่านั้น", ephemeral: true });
    return;
  }
  await interaction.reply({ ...buildStudyPanel(guildId), ephemeral: true });
}

async function handleStudyUploadCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "ใช้ในเซิร์ฟเวอร์เท่านั้น", ephemeral: true });
    return;
  }
  if (!canManageBot(interaction.member, interaction.memberPermissions)) {
    await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
    return;
  }
  const att = interaction.options.getAttachment("file", true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const quiz = await buildQuizFromAttachment(att, { createdBy: interaction.user.id });
    setActiveQuiz(guildId, quiz);
    await interaction.editReply({
      content: `✅ สร้างข้อสอบ **${quiz.questions.length} ข้อ** จากไฟล์ \`${quiz.fileName}\` แล้ว — พิมพ์ \`/study\` เปิดหน้ากดปุ่มได้เลย`,
    });
    announceStudyAvailable(guildId, quiz, interaction.user.id).catch(() => {});
  } catch (err) {
    console.error("[study-upload] error", err?.message);
    await interaction.editReply({ content: `❌ สร้างข้อสอบไม่สำเร็จ: ${err?.message ?? "unknown"}` });
  }
}

// Legacy slash subcommand handler kept temporarily for back-compat with
// any user that still has the old /study cached — falls back to panel.
async function _legacy_handleStudyCommandSubcommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "ใช้ในเซิร์ฟเวอร์เท่านั้น", ephemeral: true });
    return;
  }

  if (sub === "start") {
    const quiz = getActiveQuiz(guildId);
    if (!quiz) {
      await interaction.reply({
        content: "ยังไม่มีข้อสอบ — แอดมินยังไม่ได้อัพไฟล์ (ใช้ `/study upload`)",
        ephemeral: true,
      });
      return;
    }
    const progress = getOrCreateProgress(guildId, interaction.user.id, quiz.id);
    if (progress.submitted) {
      await interaction.reply({
        content: "คุณส่งคำตอบไปแล้ว — รอแอดมิน reset หรืออัพข้อสอบใหม่ ถ้าอยากทำใหม่ให้กดปุ่ม 🔁 ทำใหม่ ในผลคะแนน",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ ...renderQuestion(quiz, progress), ephemeral: true });
    return;
  }

  if (sub === "status") {
    const quiz = getActiveQuiz(guildId);
    if (!quiz) {
      await interaction.reply({ content: "ยังไม่มีข้อสอบ", ephemeral: true });
      return;
    }
    const takers = listTakers(guildId);
    const submitted = takers.filter((t) => t.submitted);
    const inProgress = takers.filter((t) => !t.submitted);
    const lines = [
      `📚 ไฟล์: \`${quiz.fileName}\``,
      `จำนวนข้อ: **${quiz.questions.length}**`,
      `สร้างโดย: <@${quiz.createdBy}>`,
      "",
      `**ส่งแล้ว (${submitted.length} คน):**`,
      submitted.length
        ? submitted
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .map((t) => `• <@${t.userId}> — ${t.score}/${t.outOf}`)
            .join("\n")
        : "_ยังไม่มี_",
      "",
      `**กำลังทำ (${inProgress.length} คน):**`,
      inProgress.length
        ? inProgress.map((t) => `• <@${t.userId}> — ตอบ ${t.answered}/${quiz.questions.length}`).join("\n")
        : "_ยังไม่มี_",
    ];
    await interaction.reply({
      content: lines.join("\n").slice(0, 1900),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === "report") {
    if (!canManageBot(interaction.member, interaction.memberPermissions)) {
      await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const cfg = getConfigForGuild(guildId);
      const report = await analyzeWeaknesses(guildId);
      const payload = buildReportEmbeds(report, { teacherRoleId: cfg.teacherRoleId });
      // Send to notify channel so teachers can see it
      let target = null;
      if (cfg.notifyChannelId) {
        const guild = await client.guilds.fetch(guildId);
        target = await guild.channels.fetch(cfg.notifyChannelId).catch(() => null);
      }
      if (target?.isTextBased?.()) {
        await target.send(payload);
        await interaction.editReply({ content: `✅ ส่งรายงานให้${cfg.teacherRoleId ? "ยศครู" : "ห้องแจ้งเตือน"}แล้ว (จากผู้ส่งคำตอบ ${report.submitters} คน)` });
      } else {
        // No notify channel configured — just dump in the reply
        await interaction.editReply({
          content: `⚠️ ยังไม่ได้ตั้งห้องแจ้งเตือน — แสดงให้ดูตรงนี้แทน`,
          embeds: payload.embeds,
        });
      }
    } catch (err) {
      console.error("[study:report] error", err?.message);
      await interaction.editReply({ content: `❌ ${err?.message ?? "unknown"}` });
    }
    return;
  }

  if (sub === "reset") {
    if (!canManageBot(interaction.member, interaction.memberPermissions)) {
      await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
      return;
    }
    const had = !!getActiveQuiz(guildId);
    resetQuiz(guildId);
    await interaction.reply({
      content: had ? "🗑️ ลบข้อสอบเรียบร้อย" : "ไม่มีข้อสอบให้ลบอยู่แล้ว",
      ephemeral: true,
    });
    return;
  }
}

async function handleStudyButton(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const cid = interaction.customId;
  const parts = cid.split(":");
  const action = parts[1];

  // ── Panel-level buttons (work even when quiz isn't loaded) ──
  try {
    if (action === "refresh" || action === "upload-info") {
      if (action === "upload-info") {
        await interaction.reply({
          content:
            "📤 **วิธีอัพโหลดข้อสอบ**\n" +
            "พิมพ์ `/study-upload file:` แล้วเลือกไฟล์ `.docx`, `.xlsx`, `.pptx`, หรือ `.txt` (≤10MB)\n" +
            "บอทจะอ่านเนื้อหา → สร้างข้อสอบให้อัตโนมัติ → ทุกคนพิมพ์ `/study` กดเริ่มทำได้เลย",
          ephemeral: true,
        });
        return true;
      }
      await interaction.update(buildStudyPanel(guildId));
      return true;
    }

    if (action === "status") {
      await interaction.reply({ ...buildStudyPanel(guildId), ephemeral: true });
      return true;
    }

    if (action === "reset-confirm") {
      if (!canManageBot(interaction.member, interaction.memberPermissions)) {
        await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
        return true;
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("study:reset-yes").setLabel("✅ ยืนยันลบ").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("study:refresh").setLabel("ยกเลิก").setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: "⚠️ ลบข้อสอบปัจจุบัน + คะแนนทุกคนเลยไหม?", components: [row], ephemeral: true });
      return true;
    }

    if (action === "reset-yes") {
      if (!canManageBot(interaction.member, interaction.memberPermissions)) {
        await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
        return true;
      }
      resetQuiz(guildId);
      await interaction.update({ content: "🗑️ ลบข้อสอบเรียบร้อย — พิมพ์ `/study` เพื่อเริ่มใหม่", components: [] });
      return true;
    }

    if (action === "report") {
      if (!canManageBot(interaction.member, interaction.memberPermissions)) {
        await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
        return true;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const cfg = getConfigForGuild(guildId);
        const report = await analyzeWeaknesses(guildId);
        if (!report || !report.submitters) {
          await interaction.editReply({ content: "ยังไม่มีคนส่งคำตอบ — รอให้นักเรียนทำเสร็จก่อน" });
          return true;
        }
        const payload = buildReportEmbeds(report, { teacherRoleId: cfg.teacherRoleId });
        await interaction.editReply({ content: `📑 รายงาน + วิเคราะห์โดย AI (จากผู้ส่งคำตอบ ${report.submitters} คน)`, embeds: (payload.embeds ?? []).slice(0, 10), allowedMentions: { parse: [] } });
      } catch (err) {
        console.error("[study:report] error", err?.message);
        await interaction.editReply({ content: `❌ สร้างรายงานไม่สำเร็จ: ${err?.message ?? "unknown"}` });
      }
      return true;
    }
  } catch (err) {
    console.error("[study] panel button error", err?.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ ${err?.message ?? "unknown"}`, ephemeral: true }).catch(() => {});
    }
    return true;
  }

  // ── Quiz-taking buttons (need an active quiz) ──
  const quiz = guildId ? getActiveQuiz(guildId) : null;
  if (!quiz) {
    await interaction.reply({ content: "ข้อสอบนี้หมดอายุแล้ว (อาจถูก reset หรือบอทรีสตาร์ท) — พิมพ์ `/study` เพื่อเปิดหน้าใหม่", ephemeral: true });
    return true;
  }

  // "start" button starts the quiz for the clicker (private)
  if (action === "start") {
    resetUserProgress(guildId, userId);
    const fresh = getOrCreateProgress(guildId, userId, quiz.id);
    await interaction.reply({ ...renderQuestion(quiz, fresh), ephemeral: true });
    return true;
  }

  let progress = getProgress(guildId, userId);

  try {
    if (action === "retry") {
      // Reset only this user's progress — don't disturb others taking the quiz
      resetUserProgress(guildId, userId);
      const fresh = getOrCreateProgress(guildId, userId, quiz.id);
      await interaction.update(renderQuestion(quiz, fresh));
      return true;
    }

    if (!progress) progress = getOrCreateProgress(guildId, userId, quiz.id);

    if (progress.submitted) {
      await interaction.reply({ content: "คุณส่งคำตอบไปแล้ว — กดปุ่ม 🔁 ทำใหม่ ในผลคะแนนถ้าอยากเริ่มใหม่", ephemeral: true });
      return true;
    }

    if (action === "ans") {
      const qIdx = parseInt(parts[2], 10);
      const choice = parseInt(parts[3], 10);
      if (!Number.isInteger(qIdx) || !Number.isInteger(choice)) {
        await interaction.deferUpdate();
        return true;
      }
      recordAnswer(guildId, userId, qIdx, choice, quiz.questions.length);
      const updated = getProgress(guildId, userId);
      await interaction.update(renderQuestion(quiz, updated));
      return true;
    }

    if (action === "nav") {
      const qIdx = parseInt(parts[2], 10);
      if (Number.isInteger(qIdx)) jumpTo(guildId, userId, qIdx);
      const updated = getProgress(guildId, userId);
      await interaction.update(renderQuestion(quiz, updated));
      return true;
    }

    if (action === "submit") {
      const final = submitFinal(guildId, userId);
      if (!final) {
        await interaction.reply({ content: "ส่งคำตอบไม่สำเร็จ ลองใหม่", ephemeral: true });
        return true;
      }
      await interaction.update(renderResult(quiz, final));
      // Notify teacher role with this user's score
      notifyTeacherSubmission(guildId, interaction.user, quiz, final).catch(() => {});
      return true;
    }
  } catch (err) {
    console.error("[study] button error", err?.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ ${err?.message ?? "unknown"}`, ephemeral: true }).catch(() => {});
    }
    return true;
  }
  return false;
}

// ─── Classroom command + components + end-of-class playback ─────────────────

async function notifyTeacherSubmission(guildId, user, quiz, progress) {
  const cfg = getConfigForGuild(guildId);
  if (!cfg.notifyChannelId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const ch = await guild.channels.fetch(cfg.notifyChannelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    // Tally wrong topics for this user
    const wrongByTopic = {};
    for (let i = 0; i < quiz.questions.length; i++) {
      if (progress.answers[i] !== quiz.questions[i].answer) {
        const t = quiz.questions[i].topic || "ทั่วไป";
        wrongByTopic[t] = (wrongByTopic[t] || 0) + 1;
      }
    }
    const wrongList =
      Object.entries(wrongByTopic)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}×${n}`)
        .join(", ") || "✅ เต็ม";
    const passed = progress.score >= Math.ceil(progress.outOf * 0.7);
    const embed = new EmbedBuilder()
      .setColor(passed ? 0x22c55e : 0xef4444)
      .setAuthor({
        name: user.username,
        iconURL: user.displayAvatarURL?.({ size: 64 }),
      })
      .setTitle("📝 นักเรียนส่งคำตอบแล้ว")
      .setDescription(
        `<@${user.id}> ได้คะแนน **${progress.score}/${progress.outOf}**\n` +
          `📂 ไฟล์: \`${quiz.fileName}\`\n` +
          `❌ พลาด: ${wrongList}`,
      )
      .setTimestamp(new Date());
    const content = cfg.teacherRoleId ? `<@&${cfg.teacherRoleId}>` : "";
    await ch.send({
      content,
      embeds: [embed],
      allowedMentions: cfg.teacherRoleId
        ? { roles: [cfg.teacherRoleId], users: [] }
        : { parse: [] },
    });
  } catch (err) {
    console.error("[study] notify teacher failed", err?.message);
  }
}

function buildClassroomPanel(guildId) {
  const cfg = getConfigForGuild(guildId);
  const studentRole = cfg.studentRoleId ? `<@&${cfg.studentRoleId}>` : "_ยังไม่ตั้ง_";
  const teacherRole = cfg.teacherRoleId ? `<@&${cfg.teacherRoleId}>` : "_ยังไม่ตั้ง_";
  const active = listActiveClasses(guildId);
  const activeStr = active.length
    ? active
        .map(
          (c) =>
            `• <#${c.channelId}> — สอนโดย <@${c.teacherId}> · เหลือ <t:${Math.floor(c.endsAt / 1000)}:R>`,
        )
        .join("\n")
    : "_ตอนนี้ไม่มีคลาสไหนกำลังเรียนอยู่_";
  const silentList = (cfg.silentJoinChannelIds || [])
    .map((id) => `<#${id}>`)
    .join(" ") || "_ยังไม่มี — บอทจะทักทายทุกห้อง_";
  const embed = new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle("🎓 ตั้งค่าโหมดห้องเรียน")
    .setDescription(
      `**ยศนักเรียน:** ${studentRole}\n` +
        `**ยศครู:** ${teacherRole}\n` +
        `**เวลาเรียนต่อคลาส:** ${cfg.classDurationMinutes || 60} นาที\n` +
        `**🔇 ห้องเรียน-เงียบ (บอทไม่ทักทายเสียง):**\n${silentList}\n\n` +
        `**คลาสที่กำลังเรียน:**\n${activeStr}\n\n` +
        `_ตั้งยศครูแล้ว เมื่อครูเข้าห้องเสียง บอทจะตั้งเวลาให้อัตโนมัติ — ครบเวลาบอทจะเข้าห้องนั้นแล้วตีกริ่ง + พูด "หมดเวลาเรียน" + ตีกริ่งอีกครั้ง_`,
    )
    .setFooter({ text: "ต้องมีสิทธิ์ Manage Server ถึงจะใช้ปุ่มเหล่านี้ได้" });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("classroom:setrole-student")
      .setLabel("🎓 ตั้งยศนักเรียน")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("classroom:setrole-teacher")
      .setLabel("👨‍🏫 ตั้งยศครู")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("classroom:setduration")
      .setLabel("⏱️ ตั้งเวลาเรียน")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("classroom:refresh")
      .setLabel("🔄 รีเฟรช")
      .setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("classroom:silent-add")
      .setLabel("🔇 เพิ่มห้องเรียน-เงียบ")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("classroom:silent-clear")
      .setLabel("🔔 ล้างห้องเงียบ (ทักทายทุกห้อง)")
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row1, row2] };
}

async function handleClassroomCommand(interaction) {
  await interaction.reply({ ...buildClassroomPanel(interaction.guildId), ephemeral: true });
}

async function handleClassroomComponent(interaction) {
  const cid = interaction.customId;
  if (!cid.startsWith("classroom:")) return false;
  if (!canManageBot(interaction.member, interaction.memberPermissions)) {
    await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
    return true;
  }
  const guildId = interaction.guildId;
  if (!guildId) return false;
  const cfg = getConfigForGuild(guildId);

  try {
    if (cid === "classroom:refresh") {
      await interaction.update(buildClassroomPanel(guildId));
      return true;
    }

    if (cid === "classroom:setrole-student" || cid === "classroom:setrole-teacher") {
      const which = cid.endsWith("student") ? "student" : "teacher";
      const select = new RoleSelectMenuBuilder()
        .setCustomId(`classroom:role:${which}`)
        .setPlaceholder(`เลือกยศ${which === "student" ? "นักเรียน" : "ครู"}`)
        .setMinValues(1)
        .setMaxValues(1);
      await interaction.reply({
        content: `เลือกยศ${which === "student" ? "นักเรียน" : "ครู"}:`,
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
      return true;
    }

    if (cid.startsWith("classroom:role:")) {
      const which = cid.split(":")[2];
      const roleId = interaction.values?.[0];
      if (!roleId) {
        await interaction.reply({ content: "ไม่ได้เลือกยศ", ephemeral: true });
        return true;
      }
      const next = {
        ...cfg,
        [which === "student" ? "studentRoleId" : "teacherRoleId"]: roleId,
      };
      await persistGuildConfig(guildId, next, `chore: set classroom ${which} role`);
      await interaction.update({
        content: `✅ ตั้งยศ${which === "student" ? "นักเรียน" : "ครู"}เป็น <@&${roleId}> เรียบร้อย`,
        components: [],
        allowedMentions: { parse: [] },
      });
      return true;
    }

    if (cid === "classroom:silent-add") {
      const select = new ChannelSelectMenuBuilder()
        .setCustomId("classroom:silent-pick")
        .setPlaceholder("เลือกห้องเสียงที่บอทจะไม่ทักทาย")
        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setMinValues(1)
        .setMaxValues(5);
      await interaction.reply({
        content: "เลือกห้องเสียง 1-5 ห้อง — บอทจะเข้าห้องเหล่านี้แบบเงียบ (ไม่เล่น greeting):",
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
      return true;
    }

    if (cid === "classroom:silent-pick") {
      const ids = interaction.values || [];
      const set = new Set(cfg.silentJoinChannelIds || []);
      for (const id of ids) set.add(id);
      const next = { ...cfg, silentJoinChannelIds: Array.from(set) };
      await persistGuildConfig(guildId, next, `chore: add ${ids.length} silent-join voice channel(s)`);
      await interaction.update({
        content: `✅ เพิ่มห้องเงียบแล้ว: ${ids.map((i) => `<#${i}>`).join(" ")}\n_บอทจะไม่เล่นเสียงทักทายในห้องเหล่านี้อีก_`,
        components: [],
        allowedMentions: { parse: [] },
      });
      return true;
    }

    if (cid === "classroom:silent-clear") {
      await persistGuildConfig(
        guildId,
        { ...cfg, silentJoinChannelIds: [] },
        "chore: clear silent-join voice channels",
      );
      await interaction.update(buildClassroomPanel(guildId));
      return true;
    }

    if (cid === "classroom:setduration") {
      const modal = new ModalBuilder()
        .setCustomId("classroom:duration-modal")
        .setTitle("ตั้งเวลาเรียนต่อคลาส");
      const input = new TextInputBuilder()
        .setCustomId("minutes")
        .setLabel("นาที (5-600)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(cfg.classDurationMinutes || 60));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    if (cid === "classroom:duration-modal") {
      const v = parseInt(interaction.fields.getTextInputValue("minutes"), 10);
      if (!Number.isInteger(v) || v < 5 || v > 600) {
        await interaction.reply({ content: "ใส่จำนวนนาทีระหว่าง 5-600", ephemeral: true });
        return true;
      }
      await persistGuildConfig(
        guildId,
        { ...cfg, classDurationMinutes: v },
        `chore: set classroom duration to ${v}m`,
      );
      await interaction.reply({
        content: `✅ ตั้งเวลาเรียนเป็น **${v} นาที** เรียบร้อย`,
        ephemeral: true,
      });
      return true;
    }
  } catch (err) {
    console.error("[classroom] component error", err?.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: `❌ ${err?.message ?? "unknown"}`, ephemeral: true })
        .catch(() => {});
    }
    return true;
  }
  return false;
}

async function announceClassStart(guild, cls, channel, member) {
  const cfg = getConfigForGuild(guild.id);
  if (!cfg.notifyChannelId) return;
  try {
    const ch = await guild.channels.fetch(cfg.notifyChannelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const embed = new EmbedBuilder()
      .setColor(0x10b981)
      .setAuthor({
        name: member.displayName || member.user.username,
        iconURL: member.user.displayAvatarURL?.({ size: 64 }),
      })
      .setTitle("🟢 เริ่มคาบเรียนแล้ว")
      .setDescription(
        `<@${cls.teacherId}> เริ่มสอนใน <#${cls.channelId}>\n` +
          `⏱️ จะหมดเวลา <t:${Math.floor(cls.endsAt / 1000)}:R> (เวลา <t:${Math.floor(cls.endsAt / 1000)}:t>)`,
      );
    const content = cfg.studentRoleId ? `<@&${cfg.studentRoleId}>` : "";
    await ch.send({
      content,
      embeds: [embed],
      allowedMentions: cfg.studentRoleId
        ? { roles: [cfg.studentRoleId] }
        : { parse: [] },
    });
  } catch (err) {
    console.error("[classroom] announce start failed", err?.message);
  }
}

async function announceClassCancel(guild, cls, member) {
  const cfg = getConfigForGuild(guild.id);
  if (!cfg.notifyChannelId) return;
  try {
    const ch = await guild.channels.fetch(cfg.notifyChannelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("⚪ ยกเลิกคาบเรียน")
      .setDescription(
        `<@${cls.teacherId}> ออกจากห้องเสียง <#${cls.channelId}> ก่อนหมดเวลา — บอทจะไม่ตีกริ่งสิ้นคาบ`,
      );
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error("[classroom] announce cancel failed", err?.message);
  }
}

async function startOfClassPlayback(cls) {
  console.log(`[classroom] firing start-of-class for channel ${cls.channelId}`);
  let guild = null;
  let voiceCh = null;
  try {
    guild = await client.guilds.fetch(cls.guildId);
    voiceCh = await guild.channels.fetch(cls.channelId).catch(() => null);
  } catch (err) {
    console.warn(`[classroom:start] could not fetch channel: ${err?.message}`);
    return;
  }
  if (!voiceCh) return;

  // Wait briefly so the teacher's voice client is fully connected before bot
  // joins (avoids racing the gateway voiceState event).
  await new Promise((r) => setTimeout(r, 1500));

  let conn = getVoiceConnection(guild.id);
  const sameChannel = conn && conn.joinConfig?.channelId === voiceCh.id;
  const movedForPlayback = !sameChannel;
  if (!sameChannel) {
    beginAuxiliaryVoiceMove(guild.id);
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
      console.warn(`[classroom:start] join voice failed: ${err?.message}`);
      await endAuxiliaryVoiceMove(guild);
      return;
    }
  }

  const cfg = getConfigForGuild(cls.guildId);
  const bell = PRANK_SOUNDS.rung;
  const ttsText = cfg.classStartTtsText ||
    "เริ่มคาบเรียนแล้ว ขอให้นักเรียนทุกท่านเตรียมตัวให้พร้อม และตั้งใจเรียน";

  try {
    await playSoundFile(conn, bell, "class-start-bell", 30_000);
    await new Promise((r) => setTimeout(r, 400));
    await speakThai(conn, ttsText, "class-start-tts");
  } catch (err) {
    console.error("[classroom:start] playback error", err?.message);
  } finally {
    if (movedForPlayback) await endAuxiliaryVoiceMove(guild);
  }
  console.log(`[classroom] start-of-class sequence finished for ${cls.channelId}`);
}

async function endOfClassPlayback(cls) {
  console.log(`[classroom] firing end-of-class for channel ${cls.channelId}`);
  let guild = null;
  let voiceCh = null;
  try {
    guild = await client.guilds.fetch(cls.guildId);
    voiceCh = await guild.channels.fetch(cls.channelId).catch(() => null);
  } catch (err) {
    console.warn(`[classroom] could not fetch channel: ${err?.message}`);
    return;
  }
  if (!voiceCh) {
    console.warn(`[classroom] channel ${cls.channelId} not found, skipping`);
    return;
  }

  // Announce in text first
  const cfg = getConfigForGuild(cls.guildId);
  if (cfg.notifyChannelId) {
    try {
      const tx = await guild.channels.fetch(cfg.notifyChannelId).catch(() => null);
      if (tx?.isTextBased?.()) {
        const embed = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("🔔 หมดเวลาเรียนแล้ว")
          .setDescription(
            `คาบเรียนใน <#${cls.channelId}> ครบ ${cfg.classDurationMinutes || 60} นาทีแล้ว — บอทกำลังตีกริ่งในห้อง`,
          );
        const content = [
          cfg.teacherRoleId ? `<@&${cfg.teacherRoleId}>` : "",
          cfg.studentRoleId ? `<@&${cfg.studentRoleId}>` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const roles = [cfg.teacherRoleId, cfg.studentRoleId].filter(Boolean);
        await tx.send({
          content,
          embeds: [embed],
          allowedMentions: { roles },
        });
      }
    } catch (err) {
      console.warn("[classroom] text announce failed", err?.message);
    }
  }

  // Join the voice channel
  let conn = getVoiceConnection(guild.id);
  const sameChannel = conn && conn.joinConfig?.channelId === voiceCh.id;
  const movedForPlayback = !sameChannel;
  if (!sameChannel) {
    beginAuxiliaryVoiceMove(guild.id);
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
      console.warn(`[classroom] join voice failed: ${err?.message}`);
      await endAuxiliaryVoiceMove(guild);
      return;
    }
  }

  const bell = PRANK_SOUNDS.rung;
  const ttsText = cfg.classEndTtsText ||
    "ตอนนี้เวลานี้ หมดเวลาเรียนของวันนี้แล้ว ขอให้นักเรียนทุกท่าน และอาจารย์ทุกท่านหยุดทำการสอน และขอให้ทุกท่านเดินทางโดยสวัสดิภาพ";

  try {
    await playSoundFile(conn, bell, "class-end-bell-1", 30_000);
    await new Promise((r) => setTimeout(r, 400));
    await speakThai(conn, ttsText, "class-end-tts");
    await new Promise((r) => setTimeout(r, 400));
    // Copy to a unique path because playSoundFile dedupes by filePath
    const bell2 = path.join(TTS_TMP_DIR, `class-end-bell-2-${Date.now()}.mp3`);
    try {
      fs.copyFileSync(bell, bell2);
      await playSoundFile(conn, bell2, "class-end-bell-2", 30_000);
      try { fs.unlinkSync(bell2); } catch {}
    } catch {
      // fall back to playing the original again — small risk of dedup skip
      await playSoundFile(conn, bell, "class-end-bell-2", 30_000);
    }
  } catch (err) {
    console.error("[classroom] playback error", err?.message);
  } finally {
    if (movedForPlayback) await endAuxiliaryVoiceMove(guild);
  }
  console.log(`[classroom] end-of-class sequence finished for ${cls.channelId}`);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const interactionCfg = interaction.guildId
      ? getConfigForGuild(interaction.guildId)
      : config;
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setting") {
        await handleSettingCommand(interaction, runtime);
        return;
      }
      if (interaction.commandName === "debug") {
        await handleDebugCommand(interaction, runtime);
        return;
      }
      if (interaction.commandName === "notify") {
        await handleNotifyCommand(interaction);
        return;
      }
      if (interaction.commandName === "study") {
        await handleStudyCommand(interaction);
        return;
      }
      if (interaction.commandName === "study-upload") {
        await handleStudyUploadCommand(interaction);
        return;
      }
      if (interaction.commandName === "classroom") {
        await handleClassroomCommand(interaction);
        return;
      }
      if (isPrankCommand(interaction.commandName)) {
        await handlePrankSound(interaction, runtime, interaction.commandName);
        return;
      }
      if (interaction.commandName === "ai") {
        await handleAiCommand(interaction, interactionCfg);
        return;
      }
      if (interaction.commandName === "avatar") {
        await handleAvatarCommand(interaction);
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
      interaction.isButton() ||
      interaction.isAnySelectMenu?.() ||
      interaction.isModalSubmit()
    ) {
      const handledNotify = await handleNotifyComponent(interaction);
      if (handledNotify) return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("role_panel:")) {
      await handleRolePanelButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("study:")) {
      const handledStudy = await handleStudyButton(interaction);
      if (handledStudy) return;
    }

    if (
      (interaction.isButton() ||
        interaction.isAnySelectMenu?.() ||
        interaction.isModalSubmit()) &&
      interaction.customId?.startsWith("classroom:")
    ) {
      const handledClass = await handleClassroomComponent(interaction);
      if (handledClass) return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("alxcer-unmute:")
    ) {
      const [, targetUserId, leaseId] = interaction.customId.split(":");
      if (interaction.user.id !== targetUserId) {
        await interaction.reply({
          content: "ปุ่มนี้สำหรับเจ้าของไมค์เท่านั้นครับ",
          ephemeral: true,
        });
        return;
      }
      if (!interaction.guildId || !leaseId) {
        await interaction.reply({
          content: "ปุ่มนี้เป็นปุ่มเก่าหรือหมดอายุแล้ว — Guard จะไม่เปิดไมค์โดยไม่มีรหัสสิทธิ์ล่าสุดครับ",
          ephemeral: true,
        });
        return;
      }
      if (wordBanTimers.has(wordBanKey(interaction.guildId, targetUserId))) {
        const rec = getOffense(interaction.guildId, targetUserId);
        const remaining = rec?.muteUntil
          ? Math.max(0, Math.round((rec.muteUntil - Date.now()) / 1000))
          : 0;
        await interaction.reply({
          content: `คุณถูกปิดไมค์เนื่องจากใช้คำต้องห้าม — รออีก ${formatDuration(remaining)}`,
          ephemeral: true,
        });
        return;
      }
      const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
      const member = await guild.members.fetch(targetUserId);
      if (!member.voice.channel) {
        await interaction.reply({
          content: "คุณไม่ได้อยู่ในห้องเสียงตอนนี้",
          ephemeral: true,
        });
        return;
      }
      const released = await unmuteOwnedLease(
        guild,
        member,
        leaseId,
        "Alxcer Guard: user requested unmute",
      );
      if (!released.ok) {
        await interaction.reply({
          content: "ปุ่มนี้หมดอายุแล้ว หรือมีคำสั่ง mute ใหม่กว่า — จึงไม่เปิดไมค์ทับคำสั่งล่าสุดครับ",
          ephemeral: true,
        });
        return;
      }

      const s = runtimeFor(guild.id).userState.get(targetUserId);
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
        if (!interaction.guildId || t.guildId !== interaction.guildId) {
          await interaction.reply({ content: "timer นี้เป็นของอีกเซิร์ฟเวอร์", ephemeral: true });
          return;
        }
        if (interaction.user.id !== t.ownerId && interaction.user.id !== t.userId && !isAdmin(interaction.member)) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับเจ้าของ timer หรือแอดมินเท่านั้น", ephemeral: true });
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
        if (!interaction.guildId || t.guildId !== interaction.guildId) {
          await interaction.reply({ content: "timer นี้เป็นของอีกเซิร์ฟเวอร์", ephemeral: true });
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

      // Cancel a group sleep mode
      if (cid.startsWith("alxcer-cancel-group-sleep:")) {
        const id = cid.split(":")[1];
        const t = getTimer(id);
        if (!t) {
          await interaction.reply({ content: "Group sleep นี้หมดอายุไปแล้ว", ephemeral: true });
          return;
        }
        if (!interaction.guildId || t.guildId !== interaction.guildId) {
          await interaction.reply({ content: "timer นี้เป็นของอีกเซิร์ฟเวอร์", ephemeral: true });
          return;
        }
        if (!isAdmin(interaction.member)) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับแอดมินเท่านั้น", ephemeral: true });
          return;
        }
        cancelTimer(id);
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle("🌙 ยกเลิก group sleep แล้ว")
              .setDescription("ยกเลิกเรียบร้อยครับ — ไม่เตะใครออกแล้ว"),
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
        if (!interaction.guildId || t.guildId !== interaction.guildId) {
          await interaction.reply({ content: "timer นี้เป็นของอีกเซิร์ฟเวอร์ จึงยกเลิกจากที่นี่ไม่ได้", ephemeral: true });
          return;
        }
        let released = { ok: false, code: "mute_not_owned" };
        try {
          const guild = await client.guilds.fetch(t.guildId);
          const member = await guild.members.fetch(t.userId);
          released = await unmuteOwnedLease(
            guild,
            member,
            t.payload?.leaseId,
            "manual cancel via button",
          );
        } catch (err) {
          console.warn("[cancel-mute] unmute failed", err?.message);
        }
        cancelTimer(id);
        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x2ecc71)
              .setTitle(released.ok ? "🔊 เปิดไมค์แล้ว" : "🛡️ ไม่เปิดไมค์")
              .setDescription(released.ok
                ? "ปลด mute เรียบร้อยครับ"
                : "timer นี้เก่ากว่า mute ปัจจุบัน หรือ mute ไม่ได้เป็นของ Guard จึงไม่เปิดทับครับ"),
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
        if (!t) {
          await interaction.reply({ content: "การปลุกนี้หมดอายุไปแล้ว", ephemeral: true });
          return;
        }
        if (!interaction.guildId || t.guildId !== interaction.guildId) {
          await interaction.reply({ content: "การปลุกนี้เป็นของอีกเซิร์ฟเวอร์", ephemeral: true });
          return;
        }
        // Either the user being woken or an admin can stop it
        if (interaction.user.id !== t.userId && !isAdmin(interaction.member)) {
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
        if (!t) {
          await interaction.reply({ content: "การปลุกนี้หมดอายุไปแล้ว", ephemeral: true });
          return;
        }
        if (!interaction.guildId || t.guildId !== interaction.guildId) {
          await interaction.reply({ content: "การปลุกนี้เป็นของอีกเซิร์ฟเวอร์", ephemeral: true });
          return;
        }
        if (interaction.user.id !== t.userId && !isAdmin(interaction.member)) {
          await interaction.reply({ content: "ปุ่มนี้สำหรับคนที่ถูกปลุกเท่านั้น", ephemeral: true });
          return;
        }
        if (session) session.stop();
        const { createTimer: createTimerFn } = await import("./timers.js");
        const next = createTimerFn({
          type: t.type === "wake_alarm" ? "wake_alarm" : "alarm",
          fireAt: Date.now() + minutes * 60 * 1000,
          label: `${t.label || "Alarm"} (snooze ${minutes}น)`,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: t.userId || interaction.user.id,
          mentionUserId: t.mentionUserId || interaction.user.id,
          ownerId: t.ownerId || interaction.user.id,
          payload: t.payload || {},
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
  for (const value of wordBanTimers.values()) clearTimeout(value.handle || value);
  wordBanTimers.clear();
  try {
    await flushTranscripts();
    console.log("[shutdown] transcripts flushed");
  } catch (err) {
    console.error("[shutdown] transcript flush failed", err?.message);
  }
  try {
    await flushMuteLeases();
    console.log("[shutdown] mute ownership flushed");
  } catch (err) {
    console.error("[shutdown] mute ownership flush failed", err?.message);
  }
  for (const guildId of client.guilds.cache.keys()) {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
  }
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (VALIDATE_ONLY) {
  console.log("[validate] boot imports and initialization completed; Discord login skipped");
} else {
  client.login(TOKEN);
}
