// Scheduled notifications. Each item fires once per day at the configured
// time (Asia/Bangkok) and pings an optional role in an optional channel.
//
// State is persisted to bot/notifications.json (and committed back to the
// repo when admins add/remove items, so config survives the 6h Actions
// container restart).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { canManageBot } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const NOTIFICATIONS_PATH = path.resolve(__dirname, "..", "notifications.json");

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MAX_ITEMS = 25;

let _data = { items: [] };
let _seq = 1;
let _legacyGuildId = null;

export function setLegacyGuildId(guildId) {
  _legacyGuildId = guildId ? String(guildId) : null;
}

function belongsToGuild(it, guildId) {
  if (!guildId) return !it.guildId;
  const id = String(guildId);
  return String(it.guildId || "") === id ||
    (!it.guildId && _legacyGuildId === id);
}

function isValidItem(it) {
  return (
    it && typeof it.id === "string" &&
    typeof it.time === "string" && TIME_RE.test(it.time) &&
    typeof it.message === "string" && it.message.length > 0 &&
    (it.roleId == null || typeof it.roleId === "string") &&
    (it.channelId == null || typeof it.channelId === "string")
  );
}

function load() {
  if (!fs.existsSync(NOTIFICATIONS_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf8"));
    if (Array.isArray(raw?.items)) {
      _data = { items: raw.items.filter(isValidItem) };
    }
    let maxSeq = 0;
    for (const it of _data.items) {
      const n = parseInt(String(it.id).replace(/^n/, ""), 10);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
    _seq = maxSeq + 1;
  } catch (err) {
    console.error("[notify] failed to parse notifications.json:", err?.message);
  }
}
load();

function nextId() { return `n${_seq++}`; }

function normalizeTime(input) {
  const m = TIME_RE.exec(String(input || "").trim());
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${m[2]}`;
}

export function listNotifications(guildId = null) {
  return _data.items
    .filter((it) => belongsToGuild(it, guildId))
    .map((it) => ({ ...it }));
}

export function getNotification(id, guildId = null) {
  const found = _data.items.find((it) => it.id === id && belongsToGuild(it, guildId));
  return found ? { ...found } : null;
}

export function addNotification({ guildId = null, time, label, message, roleId = null, channelId = null }) {
  const scopedCount = _data.items.filter((it) => belongsToGuild(it, guildId)).length;
  if (scopedCount >= MAX_ITEMS) {
    throw new Error(`มีรายการครบ ${MAX_ITEMS} แล้ว — ลบของเก่าก่อน`);
  }
  const t = normalizeTime(time);
  if (!t) throw new Error("เวลาต้องอยู่ในรูป HH:MM (00:00 - 23:59)");
  const msg = String(message || "").trim();
  if (!msg) throw new Error("ต้องมีข้อความแจ้งเตือน");
  const item = {
    id: nextId(),
    guildId: guildId ? String(guildId) : null,
    time: t,
    label: String(label || "").trim().slice(0, 60) || `แจ้งเตือน ${t}`,
    message: msg.slice(0, 1500),
    roleId: roleId || null,
    channelId: channelId || null,
    lastFiredYMD: null,
  };
  _data.items.push(item);
  return { ...item };
}

export function updateNotification(id, patch, guildId = null) {
  const it = _data.items.find((x) => x.id === id);
  if (!it || !belongsToGuild(it, guildId)) return null;
  if (patch.time !== undefined) {
    const t = normalizeTime(patch.time);
    if (!t) throw new Error("เวลาต้องอยู่ในรูป HH:MM");
    it.time = t;
    it.lastFiredYMD = null; // re-arm for today if time changed
  }
  if (patch.label !== undefined) it.label = String(patch.label || "").trim().slice(0, 60) || it.label;
  if (patch.message !== undefined) {
    const m = String(patch.message || "").trim();
    if (!m) throw new Error("ข้อความว่างไม่ได้");
    it.message = m.slice(0, 1500);
  }
  if (patch.roleId !== undefined) it.roleId = patch.roleId || null;
  if (patch.channelId !== undefined) it.channelId = patch.channelId || null;
  return { ...it };
}

export function removeNotification(id, guildId = null) {
  const target = _data.items.find((it) => it.id === id && belongsToGuild(it, guildId));
  if (!target) return false;
  const before = _data.items.length;
  _data.items = _data.items.filter((it) => it.id !== id);
  return _data.items.length < before;
}

export function exportData() {
  return { items: _data.items.map((it) => ({ ...it })) };
}

export function persistLocal() {
  fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(_data, null, 2) + "\n");
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

function bangkokYmdHm() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return { ymd: `${y}-${mo}-${dd}`, hm: `${hh}:${mm}` };
}

let _running = false;
export async function tickScheduler({ client, guildId, defaultChannelId, guildTargets, legacyGuildId }) {
  if (_running) return;
  const targets = guildTargets?.length
    ? guildTargets
    : (guildId ? [{ guildId, defaultChannelId }] : []);
  if (!_data.items.length || !targets.length) return;
  const { ymd, hm } = bangkokYmdHm();
  const dueByTarget = targets.map((target) => ({
    ...target,
    items: _data.items.filter((it) =>
      it.time === hm &&
      it.lastFiredYMD !== ymd &&
      (String(it.guildId || "") === String(target.guildId) ||
        (!it.guildId && String(legacyGuildId || _legacyGuildId || "") === String(target.guildId))),
    ),
  })).filter((target) => target.items.length);
  if (!dueByTarget.length) return;
  _running = true;
  let changed = false;
  try {
    for (const target of dueByTarget) {
      let guild;
      try {
        guild = await client.guilds.fetch(target.guildId);
      } catch (err) {
        console.error(`[notify] guild ${target.guildId} fetch failed`, err?.message);
        continue;
      }
      for (const it of target.items) {
       try {
       const channelId = it.channelId || target.defaultChannelId;
      if (!channelId) {
        console.warn(`[notify:${it.id}] no channel set and no notifyChannelId — skipping`);
        continue;
      }
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (!ch?.isTextBased?.()) {
        console.warn(`[notify:${it.id}] channel ${channelId} not text-capable`);
        continue;
      }
      const mention = it.roleId ? `<@&${it.roleId}>` : "";
      const embed = new EmbedBuilder()
        .setColor(0xfacc15)
        .setTitle(`🔔 ${it.label}`)
        .setDescription(it.message)
        .setFooter({ text: `เวลา ${it.time} (Asia/Bangkok)` });
      await ch.send({
        content: mention || undefined,
        embeds: [embed],
        allowedMentions: { roles: it.roleId ? [it.roleId] : [], parse: [] },
      });
      it.lastFiredYMD = ymd;
      changed = true;
       } catch (err) {
        console.error(`[notify:${it.id}] send failed`, err?.message);
       }
      }
    }
    if (changed) {
      try { persistLocal(); } catch (err) { console.error("[notify] persist failed", err?.message); }
    }
  } finally {
    _running = false;
  }
}

// ─── UI views & component handler ────────────────────────────────────────────

function fmtItem(it, i) {
  const role = it.roleId ? `<@&${it.roleId}>` : "_ทุกคน_";
  const ch = it.channelId ? `<#${it.channelId}>` : "_ห้องแจ้งเตือนเริ่มต้น_";
  return `**${i + 1}. \`${it.time}\` — ${it.label}**\n• ยศ: ${role}  ·  ห้อง: ${ch}\n• ข้อความ: ${it.message.slice(0, 140)}${it.message.length > 140 ? "…" : ""}`;
}

export function buildPanelView(guildId = null) {
  const items = _data.items.filter((it) => belongsToGuild(it, guildId))
    .slice().sort((a, b) => a.time.localeCompare(b.time));
  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle("⏰ การแจ้งเตือนตามเวลา")
    .setDescription(
      items.length
        ? items.map(fmtItem).join("\n\n").slice(0, 3800)
        : "_ยังไม่มีการแจ้งเตือน — กด **➕ เพิ่ม** เพื่อสร้างใหม่_",
    )
    .setFooter({ text: `${items.length}/${MAX_ITEMS} รายการ · เขตเวลา Asia/Bangkok` });

  const components = [];
  if (items.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId("notify:pick")
      .setPlaceholder("เลือกรายการเพื่อจัดการ")
      .addOptions(
        items.slice(0, 25).map((it) => ({
          label: `${it.time} — ${it.label}`.slice(0, 100),
          description: it.message.slice(0, 100),
          value: it.id,
        })),
      );
    components.push(new ActionRowBuilder().addComponents(select));
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("notify:add").setLabel("➕ เพิ่ม").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("notify:refresh").setLabel("🔄 รีเฟรช").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components };
}

function buildItemView(it) {
  const role = it.roleId ? `<@&${it.roleId}>` : "_ยังไม่ได้ตั้ง (ไม่ ping ใคร)_";
  const ch = it.channelId ? `<#${it.channelId}>` : "_ใช้ห้องแจ้งเตือนเริ่มต้น_";
  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(`⏰ ${it.label}`)
    .setDescription(it.message)
    .addFields(
      { name: "เวลา", value: `\`${it.time}\``, inline: true },
      { name: "ยศที่ ping", value: role, inline: true },
      { name: "ห้อง", value: ch, inline: true },
    )
    .setFooter({ text: `id: ${it.id}` });

  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`notify:role:${it.id}`)
      .setPlaceholder("🎭 เลือกยศที่จะ ping (เลือก 0 = ไม่ ping)")
      .setMinValues(0)
      .setMaxValues(1),
  );
  const chRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`notify:channel:${it.id}`)
      .setPlaceholder("📍 เลือกห้องส่งแจ้งเตือน (ไม่เลือก = ห้องเริ่มต้น)")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0)
      .setMaxValues(1),
  );
  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`notify:edit:${it.id}`).setLabel("✏️ แก้ข้อความ/เวลา").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`notify:delete:${it.id}`).setLabel("🗑️ ลบ").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [roleRow, chRow, btnRow] };
}

function addModal() {
  return new ModalBuilder()
    .setCustomId("notify:add-modal")
    .setTitle("➕ เพิ่มการแจ้งเตือน")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("time").setLabel("เวลา (HH:MM, เขตเวลาไทย)")
          .setStyle(TextInputStyle.Short).setPlaceholder("เช่น 08:00 หรือ 21:30").setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("label").setLabel("ชื่อ / หัวข้อ")
          .setStyle(TextInputStyle.Short).setPlaceholder("เช่น ตื่นนอน, ประชุม, เตือนกินข้าว")
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("message").setLabel("ข้อความที่จะส่ง")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500),
      ),
    );
}

function editModal(it) {
  return new ModalBuilder()
    .setCustomId(`notify:edit-modal:${it.id}`)
    .setTitle("✏️ แก้ไขการแจ้งเตือน")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("time").setLabel("เวลา (HH:MM)")
          .setStyle(TextInputStyle.Short).setValue(it.time).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("label").setLabel("ชื่อ / หัวข้อ")
          .setStyle(TextInputStyle.Short).setValue(it.label).setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("message").setLabel("ข้อความที่จะส่ง")
          .setStyle(TextInputStyle.Paragraph).setValue(it.message).setRequired(true).setMaxLength(1500),
      ),
    );
}

async function persistAndCommit() {
  persistLocal();
  try {
    const { canPersistRemotely, commitNotifications } = await import("./github.js");
    if (canPersistRemotely()) await commitNotifications(exportData());
  } catch (err) {
    console.error("[notify] remote commit failed", err?.message);
  }
}

/**
 * Returns true if the interaction was handled.
 */
export async function handleNotifyComponent(interaction) {
  const id = interaction.customId;
  if (!id || (!id.startsWith("notify:"))) return false;

  if (!canManageBot(interaction.member, interaction.memberPermissions)) {
    await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
    return true;
  }

  try {
    // Refresh main panel
    if (id === "notify:refresh" && interaction.isButton()) {
      await interaction.update(buildPanelView(interaction.guildId));
      return true;
    }

    // Pick an item from the dropdown → show item view
    if (id === "notify:pick" && interaction.isStringSelectMenu()) {
      const itemId = interaction.values[0];
      const it = getNotification(itemId, interaction.guildId);
      if (!it) {
        await interaction.reply({ content: "รายการนี้ไม่อยู่แล้ว", ephemeral: true });
        return true;
      }
      await interaction.reply({ ...buildItemView(it), ephemeral: true });
      return true;
    }

    // Open add modal
    if (id === "notify:add" && interaction.isButton()) {
      await interaction.showModal(addModal());
      return true;
    }

    // Submit add modal
    if (id === "notify:add-modal" && interaction.isModalSubmit()) {
      const time = interaction.fields.getTextInputValue("time");
      const label = interaction.fields.getTextInputValue("label");
      const message = interaction.fields.getTextInputValue("message");
      const item = addNotification({ guildId: interaction.guildId, time, label, message });
      await persistAndCommit();
      await interaction.reply({
        content: `✅ เพิ่มแล้ว: \`${item.time}\` — ${item.label}\nกดเลือกรายการนี้ในเมนูเพื่อตั้งยศ/ห้องที่จะ ping`,
        ephemeral: true,
      });
      return true;
    }

    // Per-item operations: notify:role:<id>, notify:channel:<id>, notify:edit:<id>, notify:delete:<id>, notify:edit-modal:<id>
    const parts = id.split(":");
    const action = parts[1];
    const itemId = parts[2];

    if (action === "role" && interaction.isRoleSelectMenu?.()) {
      const role = interaction.values?.[0] ?? null;
      const updated = updateNotification(itemId, { roleId: role }, interaction.guildId);
      if (!updated) { await interaction.reply({ content: "รายการหายไปแล้ว", ephemeral: true }); return true; }
      await persistAndCommit();
      await interaction.update(buildItemView(updated));
      return true;
    }

    if (action === "channel" && interaction.isChannelSelectMenu?.()) {
      const ch = interaction.values?.[0] ?? null;
      const updated = updateNotification(itemId, { channelId: ch }, interaction.guildId);
      if (!updated) { await interaction.reply({ content: "รายการหายไปแล้ว", ephemeral: true }); return true; }
      await persistAndCommit();
      await interaction.update(buildItemView(updated));
      return true;
    }

    if (action === "edit" && interaction.isButton()) {
      const it = getNotification(itemId, interaction.guildId);
      if (!it) { await interaction.reply({ content: "รายการหายไปแล้ว", ephemeral: true }); return true; }
      await interaction.showModal(editModal(it));
      return true;
    }

    if (action === "edit-modal" && interaction.isModalSubmit()) {
      const time = interaction.fields.getTextInputValue("time");
      const label = interaction.fields.getTextInputValue("label");
      const message = interaction.fields.getTextInputValue("message");
      const updated = updateNotification(itemId, { time, label, message }, interaction.guildId);
      if (!updated) { await interaction.reply({ content: "รายการหายไปแล้ว", ephemeral: true }); return true; }
      await persistAndCommit();
      await interaction.reply({ content: `✅ บันทึกแล้ว: \`${updated.time}\` — ${updated.label}`, ephemeral: true });
      return true;
    }

    if (action === "delete" && interaction.isButton()) {
      const ok = removeNotification(itemId, interaction.guildId);
      await persistAndCommit();
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle(ok ? "🗑️ ลบแล้ว" : "ไม่พบ").setDescription(ok ? "ลบการแจ้งเตือนเรียบร้อย" : "รายการนี้ไม่อยู่แล้ว")],
        components: [],
      });
      return true;
    }
  } catch (err) {
    console.error("[notify] handler error", err?.message);
    const msg = `❌ ${err?.message ?? "เกิดข้อผิดพลาด"}`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
    return true;
  }
  return false;
}

export async function handleNotifyCommand(interaction) {
  if (!canManageBot(interaction.member, interaction.memberPermissions)) {
    await interaction.reply({ content: "ต้องมีสิทธิ์ Manage Server เท่านั้น", ephemeral: true });
    return;
  }
  await interaction.reply({ ...buildPanelView(interaction.guildId), ephemeral: true });
}
