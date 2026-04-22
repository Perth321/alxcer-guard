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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `config.json not found at ${CONFIG_PATH}. Use the settings web app to create one.`,
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.guildId) throw new Error("guildId is required in config.json");
  return {
    guildId: String(cfg.guildId),
    voiceChannelId: cfg.voiceChannelId ? String(cfg.voiceChannelId) : null,
    notifyChannelId: cfg.notifyChannelId ? String(cfg.notifyChannelId) : null,
    warningSeconds: Number(cfg.warningSeconds ?? 180),
    muteSeconds: Number(cfg.muteSeconds ?? 300),
    ignoreBots: cfg.ignoreBots !== false,
  };
}

const config = loadConfig();
const TOKEN = process.env.DISCORD_PERSONAL_ACCESS_TOKEN;

if (!TOKEN) {
  throw new Error(
    "DISCORD_PERSONAL_ACCESS_TOKEN environment variable is required.",
  );
}

console.log("[boot] Alxcer Guard starting", {
  guildId: config.guildId,
  notifyChannelId: config.notifyChannelId,
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

// Per-user tracking inside the channel the bot is currently watching
const userState = new Map();
// userId -> { lastSpoke: number, warned: boolean, muted: boolean }

let currentChannelId = null;
let pollHandle = null;
let joining = false;
let reevalQueued = false;

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
  // If the user pinned a specific voice channel in config, always use that one
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

function resetUserState(channel) {
  userState.clear();
  const now = Date.now();
  for (const [, member] of channel.members) {
    if (config.ignoreBots && member.user.bot) continue;
    userState.set(member.id, {
      lastSpoke: now,
      warned: false,
      muted: false,
    });
  }
}

async function attachReceiver(connection, channel) {
  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId) => {
    const s = userState.get(userId);
    if (!s) return;
    s.lastSpoke = Date.now();
    if (s.warned) {
      s.warned = false;
    }
  });

  // Subscribe to a silent stream so the speaking event keeps firing for everyone
  receiver.speaking.on("start", (userId) => {
    if (userState.has(userId)) {
      try {
        const sub = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.Manual },
        });
        sub.on("data", () => {});
      } catch {}
    }
  });

  console.log(`[voice] receiver attached on #${channel.name}`);
}

async function checkInactivity(guild) {
  if (!currentChannelId) return;
  const channel = guild.channels.cache.get(currentChannelId);
  if (!channel) return;

  const now = Date.now();

  // Sync members in case they joined/left
  for (const [, member] of channel.members) {
    if (config.ignoreBots && member.user.bot) continue;
    if (!userState.has(member.id)) {
      userState.set(member.id, {
        lastSpoke: now,
        warned: false,
        muted: false,
      });
    }
  }
  for (const userId of [...userState.keys()]) {
    if (!channel.members.has(userId)) {
      userState.delete(userId);
    }
  }

  for (const [userId, s] of userState) {
    const member = channel.members.get(userId);
    if (!member) continue;
    if (member.voice.serverMute) {
      s.muted = true;
      continue;
    } else if (s.muted) {
      // user got unmuted externally — reset
      s.muted = false;
      s.warned = false;
      s.lastSpoke = now;
    }

    const silentFor = (now - s.lastSpoke) / 1000;

    if (!s.warned && silentFor >= config.warningSeconds) {
      s.warned = true;
      console.log(`[warn] ${member.user.tag} silent for ${silentFor.toFixed(0)}s`);
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

    if (!s.muted && silentFor >= config.muteSeconds) {
      try {
        await member.voice.setMute(true, "Alxcer Guard: inactive in voice");
        s.muted = true;
        console.log(`[mute] ${member.user.tag}`);

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
  } catch (err) {
    // ignore — already destroyed
  }
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
      }
      return;
    }

    // Already on the right channel and connection is healthy → nothing to do
    if (currentChannelId === target.id) {
      const existing = getVoiceConnection(guild.id);
      if (
        existing &&
        existing.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        return;
      }
    }

    // Claim the channel BEFORE the async join so concurrent events don't re-join
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
      selfMute: true,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      console.error("[voice] failed to become ready:", err?.message);
      safeDestroy(connection);
      currentChannelId = null;
      return;
    }

    resetUserState(target);
    await attachReceiver(connection, target);
    console.log(`[voice] connected & monitoring #${target.name}`);
  } finally {
    joining = false;
    if (reevalQueued) {
      reevalQueued = false;
      // Schedule a follow-up but don't await — avoid recursion stack
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
  const guild = await client.guilds.fetch(config.guildId);
  await guild.members.fetch().catch(() => {});
  await reevaluateAndJoin(guild);

  // Periodic check loop
  pollHandle = setInterval(async () => {
    try {
      const g = await client.guilds.fetch(config.guildId);
      await reevaluateAndJoin(g);
      await checkInactivity(g);
    } catch (err) {
      console.error("[loop] error", err?.message);
    }
  }, 5_000);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.guild.id !== config.guildId) return;
  // Ignore the bot's own voice state changes — they would cause an infinite loop
  if (newState.member?.id === client.user?.id) return;
  if (oldState.member?.id === client.user?.id) return;

  // If a user toggled mute/unmute, refresh their lastSpoke timer so unmuting
  // gives them a fresh chance instead of being instantly re-muted.
  const userId = newState.member?.id ?? oldState.member?.id;
  if (userId && userState.has(userId)) {
    const wasSelfMuted = oldState.selfMute || oldState.serverMute;
    const isSelfMuted = newState.selfMute || newState.serverMute;
    if (wasSelfMuted && !isSelfMuted) {
      const s = userState.get(userId);
      s.lastSpoke = Date.now();
      s.warned = false;
      s.muted = false;
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
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("alxcer-unmute:")) return;

  const targetUserId = interaction.customId.split(":")[1];
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({
      content: "ปุ่มนี้สำหรับเจ้าของไมค์เท่านั้นครับ",
      ephemeral: true,
    });
    return;
  }

  try {
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
    }

    await interaction.reply({
      content: "✅ Unmute เรียบร้อย — พูดได้เลยครับ",
      ephemeral: true,
    });
  } catch (err) {
    console.error("[unmute] failed", err?.message);
    await interaction.reply({
      content: "ไม่สามารถ unmute ได้ในตอนนี้",
      ephemeral: true,
    });
  }
});

// Graceful shutdown — important for GitHub Actions runner cleanup
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
