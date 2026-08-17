// Timer/alarm/sleep/auto-mute manager.
//
// All long-running per-user actions go through here so we can:
//   - List & cancel them via Discord buttons or agent tools
//   - Survive across multiple ticks without leaking
//   - Render pretty embeds with live countdowns
//
// Persistence: active timers are stored in bot/timers.json and can be pushed
// back to GitHub by index.js, so timers survive GitHub Actions restarts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "timers.json");
const STALE_AFTER_MS = 12 * 3600 * 1000;

const TYPES = new Set(["timer", "alarm", "sleep_disconnect", "group_sleep", "auto_unmute", "wake_alarm"]);

let _seq = 1;
function nextId() {
  return `t${Date.now().toString(36)}${(_seq++).toString(36)}`;
}

const _timers = new Map(); // id -> record
let _remotePersist = null;
let _remotePersistHandle = null;
let _lastPersistSignature = "";

/**
 * @typedef {Object} TimerRecord
 * @property {string} id
 * @property {"timer"|"alarm"|"sleep_disconnect"|"auto_unmute"|"wake_alarm"} type
 * @property {number} createdAt
 * @property {number} fireAt
 * @property {string} label
 * @property {string} guildId
 * @property {string|null} channelId       Discord text channel for notifications
 * @property {string|null} userId          The user who owns / is the target
 * @property {string|null} mentionUserId   Who to ping when fired
 * @property {Object} payload              Extra data per type
 * @property {string|null} messageId       Last embed message id (so we can edit)
 * @property {boolean} fired
 * @property {boolean} cancelled
 * @property {string|null} ownerId         Who created it (admin)
 */

export function loadTimers() {
  _timers.clear();
  try {
    if (!fs.existsSync(DATA_FILE)) {
      _lastPersistSignature = JSON.stringify([]);
      return _timers;
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.timers)
        ? parsed.timers
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];
    const now = Date.now();
    let restored = 0;
    let dropped = 0;
    for (const raw of list) {
      const rec = normalizeRecord(raw);
      if (!rec) {
        dropped++;
        continue;
      }
      if (rec.fireAt < now - STALE_AFTER_MS) {
        dropped++;
        continue;
      }
      _timers.set(rec.id, rec);
      restored++;
    }
    _lastPersistSignature = signature();
    console.log(`[timers] loaded ${restored} persisted timer(s)${dropped ? `, dropped ${dropped} stale/invalid` : ""}`);
  } catch (err) {
    console.warn("[timers] load failed:", err?.message);
    _lastPersistSignature = JSON.stringify([]);
  }
  return _timers;
}

export function setRemotePersist(fn) {
  _remotePersist = typeof fn === "function" ? fn : null;
}

export function writeTimersLocal(data = serializeTimers()) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  _lastPersistSignature = JSON.stringify((data?.timers || []).map((t) => sanitizeRecord(t)));
}

export function allTimers() {
  return serializeTimers();
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!TYPES.has(raw.type)) return null;
  const fireAt = Number(raw.fireAt);
  if (!Number.isFinite(fireAt)) return null;
  const id = raw.id ? String(raw.id) : nextId();
  return {
    id,
    type: raw.type,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    fireAt,
    label: String(raw.label || "").slice(0, 200),
    guildId: raw.guildId ? String(raw.guildId) : "",
    channelId: raw.channelId ? String(raw.channelId) : null,
    userId: raw.userId ? String(raw.userId) : null,
    mentionUserId: raw.mentionUserId ? String(raw.mentionUserId) : null,
    payload: raw.payload && typeof raw.payload === "object" ? raw.payload : {},
    messageId: raw.messageId ? String(raw.messageId) : null,
    fired: false,
    cancelled: false,
    ownerId: raw.ownerId ? String(raw.ownerId) : null,
  };
}

function sanitizeRecord(rec) {
  return {
    id: rec.id,
    type: rec.type,
    createdAt: rec.createdAt,
    fireAt: rec.fireAt,
    label: rec.label || "",
    guildId: rec.guildId,
    channelId: rec.channelId || null,
    userId: rec.userId || null,
    mentionUserId: rec.mentionUserId || null,
    payload: rec.payload || {},
    messageId: rec.messageId || null,
    ownerId: rec.ownerId || null,
  };
}

function activeRecords() {
  return [..._timers.values()]
    .filter((t) => !t.cancelled && !t.fired)
    .sort((a, b) => a.fireAt - b.fireAt)
    .map(sanitizeRecord);
}

function serializeTimers() {
  return {
    version: 1,
    updatedAt: Date.now(),
    timers: activeRecords(),
  };
}

function signature() {
  return JSON.stringify(activeRecords());
}

function persistTimers({ remote = true } = {}) {
  const nextSignature = signature();
  if (nextSignature === _lastPersistSignature) return;
  const data = serializeTimers();
  writeTimersLocal(data);
  if (remote) scheduleRemotePersist();
}

function scheduleRemotePersist() {
  if (!_remotePersist) return;
  if (_remotePersistHandle) clearTimeout(_remotePersistHandle);
  _remotePersistHandle = setTimeout(async () => {
    _remotePersistHandle = null;
    try {
      await _remotePersist(serializeTimers());
    } catch (err) {
      console.warn("[timers] remote persist failed:", err?.message);
    }
  }, 1500);
  _remotePersistHandle.unref?.();
}

export function createTimer({
  type,
  fireAt,
  label = "",
  guildId,
  channelId = null,
  userId = null,
  mentionUserId = null,
  payload = {},
  ownerId = null,
}) {
  if (!TYPES.has(type)) throw new Error(`unknown timer type: ${type}`);
  if (!Number.isFinite(fireAt) || fireAt < Date.now() - 1000) {
    throw new Error("fireAt must be a future timestamp");
  }
  const id = nextId();
  const rec = {
    id,
    type,
    createdAt: Date.now(),
    fireAt,
    label: String(label || "").slice(0, 200),
    guildId,
    channelId,
    userId,
    mentionUserId,
    payload: payload || {},
    messageId: null,
    fired: false,
    cancelled: false,
    ownerId,
  };
  _timers.set(id, rec);
  persistTimers();
  return rec;
}

export function getTimer(id) {
  return _timers.get(id) || null;
}

export function cancelTimer(id) {
  const t = _timers.get(id);
  if (!t) return false;
  t.cancelled = true;
  _timers.delete(id);
  persistTimers();
  return true;
}

/** Mark fired but keep around for a moment so the runner can still reach it. */
export function markFired(id) {
  const t = _timers.get(id);
  if (!t) return false;
  t.fired = true;
  return true;
}

export function deleteTimer(id) {
  const ok = _timers.delete(id);
  if (ok) persistTimers();
  return ok;
}

export function setMessageId(id, messageId) {
  const t = _timers.get(id);
  if (t) {
    t.messageId = messageId;
    persistTimers();
  }
}

export function listTimers({ userId, guildId, type, includeFired = false } = {}) {
  const out = [];
  for (const t of _timers.values()) {
    if (t.cancelled) continue;
    if (!includeFired && t.fired) continue;
    if (guildId && t.guildId !== guildId) continue;
    if (userId && t.userId !== userId && t.mentionUserId !== userId && t.ownerId !== userId) continue;
    if (type && t.type !== type) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

export function dueTimers(now = Date.now()) {
  const out = [];
  for (const t of _timers.values()) {
    if (t.cancelled || t.fired) continue;
    if (t.fireAt <= now) out.push(t);
  }
  return out;
}

export function allActive() {
  return [...listTimers({ includeFired: false })];
}

// ===== Helpers used by the agent / index.js =====

/**
 * Parse an "in X" duration to a future timestamp.
 * Returns { fireAt, totalSeconds } or throws on invalid input.
 */
export function parseDurationToFireAt({ seconds = 0, minutes = 0, hours = 0 }) {
  const s = Math.round(Number(seconds) || 0);
  const m = Math.round(Number(minutes) || 0);
  const h = Math.round(Number(hours) || 0);
  const total = s + m * 60 + h * 3600;
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("duration must be > 0 seconds");
  }
  if (total > 6 * 3600) {
    throw new Error("duration too long (max 6 hours — bot only runs 6h)");
  }
  return { fireAt: Date.now() + total * 1000, totalSeconds: total };
}

/**
 * Compute the next fire time for an "alarm at HH:MM:SS" in Asia/Bangkok.
 * If the time has already passed today, schedule for tomorrow.
 */
export function alarmAtToFireAt({ hour, minute, second = 0, tzOffsetMinutes = 7 * 60 }) {
  const h = Number(hour);
  const m = Number(minute);
  const s = Number(second);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error("hour must be 0-23");
  if (!Number.isInteger(m) || m < 0 || m > 59) throw new Error("minute must be 0-59");
  if (!Number.isInteger(s) || s < 0 || s > 59) throw new Error("second must be 0-59");

  const now = Date.now();
  // Convert "now" to the target TZ
  const nowTz = new Date(now + tzOffsetMinutes * 60 * 1000);
  const y = nowTz.getUTCFullYear();
  const mo = nowTz.getUTCMonth();
  const d = nowTz.getUTCDate();
  // Build target time in the same TZ then back to UTC
  let target = Date.UTC(y, mo, d, h, m, s) - tzOffsetMinutes * 60 * 1000;
  if (target <= now + 500) target += 24 * 3600 * 1000;
  const totalSeconds = Math.round((target - now) / 1000);
  return { fireAt: target, totalSeconds };
}

export function formatDurationShort(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}ชม`);
  if (m > 0) parts.push(`${m}น`);
  if (s > 0 || parts.length === 0) parts.push(`${s}ว`);
  return parts.join(" ");
}

export function formatClockBangkok(ts) {
  const d = new Date(ts + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function summary() {
  const all = allActive();
  return {
    total: all.length,
    byType: all.reduce((acc, t) => {
      acc[t.type] = (acc[t.type] || 0) + 1;
      return acc;
    }, {}),
  };
}
