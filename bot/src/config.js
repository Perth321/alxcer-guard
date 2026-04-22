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
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function writeLocal(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
