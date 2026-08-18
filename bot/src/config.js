import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

const DEFAULTS = {
  guildId: "",
  voiceChannelId: "",
  notifyChannelId: "",
  warningSeconds: 180,
  muteSeconds: 300,
  ignoreBots: true,
  bannedWords: ["หี", "ขอดูหี", "ดูหี"],
  firstOffenseMuteSeconds: 60,
  repeatOffenseMuteSeconds: 3600,
  // Wake-alarm: URL of an MP3/OGG/WAV stream to loop while waking the user.
  // Empty = fall back to a soft synthesized chime + repeated TTS.
  wakeMusicUrl: "",
  wakeTtsText: "ขออนุญาตปลุกนะครับ ตื่นได้แล้วเด้อ",
  // Classroom mode
  studentRoleId: "",
  teacherRoleId: "",
  classDurationMinutes: 60,
  // Discord user ID of the bot owner — gets full admin-level trust even without the Discord Administrator role.
  ownerId: "",
  // Voice channels where the bot should join SILENTLY (no greeting.mp3, no
  // join-beep). Useful for dedicated study/class rooms where the greeting is
  // disruptive. List of channel IDs.
  silentJoinChannelIds: [],
  classEndTtsText:
    "ตอนนี้เวลานี้ หมดเวลาเรียนของวันนี้แล้ว ขอให้นักเรียนทุกท่าน และอาจารย์ทุกท่านหยุดทำการสอน และขอให้ทุกท่านเดินทางโดยสวัสดิภาพ",
  classStartTtsText:
    "เริ่มคาบเรียนแล้ว ขอให้นักเรียนทุกท่านเตรียมตัวให้พร้อม และตั้งใจเรียน",
};

export function loadConfig() {
  const raw = readRaw();
  return normalize({ ...DEFAULTS, ...raw });
}

/**
 * Load settings for a specific guild while keeping the original flat
 * config.json format backwards compatible. New guild settings live under
 * `guilds[guildId]`; the legacy top-level object remains the primary guild.
 */
export function loadConfigForGuild(guildId) {
  if (!guildId) return loadConfig();
  const raw = readRaw();
  const scoped = raw.guilds?.[String(guildId)];
  if (scoped && typeof scoped === "object") {
    return normalize({ ...DEFAULTS, ...scoped, guildId });
  }
  if (raw.guildId && String(raw.guildId) === String(guildId)) {
    return normalize({ ...DEFAULTS, ...raw, guildId });
  }
  return normalize({ ...DEFAULTS, guildId });
}

/**
 * Write one guild's settings into a multi-guild config document and return
 * the complete document for remote persistence.
 */
export function writeGuildConfig(guildId, cfg) {
  const id = String(guildId || cfg?.guildId || "");
  if (!id) {
    writeLocal(cfg);
    return cfg;
  }

  const raw = readRaw();
  const nextGuildConfig = normalize({ ...cfg, guildId: id });
  const guilds =
    raw.guilds && typeof raw.guilds === "object" && !Array.isArray(raw.guilds)
      ? { ...raw.guilds }
      : {};
  guilds[id] = nextGuildConfig;

  const next = { ...raw, guilds };
  // Keep legacy readers and the current single-guild runtime working. The
  // first configured guild becomes the legacy primary until migrated fully.
  if (!raw.guildId || String(raw.guildId) === id) {
    Object.assign(next, nextGuildConfig);
  }
  writeLocal(next);
  return next;
}

export function normalize(cfg) {
  return {
    guildId: cfg.guildId ? String(cfg.guildId) : "",
    voiceChannelId: cfg.voiceChannelId ? String(cfg.voiceChannelId) : "",
    notifyChannelId: cfg.notifyChannelId ? String(cfg.notifyChannelId) : "",
    warningSeconds: clampInt(cfg.warningSeconds, 5, 3600, 180),
    muteSeconds: clampInt(cfg.muteSeconds, 10, 3600, 300),
    ignoreBots: cfg.ignoreBots !== false,
    bannedWords: normalizeWords(cfg.bannedWords),
    firstOffenseMuteSeconds: clampInt(cfg.firstOffenseMuteSeconds, 5, 86400, 60),
    repeatOffenseMuteSeconds: clampInt(cfg.repeatOffenseMuteSeconds, 5, 86400, 3600),
    wakeMusicUrl: typeof cfg.wakeMusicUrl === "string" ? cfg.wakeMusicUrl.trim() : "",
    wakeTtsText: typeof cfg.wakeTtsText === "string" && cfg.wakeTtsText.trim()
      ? cfg.wakeTtsText.trim()
      : DEFAULTS.wakeTtsText,
    studentRoleId: cfg.studentRoleId ? String(cfg.studentRoleId) : "",
    teacherRoleId: cfg.teacherRoleId ? String(cfg.teacherRoleId) : "",
    classDurationMinutes: clampInt(cfg.classDurationMinutes, 5, 600, 60),
    ownerId: cfg.ownerId ? String(cfg.ownerId) : "",
    silentJoinChannelIds: Array.isArray(cfg.silentJoinChannelIds)
      ? Array.from(new Set(cfg.silentJoinChannelIds.filter((x) => typeof x === "string" && x).map(String)))
      : [],
    classEndTtsText:
      typeof cfg.classEndTtsText === "string" && cfg.classEndTtsText.trim()
        ? cfg.classEndTtsText.trim()
        : DEFAULTS.classEndTtsText,
    classStartTtsText:
      typeof cfg.classStartTtsText === "string" && cfg.classStartTtsText.trim()
        ? cfg.classStartTtsText.trim()
        : DEFAULTS.classStartTtsText,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeWords(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const w of value) {
    if (typeof w !== "string") continue;
    const trimmed = w.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function writeLocal(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function readRaw() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    console.error("[config] failed to parse config.json:", err?.message);
    return {};
  }
}
