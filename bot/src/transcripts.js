import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRANSCRIPTS_PATH = path.resolve(
  __dirname,
  "..",
  "transcripts.json",
);

const RETENTION_MS = 7 * 24 * 3600 * 1000;
const HARD_CAP = 5000;
const REMOTE_DEBOUNCE_MS = 60_000;

let buffer = [];
let remoteCallback = null;
let remoteTimer = null;
let lastRemoteCommitAt = 0;
let dirtySinceRemote = false;

function pruneOld(entries) {
  const cutoff = Date.now() - RETENTION_MS;
  let result = entries.filter((e) => e && e.timestamp && e.timestamp >= cutoff);
  if (result.length > HARD_CAP) result = result.slice(-HARD_CAP);
  return result;
}

export function loadFromDisk() {
  try {
    if (!fs.existsSync(TRANSCRIPTS_PATH)) {
      buffer = [];
      console.log("[transcripts] no existing file, starting fresh");
      return;
    }
    const raw = JSON.parse(fs.readFileSync(TRANSCRIPTS_PATH, "utf8"));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const before = entries.length;
    buffer = pruneOld(entries);
    console.log(
      `[transcripts] loaded ${buffer.length} entries from disk (pruned ${before - buffer.length} old)`,
    );
  } catch (err) {
    console.error("[transcripts] load failed", err?.message);
    buffer = [];
  }
}

function saveLocal() {
  try {
    fs.writeFileSync(
      TRANSCRIPTS_PATH,
      JSON.stringify({ version: 1, entries: buffer }) + "\n",
    );
  } catch (err) {
    console.error("[transcripts] local save failed", err?.message);
  }
}

function scheduleRemoteSave() {
  if (!remoteCallback) return;
  dirtySinceRemote = true;
  if (remoteTimer) return;
  const sinceLast = Date.now() - lastRemoteCommitAt;
  const wait = Math.max(REMOTE_DEBOUNCE_MS - sinceLast, 5_000);
  remoteTimer = setTimeout(async () => {
    remoteTimer = null;
    if (!dirtySinceRemote) return;
    dirtySinceRemote = false;
    lastRemoteCommitAt = Date.now();
    try {
      await remoteCallback({ version: 1, entries: buffer });
    } catch (err) {
      console.error("[transcripts] remote commit failed", err?.message);
      dirtySinceRemote = true;
    }
  }, wait);
}

export function setRemotePersist(fn) {
  remoteCallback = fn;
}

export function addTranscript(entry) {
  buffer.push({
    timestamp: Date.now(),
    userId: entry.userId || "unknown",
    username: entry.username || "",
    text: entry.text || "",
    durationSec: entry.durationSec || 0,
    source: entry.source || "voice",
    flagged: !!entry.flagged,
    flaggedWord: entry.flaggedWord || null,
  });
  buffer = pruneOld(buffer);
  saveLocal();
  scheduleRemoteSave();
}

function withinRange(ts, fromMs, toMs) {
  if (fromMs != null && ts < fromMs) return false;
  if (toMs != null && ts >= toMs) return false;
  return true;
}

export function getRecent({
  userId = null,
  limit = 20,
  flaggedOnly = false,
  fromMs = null,
  toMs = null,
} = {}) {
  let result = buffer;
  if (fromMs != null || toMs != null) {
    result = result.filter((e) => withinRange(e.timestamp, fromMs, toMs));
  }
  if (flaggedOnly) result = result.filter((e) => e.flagged);
  if (userId) result = result.filter((e) => e.userId === userId);
  if (result.length <= limit) return result.slice();
  return result.slice(-limit);
}

export function getCursingStats({ fromMs = null, toMs = null } = {}) {
  const perUser = new Map();
  let totalFlagged = 0;
  let totalUtterances = 0;
  let earliest = null;
  let latest = null;

  for (const e of buffer) {
    if (!withinRange(e.timestamp, fromMs, toMs)) continue;
    totalUtterances++;
    if (earliest == null || e.timestamp < earliest) earliest = e.timestamp;
    if (latest == null || e.timestamp > latest) latest = e.timestamp;

    if (!perUser.has(e.userId)) {
      perUser.set(e.userId, {
        userId: e.userId,
        username: e.username || "",
        totalUtterances: 0,
        flaggedCount: 0,
        words: {},
        lastFlaggedAt: null,
      });
    }
    const rec = perUser.get(e.userId);
    rec.totalUtterances++;
    if (e.username && !rec.username) rec.username = e.username;

    if (e.flagged) {
      totalFlagged++;
      rec.flaggedCount++;
      if (e.flaggedWord) {
        rec.words[e.flaggedWord] = (rec.words[e.flaggedWord] || 0) + 1;
      }
      if (rec.lastFlaggedAt == null || e.timestamp > rec.lastFlaggedAt) {
        rec.lastFlaggedAt = e.timestamp;
      }
    }
  }

  const users = [...perUser.values()].sort((a, b) => {
    if (b.flaggedCount !== a.flaggedCount) return b.flaggedCount - a.flaggedCount;
    return b.totalUtterances - a.totalUtterances;
  });

  return {
    users,
    totals: {
      utterances: totalUtterances,
      flagged: totalFlagged,
      uniqueSpeakers: perUser.size,
      earliest,
      latest,
    },
  };
}

export function getStats() {
  if (buffer.length === 0) {
    return {
      totalEntries: 0,
      flagged: 0,
      oldest: null,
      newest: null,
      retentionDays: 7,
    };
  }
  let flagged = 0;
  for (const e of buffer) if (e.flagged) flagged++;
  return {
    totalEntries: buffer.length,
    flagged,
    oldest: buffer[0].timestamp,
    newest: buffer[buffer.length - 1].timestamp,
    retentionDays: 7,
  };
}

export function pruneNow() {
  const before = buffer.length;
  buffer = pruneOld(buffer);
  if (buffer.length !== before) {
    console.log(
      `[transcripts] pruned ${before - buffer.length} old entries (kept ${buffer.length})`,
    );
    saveLocal();
    scheduleRemoteSave();
  }
}

export async function flushNow() {
  if (remoteTimer) {
    clearTimeout(remoteTimer);
    remoteTimer = null;
  }
  if (!remoteCallback || !dirtySinceRemote) return;
  dirtySinceRemote = false;
  lastRemoteCommitAt = Date.now();
  try {
    await remoteCallback({ version: 1, entries: buffer });
  } catch (err) {
    console.error("[transcripts] flush failed", err?.message);
  }
}
