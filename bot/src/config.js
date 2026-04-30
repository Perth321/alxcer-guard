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
};

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      console.error("[config] failed to parse config.json:", err?.message);
      raw = {};
    }
  }
  return normalize({ ...DEFAULTS, ...raw });
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
