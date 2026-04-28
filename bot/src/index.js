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
} from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
} from "@discordjs/voice";
import prism from "prism-media";
import { loadConfig } from "./config.js";
import {
  registerCommands,
  handleSettingCommand,
  handleSettingComponent,
  handleDebugCommand,
} from "./commands.js";
import {
  loadOffenses,
  writeLocal as writeOffensesLocal,
} from "./offenses.js";
import { canPersistRemotely, commitOffenses } from "./github.js";
import {
  isAvailable as isTranscriberAvailable,
  enqueueTranscription,
  importError as transcriberImportError,
} from "./transcribe.js";

let cryptoLib = "unknown";
try {
  await import("sodium-native");
  cryptoLib = "sodium-native";
} catch {
  try {
    const sodium = await import("libsodium-wrappers");
    await sodium.default.ready;
    cryptoLib = "libsodium-wrappers";
  } catch {
    cryptoLib = "none-found";
  }
}
console.log(`[boot] voice crypto library: ${cryptoLib}`);

const transcriptionAvailable = await isTranscriberAvailable();
if (!transcriptionAvailable) {
  console.warn(
    `[boot] voice transcription DISABLED — chat-only word ban will still work. Reason: ${transcriberImportError() || "unknown"}`,
  );
} else {
  console.log("[boot] voice transcription ENABLED");
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

let currentChannelId = null;
let pollHandle = null;
let audioFlushHandle = null;
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
const MIN_UTTERANCE_SEC = 0.6;
const MAX_UTTERANCE_SEC = 12;
const IDLE_FLUSH_MS = 1500;

const offenses = loadOffenses();
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
  if (!word) return;
  if (!config.guildId) return;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    await applyWordBan(guild, meta.userId, word, "voice", trimmed);
  } catch (err) {
    console.error("[transcribe] wordban dispatch failed", err?.message);
  }
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

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!msg.guild) return;
    if (!config.guildId || msg.guild.id !== config.guildId) return;
    if (msg.author?.bot) return;
    if (!msg.content) return;
    const word = findBannedWord(msg.content);
    if (!word) return;
    await applyWordBan(msg.guild, msg.author.id, word, "chat");
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
  } catch (err) {
    console.error("[interaction] error", err?.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "เกิดข้อผิดพลาด", ephemeral: true })
        .catch(() => {});
    }
  }
});

function shutdown(signal) {
  console.log(`[shutdown] received ${signal}`);
  if (pollHandle) clearInterval(pollHandle);
  if (audioFlushHandle) clearInterval(audioFlushHandle);
  for (const handle of wordBanTimers.values()) clearTimeout(handle);
  wordBanTimers.clear();
  for (const guildId of client.guilds.cache.keys()) {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
  }
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(TOKEN);
