import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { writeLocal, normalize } from "./config.js";
import { canPersistRemotely, commitConfig } from "./github.js";

export const SETTING_COMMAND = new SlashCommandBuilder()
  .setName("setting")
  .setDescription("ตั้งค่า Alxcer Guard")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .setDMPermission(false)
  .toJSON();

export const DEBUG_COMMAND = new SlashCommandBuilder()
  .setName("debug")
  .setDescription("ดูสถานะการตรวจจับเสียงสด ๆ ของ Alxcer Guard")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .setDMPermission(false)
  .toJSON();


export const PRANK_COMMAND_DEFS = [
  { name: "rung", emoji: "🔔", desc: "เล่นเสียงกริ่งในห้องเสียง (เฉพาะแอดมิน)" },
  { name: "jinny", emoji: "🧞", desc: "เล่นเสียงของ Jinny ในห้องเสียง (เฉพาะแอดมิน)" },
  { name: "jan", emoji: "🎵", desc: "เล่นเสียงของ Jan ในห้องเสียง (เฉพาะแอดมิน)" },
];

export const PRANK_COMMANDS = PRANK_COMMAND_DEFS.map((p) =>
  new SlashCommandBuilder()
    .setName(p.name)
    .setDescription(`${p.emoji} ${p.desc}`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
    .setDMPermission(false)
    .toJSON(),
);

export async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(client.token);
  const appId = client.application?.id ?? client.user.id;
  const guildId = client.config.guildId;
  const body = [SETTING_COMMAND, DEBUG_COMMAND, ...PRANK_COMMANDS];
  const list = ["setting", "debug", ...PRANK_COMMAND_DEFS.map((p) => p.name)]
    .map((n) => "/" + n)
    .join(" ");

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    console.log(`[commands] registered ${list} on guild ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log(`[commands] registered ${list} globally`);
  }
}

export function isPrankCommand(name) {
  return PRANK_COMMAND_DEFS.some((p) => p.name === name);
}

export async function handlePrankSound(interaction, runtime, soundName) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "❌ ต้องมีสิทธิ์ **Administrator** เท่านั้นถึงจะใช้คำสั่งนี้ได้",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await runtime.playPrankSound(soundName);
    if (result.ok) {
      const def = PRANK_COMMAND_DEFS.find((p) => p.name === soundName);
      const emoji = def?.emoji ?? "🔊";
      await interaction.editReply({
        content: `${emoji} เล่นเสียง \`/${soundName}\` ในห้อง <#${result.channelId}> แล้ว!`,
      });
    } else {
      await interaction.editReply({ content: `⚠️ เล่นไม่ได้: ${result.reason}` });
    }
  } catch (err) {
    console.error(`[prank:${soundName}] error`, err?.message);
    await interaction.editReply({
      content: `❌ ผิดพลาด: ${err?.message ?? "unknown"}`,
    });
  }
}

export async function handleDebugCommand(interaction, runtime) {
  const snap = runtime.snapshot();
  const cfg = runtime.getConfig();
  const lines = [];
  lines.push(
    `**สถานะ:** ${snap.connected ? "🟢 เชื่อมต่อห้อง" : "🔴 ยังไม่เข้าห้อง"} (state: \`${snap.connStatus}\`)`,
  );
  lines.push(
    `**บอทอยู่ห้อง:** ${snap.channelId ? `<#${snap.channelId}>` : "—"}`,
  );
  lines.push(
    `**คุณอยู่ห้อง:** ${interaction.member?.voice?.channelId ? `<#${interaction.member.voice.channelId}>` : "ไม่ได้อยู่ใน voice"}`,
  );
  lines.push(
    `**Crypto:** ${snap.cryptoLib ?? "ไม่ทราบ"}  |  **เสียงล่าสุด:** ${snap.lastAnyAudioAge}s ที่แล้ว  |  **STT:** ${snap.transcription ? "✅ พร้อม" : "❌ ปิด"}`,
  );
  lines.push(
    `**Threshold:** เตือน ${cfg.warningSeconds}s / ปิดไมค์ ${cfg.muteSeconds}s · pinned=${cfg.voiceChannelId || "auto"}`,
  );
  lines.push("");
  lines.push("**ห้องเสียงทั้งหมดที่บอทเห็น:**");
  if (snap.allVoiceChannels.length === 0) {
    lines.push("_ไม่มีห้องเสียงเลย_");
  } else {
    for (const c of snap.allVoiceChannels) {
      const tag = c.id === snap.channelId ? "👈 บอทอยู่นี่" : "";
      lines.push(
        `• <#${c.id}> — ${c.humanCount} คน (รวมบอท ${c.totalCount}) ${tag}`,
      );
    }
  }
  lines.push("");
  lines.push("**คน ที่ track:**");
  if (snap.users.length === 0) {
    lines.push("_ไม่มีคนถูก track อยู่_");
  } else {
    for (const u of snap.users) {
      lines.push(
        `<@${u.id}> · ได้ยิน:${u.heardOnce ? "✅" : "❌"} · พูด:${u.speaking ? "🎙️" : "—"} · เงียบ ${u.silentFor}s · เตือน:${u.warned ? "✅" : "—"} · mute:${u.muted ? "🔇" : "—"}`,
      );
    }
  }
  await interaction.reply({
    content: lines.join("\n").slice(0, 1900),
    ephemeral: true,
  });
}

function fmtChannel(id) {
  return id ? `<#${id}>` : "_ยังไม่ตั้ง_";
}

export function buildSettingsView(config) {
  const words = config.bannedWords ?? [];
  const wordsDisplay = words.length
    ? words.map((w) => `\`${w}\``).join(", ").slice(0, 512)
    : "_ยังไม่มี_";

  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle("⚙️ ตั้งค่า Alxcer Guard")
    .setDescription("เลือกค่าที่ต้องการแก้ไข แล้วกดปุ่มด้านล่าง")
    .addFields(
      {
        name: "📢 ห้องแจ้งเตือน",
        value: fmtChannel(config.notifyChannelId),
        inline: true,
      },
      {
        name: "🎙️ ห้องเสียงที่ตรึง",
        value: config.voiceChannelId
          ? fmtChannel(config.voiceChannelId)
          : "_อัตโนมัติ (เลือกห้องที่มีคนมากสุด)_",
        inline: true,
      },
      { name: "\u200b", value: "\u200b", inline: true },
      {
        name: "⏱️ เตือนเมื่อเงียบ",
        value: `${config.warningSeconds}s`,
        inline: true,
      },
      {
        name: "🔇 ปิดไมค์เมื่อเงียบ",
        value: `${config.muteSeconds}s`,
        inline: true,
      },
      { name: "\u200b", value: "\u200b", inline: true },
      {
        name: "⚖️ โทษครั้งแรก",
        value: `${config.firstOffenseMuteSeconds}s`,
        inline: true,
      },
      {
        name: "⚖️ โทษซ้ำ",
        value: `${config.repeatOffenseMuteSeconds}s`,
        inline: true,
      },
      {
        name: "🤖 ละเว้นบอท",
        value: config.ignoreBots ? "✅ ใช่" : "❌ ไม่",
        inline: true,
      },
      {
        name: "🚫 คำต้องห้าม",
        value: wordsDisplay,
        inline: false,
      },
      {
        name: "🔔 Wake Alarm — เสียงเพลง",
        value: config.wakeMusicUrl ? `[ลิงก์](<${config.wakeMusicUrl}>)` : "_ใช้เสียงบี๊ปเริ่มต้น_",
        inline: true,
      },
      {
        name: "🗣️ Wake Alarm — ข้อความพูด",
        value: config.wakeTtsText || "_ค่าเริ่มต้น_",
        inline: true,
      },
    );

  const notifyRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("setting:notify")
      .setPlaceholder("เลือกห้องสำหรับแจ้งเตือน")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

  const voiceRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("setting:voice")
      .setPlaceholder("ตรึงห้องเสียง (ไม่เลือก = อัตโนมัติ)")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setMinValues(0)
      .setMaxValues(1),
  );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setting:times")
      .setLabel("⏱️ เวลา")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("setting:offense")
      .setLabel("⚖️ โทษ / คำต้องห้าม")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("setting:wake")
      .setLabel("🔔 Wake Alarm")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("setting:auto-voice")
      .setLabel("🔕 ห้องอัตโนมัติ")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("setting:refresh")
      .setLabel("🔄 รีเฟรช")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [notifyRow, voiceRow, buttons] };
}

async function persist(config) {
  writeLocal(config);
  if (canPersistRemotely()) {
    await commitConfig(config);
  }
}

export async function handleSettingCommand(interaction, runtime) {
  const view = buildSettingsView(runtime.getConfig());
  await interaction.reply({ ...view, ephemeral: true });
}

export async function handleSettingComponent(interaction, runtime) {
  const id = interaction.customId;
  if (!id.startsWith("setting:")) return false;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "ต้องมีสิทธิ์ Manage Server เท่านั้น",
      ephemeral: true,
    });
    return true;
  }

  const action = id.slice("setting:".length);
  const cfg = runtime.getConfig();

  try {
    if (action === "notify" && interaction.isChannelSelectMenu()) {
      const next = normalize({ ...cfg, notifyChannelId: interaction.values[0] });
      await persist(next);
      runtime.setConfig(next);
      await interaction.update(buildSettingsView(next));
      return true;
    }

    if (action === "voice" && interaction.isChannelSelectMenu()) {
      const next = normalize({
        ...cfg,
        voiceChannelId: interaction.values[0] ?? "",
      });
      await persist(next);
      runtime.setConfig(next);
      runtime.requestRejoin();
      await interaction.update(buildSettingsView(next));
      return true;
    }

    if (action === "auto-voice" && interaction.isButton()) {
      const next = normalize({ ...cfg, voiceChannelId: "" });
      await persist(next);
      runtime.setConfig(next);
      runtime.requestRejoin();
      await interaction.update(buildSettingsView(next));
      return true;
    }

    if (action === "refresh" && interaction.isButton()) {
      await interaction.update(buildSettingsView(runtime.getConfig()));
      return true;
    }

    // ── Times modal ──────────────────────────────────────────────────────────
    if (action === "times" && interaction.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId("setting:times-modal")
        .setTitle("⏱️ ตั้งเวลา (วินาที)")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("warning")
              .setLabel("เตือนเมื่อเงียบ (วินาที)")
              .setStyle(TextInputStyle.Short)
              .setValue(String(cfg.warningSeconds))
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("mute")
              .setLabel("ปิดไมค์เมื่อเงียบ (วินาที)")
              .setStyle(TextInputStyle.Short)
              .setValue(String(cfg.muteSeconds))
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    if (id === "setting:times-modal" && interaction.isModalSubmit()) {
      const warning = Number(interaction.fields.getTextInputValue("warning"));
      const mute = Number(interaction.fields.getTextInputValue("mute"));
      if (!Number.isFinite(warning) || !Number.isFinite(mute)) {
        await interaction.reply({ content: "กรุณากรอกตัวเลขเท่านั้น", ephemeral: true });
        return true;
      }
      if (mute <= warning) {
        await interaction.reply({
          content: "เวลาปิดไมค์ต้องมากกว่าเวลาเตือน",
          ephemeral: true,
        });
        return true;
      }
      const next = normalize({ ...cfg, warningSeconds: warning, muteSeconds: mute });
      await persist(next);
      runtime.setConfig(next);
      await interaction.reply({
        content: `✅ บันทึกแล้ว: เตือน **${next.warningSeconds}s** / ปิดไมค์ **${next.muteSeconds}s**`,
        ephemeral: true,
      });
      return true;
    }

    // ── Offense + banned words modal ─────────────────────────────────────────
    if (action === "offense" && interaction.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId("setting:offense-modal")
        .setTitle("⚖️ ตั้งค่าโทษ / คำต้องห้าม")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("first")
              .setLabel("โทษครั้งแรก — ปิดไมค์กี่วินาที")
              .setStyle(TextInputStyle.Short)
              .setValue(String(cfg.firstOffenseMuteSeconds))
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("repeat")
              .setLabel("โทษครั้งถัดไป — ปิดไมค์กี่วินาที")
              .setStyle(TextInputStyle.Short)
              .setValue(String(cfg.repeatOffenseMuteSeconds))
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("words")
              .setLabel("คำต้องห้าม (คั่นด้วยจุลภาค ',')")
              .setStyle(TextInputStyle.Paragraph)
              .setValue((cfg.bannedWords ?? []).join(", "))
              .setRequired(false),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    if (id === "setting:offense-modal" && interaction.isModalSubmit()) {
      const first = Number(interaction.fields.getTextInputValue("first"));
      const repeat = Number(interaction.fields.getTextInputValue("repeat"));
      const rawWords = interaction.fields.getTextInputValue("words") || "";
      if (!Number.isFinite(first) || !Number.isFinite(repeat)) {
        await interaction.reply({ content: "กรุณากรอกตัวเลขเท่านั้นในช่องโทษ", ephemeral: true });
        return true;
      }
      const words = rawWords
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean);
      const next = normalize({
        ...cfg,
        firstOffenseMuteSeconds: first,
        repeatOffenseMuteSeconds: repeat,
        bannedWords: words,
      });
      await persist(next);
      runtime.setConfig(next);
      const wordsSummary = next.bannedWords.length
        ? next.bannedWords.map((w) => `\`${w}\``).join(", ")
        : "_ไม่มี_";
      await interaction.reply({
        content: `✅ บันทึกแล้ว:\n• โทษครั้งแรก **${next.firstOffenseMuteSeconds}s** / ครั้งถัดไป **${next.repeatOffenseMuteSeconds}s**\n• คำต้องห้าม: ${wordsSummary}`,
        ephemeral: true,
      });
      return true;
    }

    // ── Wake alarm modal ─────────────────────────────────────────────────────
    if (action === "wake" && interaction.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId("setting:wake-modal")
        .setTitle("🔔 ตั้งค่า Wake Alarm")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("musicUrl")
              .setLabel("URL เสียงเพลงปลุก (MP3/OGG, ว่าง = เสียงบี๊ป)")
              .setStyle(TextInputStyle.Short)
              .setValue(cfg.wakeMusicUrl || "")
              .setPlaceholder("https://example.com/music.mp3")
              .setRequired(false),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("ttsText")
              .setLabel("ข้อความที่บอทพูดเพื่อปลุก")
              .setStyle(TextInputStyle.Short)
              .setValue(cfg.wakeTtsText || "")
              .setPlaceholder("ขออนุญาตปลุกนะครับ ตื่นได้แล้วเด้อ")
              .setRequired(false),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    if (id === "setting:wake-modal" && interaction.isModalSubmit()) {
      const musicUrl = interaction.fields.getTextInputValue("musicUrl").trim();
      const ttsText = interaction.fields.getTextInputValue("ttsText").trim();
      if (musicUrl && !/^https?:\/\//i.test(musicUrl)) {
        await interaction.reply({
          content: "URL เสียงต้องขึ้นต้นด้วย http:// หรือ https://",
          ephemeral: true,
        });
        return true;
      }
      const next = normalize({ ...cfg, wakeMusicUrl: musicUrl, wakeTtsText: ttsText });
      await persist(next);
      runtime.setConfig(next);
      await interaction.reply({
        content: `✅ บันทึกแล้ว:\n• เสียงปลุก: ${next.wakeMusicUrl || "_ใช้บี๊ปเริ่มต้น_"}\n• ข้อความ: "${next.wakeTtsText}"`,
        ephemeral: true,
      });
      return true;
    }
  } catch (err) {
    console.error("[setting] error", err?.message);
    const msg = `ผิดพลาด: ${err?.message ?? "unknown"}`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
    return true;
  }

  return false;
}
