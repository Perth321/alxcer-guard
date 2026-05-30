// Persistent scheduled automations (recurring tasks).
// Stored as bot/automations.json in the repo for cross-restart persistence.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "automations.json");

let _automations = {};

let _seq = 1;
function nextId() {
  return `auto${Date.now().toString(36)}${(_seq++).toString(36)}`;
}

export function loadAutomations() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") _automations = parsed;
    }
  } catch (e) {
    console.warn("[automations] load failed:", e?.message);
    _automations = {};
  }
  return _automations;
}

export function writeAutomationsLocal(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

export function allAutomations() {
  return _automations;
}

export function createAutomation({ label, guildId, channelId, createdBy, hour, minute, days, task }) {
  const id = nextId();
  const rec = {
    id, label,
    guildId: String(guildId),
    channelId: String(channelId),
    createdBy: String(createdBy || ""),
    hour: Number(hour),
    minute: Number(minute),
    days: Array.isArray(days) ? days : ["daily"],
    task: String(task),
    enabled: true,
    createdAt: Date.now(),
    lastFiredAt: null,
  };
  _automations[id] = rec;
  return rec;
}

export function getAutomation(id) {
  return _automations[id] || null;
}

export function cancelAutomationById(id) {
  if (!_automations[id]) return false;
  delete _automations[id];
  return true;
}

export function listAutomations({ guildId } = {}) {
  return Object.values(_automations).filter(a => !guildId || a.guildId === guildId);
}

/**
 * Get automations due to fire RIGHT NOW (Bangkok time, UTC+7).
 * "Due" = enabled + day matches today + hour+minute matches now
 *         + not fired in the last 55 minutes (prevent double-fire).
 */
export function getDueAutomations(now = Date.now()) {
  const bangkokNow = new Date(now + 7 * 3600 * 1000);
  const currentHour = bangkokNow.getUTCHours();
  const currentMin  = bangkokNow.getUTCMinutes();
  const dow         = bangkokNow.getUTCDay(); // 0=Sun
  const DOW_NAMES   = ["sun","mon","tue","wed","thu","fri","sat"];
  const todayName   = DOW_NAMES[dow];
  const isWeekday   = dow >= 1 && dow <= 5;
  const isWeekend   = dow === 0 || dow === 6;

  const due = [];
  for (const a of Object.values(_automations)) {
    if (!a.enabled) continue;
    if (a.hour !== currentHour || a.minute !== currentMin) continue;
    const days = a.days || ["daily"];
    const dayMatch =
      days.includes("daily") ||
      days.includes(todayName) ||
      (days.some(d => ["weekday","weekdays","จันทร์-ศุกร์"].includes(d)) && isWeekday) ||
      (days.some(d => ["weekend","weekends","เสาร์-อาทิตย์"].includes(d)) && isWeekend);
    if (!dayMatch) continue;
    // Don't fire twice within 55 min
    if (a.lastFiredAt && now - a.lastFiredAt < 55 * 60 * 1000) continue;
    due.push(a);
  }
  return due;
}

export function markFiredAutomation(id, now = Date.now()) {
  if (_automations[id]) _automations[id].lastFiredAt = now;
}
