import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");
export const CONFIG_VERSION = 2;

export const GUILD_DEFAULTS = Object.freeze({
  voiceChannelId: "",
  notifyChannelId: "",
  warningSeconds: 180,
  muteSeconds: 300,
  ignoreBots: true,
  // Potentially disruptive moderation/AI behaviors are opt-in per guild.
  inactivityMuteEnabled: false,
  voiceWordBanEnabled: false,
  chatVoiceMuteEnabled: false,
  // Stay silent when joining/reconnecting. The only default beep is the
  // acknowledgement after a user explicitly says the wake word.
  joinSoundEnabled: false,
  // Teacher join/leave events must not start timers, bells, or TTS unless a
  // server admin deliberately opts in.
  classroomAutomationEnabled: false,
  aiModerationEnabled: false,
  spontaneousChatEnabled: false,
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
  // Voice channels where the bot should join silently.
  silentJoinChannelIds: [],
  classEndTtsText:
    "ตอนนี้เวลานี้ หมดเวลาเรียนของวันนี้แล้ว ขอให้นักเรียนทุกท่าน และอาจารย์ทุกท่านหยุดทำการสอน และขอให้ทุกท่านเดินทางโดยสวัสดิภาพ",
  classStartTtsText:
    "เริ่มคาบเรียนแล้ว ขอให้นักเรียนทุกท่านเตรียมตัวให้พร้อม และตั้งใจเรียน",
});

function emptyStore() {
  return {
    version: CONFIG_VERSION,
    ownerId: "",
    primaryGuildId: "",
    guilds: {},
  };
}

function stringId(value) {
  return value == null || value === "" ? "" : String(value);
}

export function normalizeGuildConfig(cfg = {}) {
  return {
    voiceChannelId: stringId(cfg.voiceChannelId),
    notifyChannelId: stringId(cfg.notifyChannelId),
    warningSeconds: clampInt(cfg.warningSeconds, 5, 3600, GUILD_DEFAULTS.warningSeconds),
    muteSeconds: clampInt(cfg.muteSeconds, 10, 3600, GUILD_DEFAULTS.muteSeconds),
    ignoreBots: cfg.ignoreBots !== false,
    inactivityMuteEnabled: cfg.inactivityMuteEnabled === true,
    voiceWordBanEnabled: cfg.voiceWordBanEnabled === true,
    chatVoiceMuteEnabled: cfg.chatVoiceMuteEnabled === true,
    joinSoundEnabled: cfg.joinSoundEnabled === true,
    classroomAutomationEnabled: cfg.classroomAutomationEnabled === true,
    aiModerationEnabled: cfg.aiModerationEnabled === true,
    spontaneousChatEnabled: cfg.spontaneousChatEnabled === true,
    bannedWords: normalizeWords(cfg.bannedWords ?? GUILD_DEFAULTS.bannedWords),
    firstOffenseMuteSeconds: clampInt(
      cfg.firstOffenseMuteSeconds,
      5,
      86400,
      GUILD_DEFAULTS.firstOffenseMuteSeconds,
    ),
    repeatOffenseMuteSeconds: clampInt(
      cfg.repeatOffenseMuteSeconds,
      5,
      86400,
      GUILD_DEFAULTS.repeatOffenseMuteSeconds,
    ),
    wakeMusicUrl:
      typeof cfg.wakeMusicUrl === "string" ? cfg.wakeMusicUrl.trim() : GUILD_DEFAULTS.wakeMusicUrl,
    wakeTtsText:
      typeof cfg.wakeTtsText === "string" && cfg.wakeTtsText.trim()
        ? cfg.wakeTtsText.trim()
        : GUILD_DEFAULTS.wakeTtsText,
    studentRoleId: stringId(cfg.studentRoleId),
    teacherRoleId: stringId(cfg.teacherRoleId),
    classDurationMinutes: clampInt(
      cfg.classDurationMinutes,
      5,
      600,
      GUILD_DEFAULTS.classDurationMinutes,
    ),
    silentJoinChannelIds: Array.isArray(cfg.silentJoinChannelIds)
      ? Array.from(
          new Set(
            cfg.silentJoinChannelIds
              .filter((value) => typeof value === "string" && value)
              .map(String),
          ),
        )
      : [],
    classEndTtsText:
      typeof cfg.classEndTtsText === "string" && cfg.classEndTtsText.trim()
        ? cfg.classEndTtsText.trim()
        : GUILD_DEFAULTS.classEndTtsText,
    classStartTtsText:
      typeof cfg.classStartTtsText === "string" && cfg.classStartTtsText.trim()
        ? cfg.classStartTtsText.trim()
        : GUILD_DEFAULTS.classStartTtsText,
  };
}

// Compatibility alias for callers that still normalize a single guild config.
export const normalize = normalizeGuildConfig;

/**
 * Normalize either the v2 store or the former flat, single-guild config.
 * Legacy input is migrated in memory without discarding any guild settings.
 */
export function normalizeConfigStore(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyStore();

  if (raw.version === CONFIG_VERSION && raw.guilds && typeof raw.guilds === "object") {
    const guilds = {};
    for (const [guildId, guildConfig] of Object.entries(raw.guilds)) {
      const id = stringId(guildId);
      if (!id || !guildConfig || typeof guildConfig !== "object") continue;
      guilds[id] = normalizeGuildConfig(guildConfig);
    }
    const configuredPrimary = stringId(raw.primaryGuildId);
    const primaryGuildId = guilds[configuredPrimary]
      ? configuredPrimary
      : Object.keys(guilds)[0] || "";
    return {
      version: CONFIG_VERSION,
      ownerId: stringId(raw.ownerId),
      primaryGuildId,
      guilds,
    };
  }

  // v1: all settings lived at the root beside guildId and ownerId.
  const guildId = stringId(raw.guildId);
  const store = emptyStore();
  store.ownerId = stringId(raw.ownerId);
  store.primaryGuildId = guildId;
  if (guildId) store.guilds[guildId] = normalizeGuildConfig(raw);
  return store;
}

export function loadConfigStore() {
  if (!fs.existsSync(CONFIG_PATH)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return normalizeConfigStore(raw);
  } catch (err) {
    console.error("[config] failed to parse config.json:", err?.message);
    return emptyStore();
  }
}

export function hasGuildConfig(store, guildId) {
  const normalizedStore = normalizeConfigStore(store);
  return Object.hasOwn(normalizedStore.guilds, stringId(guildId));
}

export function getGuildConfig(store, guildId) {
  const normalizedStore = normalizeConfigStore(store);
  const id = stringId(guildId);
  return normalizeGuildConfig(
    id && normalizedStore.guilds[id] ? normalizedStore.guilds[id] : GUILD_DEFAULTS,
  );
}

export function setGuildConfig(store, guildId, value = {}) {
  const id = stringId(guildId);
  if (!id) throw new Error("guildId is required");
  const normalizedStore = normalizeConfigStore(store);
  return {
    ...normalizedStore,
    primaryGuildId: normalizedStore.primaryGuildId || id,
    guilds: {
      ...normalizedStore.guilds,
      [id]: normalizeGuildConfig(value),
    },
  };
}

export function updateGuildConfig(store, guildId, patch = {}) {
  const id = stringId(guildId);
  if (!id) throw new Error("guildId is required");
  const normalizedStore = normalizeConfigStore(store);
  const current = getGuildConfig(normalizedStore, id);
  return setGuildConfig(normalizedStore, id, { ...current, ...patch });
}

export function updateOwnerId(store, ownerId) {
  return { ...normalizeConfigStore(store), ownerId: stringId(ownerId) };
}

export function toLegacyConfig(store, guildId = null) {
  const normalizedStore = normalizeConfigStore(store);
  const id =
    stringId(guildId) ||
    normalizedStore.primaryGuildId ||
    Object.keys(normalizedStore.guilds)[0] ||
    "";
  return {
    ...getGuildConfig(normalizedStore, id),
    guildId: id,
    ownerId: normalizedStore.ownerId,
  };
}

/**
 * Compatibility loader for code that still expects the former flat shape.
 * New multi-guild code should use loadConfigStore/getGuildConfig instead.
 */
export function loadConfig() {
  return toLegacyConfig(loadConfigStore());
}

export function writeConfigStore(store) {
  const normalizedStore = normalizeConfigStore(store);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalizedStore, null, 2) + "\n");
  return normalizedStore;
}

/**
 * Backward-compatible writer. A flat v1 config updates only its guild inside
 * the v2 store, so an older call site cannot erase other guilds.
 */
export function writeLocal(value) {
  if (value?.version === CONFIG_VERSION && value?.guilds) {
    return writeConfigStore(value);
  }

  const legacy = value && typeof value === "object" ? value : {};
  const existing = loadConfigStore();
  const guildId = stringId(legacy.guildId) || existing.primaryGuildId;
  let next = existing;
  if (guildId) next = updateGuildConfig(next, guildId, legacy);
  if (legacy.ownerId !== undefined) next = updateOwnerId(next, legacy.ownerId);
  return writeConfigStore(next);
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
  for (const word of value) {
    if (typeof word !== "string") continue;
    const trimmed = word.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
