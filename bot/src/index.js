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
import { loadConfig } from "./config.js";
import {
  registerCommands,
  handleSettingCommand,
  handleSettingComponent,
  handleDebugCommand,
} from "./commands.js";

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
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const userState = new Map();
const subscribed = new Set();

let currentChannelId = null;
let pollHandle = null;
let joining = false;
let reevalQueued = false;
let activeReceiver = null;
let lastAnyAudio = Date.now();
let lastSpeakingFlag = 0;
let lastWatchdogRejoin = 0;
let receiverHealthLogged = false;
let notReadyTicks = 0;

const WATCHDOG_SECONDS = 60;
const WATCHDOG_COOLDOWN_MS = 3 * 60 * 1000;

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
  // Only real audio packets count as receiver health proof.
  // Discord "speaking start/end" events fire even when packets aren't flowing,
  // which used to mask a broken receiver and also wrongly kept the watchdog quiet.
  if (source === "packet") {
    lastAnyAudio = Date.now();
    if (receiverHealthLogged) {
      console.log("[health] receiver recovered — audio flowing again");
      receiverHealthLogged = false;
    }
  }
  if (!wasHeard) {
    console.log(`[voice] first audio confirmed from ${userId} via ${source}`);
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
    const cleanup = () => subscribed.delete(userId);
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
  });

  // Subscribe to every currently-tracked user up front so the very first
  // audio packet they emit lands in `markHeard` (and proves the receiver
  // is healthy) without waiting for a speaking-start event.
  for (const userId of userState.keys()) {
    subscribeUser(receiver, userId);
  }

  console.log(`[voice] receiver attached on #${channel.name}`);
}

function isReceiverHealthy() {
  // The receiver is "broken" only when Discord told us someone is actively
  // speaking but no audio packets arrived for a while. A perfectly quiet
  // room (nobody speaking) is NOT a broken receiver — it's the exact case
  // we want to mute, so it must not pause the mute logic.
  const now = Date.now();
  const sinceSpeakingFlag = (now - lastSpeakingFlag) / 1000;
  const sinceAudio = (now - lastAnyAudio) / 1000;
  if (sinceSpeakingFlag > WATCHDOG_SECONDS) return true;
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
      console.log(`[track] removed ${userId}`);
    }
  }

  const conn = getVoiceConnection(guild.id);
  const connStatus = conn?.state?.status ?? "none";
  // Treat the connection as functionally usable when either:
  //  - it reports Ready, OR
  //  - it reports any non-destroyed state but we've actually received audio
  //    packets in the last WATCHDOG_SECONDS. discord.js sometimes gets stuck
  //    reporting `signalling` even though UDP packets ARE flowing.
  const audioRecent = (Date.now() - lastAnyAudio) / 1000 < WATCHDOG_SECONDS;
  const usable =
    !!conn &&
    (conn.state.status === VoiceConnectionStatus.Ready ||
      (conn.state.status !== VoiceConnectionStatus.Destroyed && audioRecent));

  if (!usable) {
    notReadyTicks++;
    console.log(
      `[loop] connection not usable (state=${connStatus}, audioRecent=${audioRecent}, ticks=${notReadyTicks})`,
    );
    if (notReadyTicks >= 12) {
      console.warn(
        "[loop] connection stuck unusable for 1 minute — forcing rejoin",
      );
      notReadyTicks = 0;
      if (conn) safeDestroy(conn);
      currentChannelId = null;
      activeReceiver = null;
      subscribed.clear();
      await reevaluateAndJoin(guild);
    }
    return;
  }
  notReadyTicks = 0;

  if (activeReceiver !== conn.receiver) {
    console.log(`[voice] receiver changed — re-attaching`);
    await attachReceiver(conn, channel);
  }

  const humansInChannel = [...channel.members.values()].filter(
    (m) => !(config.ignoreBots && m.user.bot),
  );

  if (humansInChannel.length > 0 && !isReceiverHealthy()) {
    if (!receiverHealthLogged) {
      console.warn(
        `[health] no audio activity for ${WATCHDOG_SECONDS}s while ${humansInChannel.length} humans present — pausing mutes`,
      );
      receiverHealthLogged = true;
    }
    if (Date.now() - lastWatchdogRejoin > WATCHDOG_COOLDOWN_MS) {
      console.warn(`[health] attempting receiver rejoin (cooldown elapsed)`);
      lastWatchdogRejoin = Date.now();
      safeDestroy(conn);
      currentChannelId = null;
      activeReceiver = null;
      subscribed.clear();
      await reevaluateAndJoin(guild);
    }
    return;
  }

  for (const [userId, s] of userState) {
    const member = channel.members.get(userId);
    if (!member) continue;

    if (member.voice.serverMute) {
      s.muted = true;
      continue;
    } else if (s.muted) {
      s.muted = false;
      s.warned = false;
      s.lastSpoke = now;
      s.silentTicks = 0;
    }

    // Self-mute / self-deaf used to reset the timer, which let users
    // bypass the bot by simply muting themselves. Self-mute IS "not using
    // the mic", so it should count as silence — keep timing them.

    if (s.speaking) {
      s.lastSpoke = now;
      s.silentTicks = 0;
      if (s.warned) s.warned = false;
      continue;
    }

    // Previously: if (!s.heardOnce) reset lastSpoke — meant anyone who
    // joined and never spoke was timed forever and never muted, which is
    // the exact behavior we want to prevent. Removed.

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
        // Already in the right channel — just make sure the user list is
        // populated. Previously we returned here without syncing, which left
        // userState empty after any earlier clear (e.g. transient cache miss
        // in pickBestVoiceChannel).
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

    pollHandle = setInterval(async () => {
      try {
        const g = await client.guilds.fetch(config.guildId);
        await reevaluateAndJoin(g);
        await checkInactivity(g);
      } catch (err) {
        console.error("[loop] error", err?.message);
      }
    }, 5_000);

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
    if (wasSelfMuted && !isSelfMuted) {
      const s = userState.get(userId);
      s.lastSpoke = Date.now();
      s.warned = false;
      s.muted = false;
      s.silentTicks = 0;
      console.log(`[voice] ${newState.member.user.tag} unmuted — timer reset`);
    }
  }

  try {
    await reevaluateAndJoin(newState.guild);
  } catch (err) {
    console.error("[voiceUpdate] error", err?.message);
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
  for (const guildId of client.guilds.cache.keys()) {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
  }
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(TOKEN);
