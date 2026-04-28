const MAX_ENTRIES = 300;
const buffer = [];

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
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

export function getRecent({ userId = null, limit = 20, flaggedOnly = false } = {}) {
  let result = buffer;
  if (flaggedOnly) result = result.filter((e) => e.flagged);
  if (userId) result = result.filter((e) => e.userId === userId);
  if (result.length <= limit) return result.slice();
  return result.slice(-limit);
}

export function getStats() {
  if (buffer.length === 0) {
    return { totalEntries: 0, flagged: 0, oldest: null, newest: null };
  }
  let flagged = 0;
  for (const e of buffer) if (e.flagged) flagged++;
  return {
    totalEntries: buffer.length,
    flagged,
    oldest: buffer[0].timestamp,
    newest: buffer[buffer.length - 1].timestamp,
  };
}

export function clearAll() {
  buffer.length = 0;
}
