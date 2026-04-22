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

export async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(client.token);
  const appId = client.application?.id ?? client.user.id;
  const guildId = client.config.guildId;
  const body = [SETTING_COMMAND, DEBUG_COMMAND];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    console.log(`[commands] registered /setting /debug on guild ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log("[commands] registered /setting /debug globally");
  }
}

export async function handleDebugCommand(interaction, runtime) {
  const snap = runtime.snapshot();
  const cfg = runtime.getConfig();
  const lines = [];
  lines.push(`**สถานะ:** ${snap.connected ? "🟢 เชื่อมต่อห้อง" : "🔴 ยังไม่เข้าห้อง"}`);
  lines.push(`**บอทอยู่ห้อง:** ${snap.channelId ? `<#${snap.channelId}>` : "—"}`);
  lines.push(`**คุณอยู่ห้อง:** ${interaction.member?.voice?.channelId ? `<#${interaction.member.voice.channelId}>` : "ไม่ได้อยู่ใน voice"}`);
  lines.push(
    `**Crypto:** ${snap.cryptoLib ?? "ไม่ทราบ"}  |  **เสียงล่าสุด:** ${snap.lastAnyAudioAge}s ที่แล้ว`,
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
      lines.push(`• <#${c.id}> — ${c.humanCount} คน (รวมบอท ${c.totalCount}) ${tag}`);
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
  await interaction.reply({ content: lines.join("\n").slice(0, 1900), ephemeral: true });
}

function fmtChannel(id) {
  return id ? `<#${id}>` : "_ยังไม่ได้ตั้งค่า_";
}

export function buildSettingsView(config) {
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
      {
        name: "⏱️ เวลาเตือน (วินาที)",
        value: String(config.warningSeconds),
        inline: true,
      },
      {
        name: "🔇 เวลาปิดไมค์ (วินาที)",
        value: String(config.muteSeconds),
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
      .setLabel("ตั้งเวลาเตือน / ปิดไมค์")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("setting:auto-voice")
      .setLabel("ใช้ห้องเสียงอัตโนมัติ")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("setting:refresh")
      .setLabel("รีเฟรช")
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

  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
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

    if (action === "times" && interaction.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId("setting:times-modal")
        .setTitle("ตั้งเวลา (วินาที)")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("warning")
              .setLabel("เวลาเตือนเมื่อเงียบ (วินาที)")
              .setStyle(TextInputStyle.Short)
              .setValue(String(cfg.warningSeconds))
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("mute")
              .setLabel("เวลาปิดไมค์เมื่อเงียบ (วินาที)")
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
      if (mute <= warning) {
        await interaction.reply({
          content: "เวลาปิดไมค์ต้องมากกว่าเวลาเตือน",
          ephemeral: true,
        });
        return true;
      }
      const next = normalize({
        ...cfg,
        warningSeconds: warning,
        muteSeconds: mute,
      });
      await persist(next);
      runtime.setConfig(next);
      await interaction.reply({
        content: `บันทึกแล้ว: เตือน ${next.warningSeconds}s / ปิดไมค์ ${next.muteSeconds}s`,
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
