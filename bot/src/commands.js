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
  StringSelectMenuBuilder,
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

export const TRANSCRIBE_COMMAND = new SlashCommandBuilder()
  .setName("transcribe")
  .setDescription("ดูว่าใครพูดอะไรในห้องเสียง — เลือกวันได้จากเมนู")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .setDMPermission(false)
  .toJSON();

export const RUNG_COMMAND = new SlashCommandBuilder()
  .setName("rung")
  .setDescription("🔔 เล่นเสียงแกล้งในห้องเสียง (เฉพาะแอดมิน)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
  .setDMPermission(false)
  .toJSON();

export async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(client.token);
  const appId = client.application?.id ?? client.user.id;
  const guildId = client.config.guildId;
  const body = [SETTING_COMMAND, DEBUG_COMMAND, TRANSCRIBE_COMMAND, RUNG_COMMAND];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
    console.log(
      `[commands] registered /setting /debug /transcribe /rung on guild ${guildId}`,
    );
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log("[commands] registered /setting /debug /transcribe /rung globally");
  }
}

export async function handleRungCommand(interaction, runtime) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "❌ ต้องมีสิทธิ์ **Administrator** เท่านั้นถึงจะใช้คำสั่งนี้ได้",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await runtime.playPrankSound("rung");
    if (result.ok) {
      await interaction.editReply({
        content: `🔔 เล่นเสียงแกล้งในห้อง <#${result.channelId}> แล้ว!`,
      });
    } else {
      await interaction.editReply({ content: `⚠️ เล่นไม่ได้: ${result.reason}` });
    }
  } catch (err) {
    console.error("[rung] error", err?.message);
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

const TZ_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

function formatThaiTime(ts) {
  const d = new Date(ts + TZ_OFFSET_MS);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const DAY_OPTIONS = [
  { value: "0", label: "วันนี้" },
  { value: "1", label: "เมื่อวาน" },
  { value: "2", label: "2 วันก่อน" },
  { value: "3", label: "3 วันก่อน" },
  { value: "4", label: "4 วันก่อน" },
  { value: "5", label: "5 วันก่อน" },
  { value: "6", label: "6 วันก่อน" },
  { value: "all", label: "ทั้งหมด (7 วันย้อนหลัง)" },
];

function rangeForDayOffset(value) {
  if (value === "all") {
    return { fromMs: null, toMs: null, label: "ทั้งหมด (7 วันย้อนหลัง)" };
  }
  const offset = Number(value);
  const nowThai = new Date(Date.now() + TZ_OFFSET_MS);
  const baseUtcMidnight = Date.UTC(
    nowThai.getUTCFullYear(),
    nowThai.getUTCMonth(),
    nowThai.getUTCDate() - offset,
  );
  const fromMs = baseUtcMidnight - TZ_OFFSET_MS;
  const toMs = fromMs + DAY_MS;
  const d = new Date(baseUtcMidnight);
  const dateLabel = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const friendly =
    offset === 0
      ? "วันนี้"
      : offset === 1
        ? "เมื่อวาน"
        : `${offset} วันก่อน`;
  return { fromMs, toMs, label: `${friendly} (${dateLabel})` };
}

function buildTranscribeView(runtime, dayValue) {
  const range = rangeForDayOffset(dayValue);
  const entries = runtime.getRecentTranscripts({
    fromMs: range.fromMs,
    toMs: range.toMs,
    limit: 50,
  });
  const stats = runtime.getTranscriptStats();
  const sorted = entries.slice().reverse();
  const snap = runtime.snapshot ? runtime.snapshot() : null;

  let body;
  if (sorted.length === 0) {
    const diagLines = ["_ยังไม่มีบันทึกเสียงในช่วงนี้_", "", "**ตรวจสอบ:**"];
    if (snap) {
      const ts = snap.transcribeStatus || {};
      diagLines.push(
        `• บอท${snap.connected ? "อยู่ในห้อง " + (snap.channelId ? `<#${snap.channelId}>` : "—") : "❌ ยังไม่เข้าห้องเสียงเลย"}`,
      );
      const modelLabel = ts.modelReady
        ? `✅ พร้อม (${ts.modelName})`
        : ts.importError
          ? `❌ โหลด Whisper ไม่ขึ้น: ${ts.importError}`
          : `⏳ กำลังโหลด model "${ts.modelName}" (~30-90 วิ ครั้งแรก)`;
      diagLines.push(`• Whisper: ${modelLabel}`);
      diagLines.push(
        `• เสียงล่าสุดที่ได้ยิน: ${snap.lastAnyAudioAge}s ที่แล้ว · เก็บข้อความ ${stats.totalEntries} รายการ`,
      );
      const trackedSpeaking = snap.users.filter((u) => u.heardOnce).length;
      diagLines.push(
        `• คน track อยู่ ${snap.users.length} คน · เคยได้ยินจริง ${trackedSpeaking} คน`,
      );
      const lastTextAgo = ts.lastTextAt
        ? `${Math.round((Date.now() - ts.lastTextAt) / 1000)}s ที่แล้ว`
        : "ยังไม่เคยถอดสำเร็จ";
      diagLines.push(
        `• Whisper queue: ${ts.queued ?? 0}/${ts.maxQueue ?? "?"} · กำลังถอด ${ts.active ?? 0} งาน · เคยถอด ${ts.totalProcessed ?? 0} (ว่าง ${ts.totalEmpty ?? 0}, error ${ts.totalErrors ?? 0}) · ข้อความล่าสุด: ${lastTextAgo}`,
      );
      if (ts.lastError) {
        diagLines.push(`• Error ล่าสุด: \`${ts.lastError.slice(0, 120)}\``);
      }
      diagLines.push("");
      if (!snap.connected) {
        diagLines.push(
          "💡 ให้ใครสักคนเข้าห้องเสียงก่อน บอทจะเข้าตามอัตโนมัติ",
        );
      } else if (!ts.modelReady && !ts.importError) {
        diagLines.push(
          "💡 รอ ~1 นาที ให้ Whisper โหลด model แล้วลองพูดอีกครั้ง",
        );
      } else if (ts.totalProcessed === 0 && trackedSpeaking > 0) {
        diagLines.push(
          "💡 บอทได้ยินเสียงแต่ยังไม่ได้ส่งให้ Whisper — รอ ~5 วินาที (chunk เต็ม) แล้วลองใหม่",
        );
      } else if (ts.totalProcessed > 0 && ts.totalEmpty === ts.totalProcessed) {
        diagLines.push(
          "💡 Whisper ถอดได้แต่ออกมาว่าง — อาจเป็นปัญหา language หรือเสียงเบาเกินไป",
        );
      } else if (trackedSpeaking === 0) {
        diagLines.push(
          "💡 อาจเป็นปัญหา Crypto/permissions — ดู log บน GitHub Actions",
        );
      }
    }
    body = diagLines.join("\n");
  } else {
    const lines = sorted.map((e) => {
      const t = formatThaiTime(e.timestamp);
      const flag = e.flagged ? "⚠️ " : "";
      const text = e.text.length > 250 ? e.text.slice(0, 247) + "..." : e.text;
      return `${flag}\`${t}\` <@${e.userId}>: ${text}`;
    });
    body = lines.join("\n");
    if (body.length > 3800) {
      body = body.slice(0, 3800) + "\n_(เก่ากว่านี้ถูกตัดออก)_";
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle("🎙️ ใครพูดอะไรในห้องเสียง")
    .setDescription(
      `**📅 ${range.label}** — ${sorted.length} ข้อความ\n\n${body}`,
    )
    .setFooter({ text: footerText(stats) });

  const select = new StringSelectMenuBuilder()
    .setCustomId("transcribe:day")
    .setPlaceholder("เลือกวันที่ต้องการดู")
    .addOptions(
      DAY_OPTIONS.map((o) => ({
        label: o.label,
        value: o.value,
        default: o.value === dayValue,
      })),
    );

  const row = new ActionRowBuilder().addComponents(select);

  return { embeds: [embed], components: [row] };
}

export async function handleTranscribeCommand(interaction, runtime) {
  if (!runtime.transcriptionAvailable()) {
    await interaction.reply({
      content:
        "❌ ระบบถอดเสียงยังไม่พร้อมในรอบนี้ (Whisper อาจติดตั้งไม่สำเร็จ) — ดู log บน GitHub Actions",
      ephemeral: true,
    });
    return;
  }
  const view = buildTranscribeView(runtime, "0");
  await interaction.reply({ ...view, ephemeral: true });
}

export async function handleTranscribeComponent(interaction, runtime) {
  if (!interaction.customId?.startsWith("transcribe:")) return false;
  if (!interaction.isStringSelectMenu()) return false;
  const action = interaction.customId.slice("transcribe:".length);
  if (action !== "day") return false;

  if (!runtime.transcriptionAvailable()) {
    await interaction.update({
      content: "❌ ระบบถอดเสียงยังไม่พร้อมในรอบนี้",
      embeds: [],
      components: [],
    });
    return true;
  }

  const dayValue = interaction.values[0];
  const view = buildTranscribeView(runtime, dayValue);
  await interaction.update(view);
  return true;
}

function fmtChannel(id) {
  return id ? `<#${id}>` : "_ยังไม่ได้ตั้งค่า_";
}

function footerText(stats) {
  const parts = [`เก็บไว้ ${stats.totalEntries} รายการ`];
  if (stats.oldest) {
    const days = (Date.now() - stats.oldest) / (24 * 3600 * 1000);
    parts.push(
      `เก่าสุด ${days < 1 ? `${Math.round(days * 24)} ชม.` : `${days.toFixed(1)} วัน`} ที่แล้ว`,
    );
  }
  parts.push(`ลบอัตโนมัติเมื่อครบ ${stats.retentionDays || 7} วัน · UTC+7`);
  return parts.join(" · ");
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
