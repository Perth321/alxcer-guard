import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "mute_leases.json");

// A mute lease records which bot action currently owns a server mute.  The
// opaque lease id is deliberately required when releasing it: an old timer
// must never be able to unmute a newer mute applied to the same member.
const leases = new Map();
const expectedUnmutes = new Map();
let persistenceEnabled = false;
let remotePersist = null;
let remotePersistHandle = null;
let lastRemoteSignature = "";

function requiredId(value, name) {
  const normalized = value == null ? "" : String(value).trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function leaseKey(guildId, userId) {
  return `${requiredId(guildId, "guildId")}:${requiredId(userId, "userId")}`;
}

function serializeMuteLeases() {
  return {
    version: 1,
    updatedAt: Date.now(),
    items: [...leases.values()].sort((a, b) => a.createdAt - b.createdAt),
  };
}

function leaseSignature() {
  return JSON.stringify(
    [...leases.values()].sort((a, b) =>
      `${a.guildId}:${a.userId}`.localeCompare(`${b.guildId}:${b.userId}`),
    ),
  );
}

function writeLocal() {
  if (!persistenceEnabled) return;
  fs.writeFileSync(DATA_FILE, JSON.stringify(serializeMuteLeases(), null, 2) + "\n");
}

function schedulePersist() {
  if (!persistenceEnabled) return;
  writeLocal();
  if (!remotePersist) return;
  if (remotePersistHandle) {
    clearTimeout(remotePersistHandle);
    remotePersistHandle = null;
  }
  if (leaseSignature() === lastRemoteSignature) return;
  remotePersistHandle = setTimeout(async () => {
    remotePersistHandle = null;
    try {
      const data = serializeMuteLeases();
      const signature = leaseSignature();
      await remotePersist(data);
      lastRemoteSignature = signature;
    } catch (err) {
      console.warn("[mute-leases] remote persist failed:", err?.message);
    }
  }, 1_500);
  remotePersistHandle.unref?.();
}

export function loadMuteLeases() {
  leases.clear();
  persistenceEnabled = true;
  if (!fs.existsSync(DATA_FILE)) {
    writeLocal();
    lastRemoteSignature = leaseSignature();
    return leases;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    for (const raw of Array.isArray(items) ? items : []) {
      if (!raw || typeof raw !== "object") continue;
      try {
        const restored = restoreMuteLease(raw, { persist: false });
        if (!restored) continue;
      } catch {}
    }
    lastRemoteSignature = leaseSignature();
    console.log(`[mute-leases] loaded ${leases.size} durable lease(s)`);
  } catch (err) {
    console.warn("[mute-leases] load failed:", err?.message);
  }
  return leases;
}

export function setMuteLeaseRemotePersist(fn) {
  remotePersist = typeof fn === "function" ? fn : null;
}

export async function flushMuteLeases() {
  if (!persistenceEnabled) return;
  if (remotePersistHandle) {
    clearTimeout(remotePersistHandle);
    remotePersistHandle = null;
  }
  writeLocal();
  const signature = leaseSignature();
  if (remotePersist && signature !== lastRemoteSignature) {
    await remotePersist(serializeMuteLeases());
    lastRemoteSignature = signature;
  }
}

export function listMuteLeases({ guildId } = {}) {
  const normalizedGuildId = guildId == null ? null : String(guildId);
  return [...leases.values()].filter(
    (lease) => normalizedGuildId == null || lease.guildId === normalizedGuildId,
  );
}

export function createMuteLease({
  guildId,
  userId,
  source,
  actorId = null,
  expiresAt = null,
}) {
  const normalizedGuildId = requiredId(guildId, "guildId");
  const normalizedUserId = requiredId(userId, "userId");
  const normalizedSource = requiredId(source, "source");
  const normalizedExpiresAt = expiresAt == null ? null : Number(expiresAt);
  if (
    normalizedExpiresAt != null &&
    (!Number.isFinite(normalizedExpiresAt) || normalizedExpiresAt <= 0)
  ) {
    throw new TypeError("expiresAt must be a positive timestamp or null");
  }

  const lease = Object.freeze({
    id: randomUUID(),
    guildId: normalizedGuildId,
    userId: normalizedUserId,
    source: normalizedSource,
    actorId: actorId == null || actorId === "" ? null : String(actorId),
    createdAt: Date.now(),
    expiresAt: normalizedExpiresAt,
  });
  leases.set(leaseKey(normalizedGuildId, normalizedUserId), lease);
  schedulePersist();
  return lease;
}

// Re-hydrate an existing durable lease (for example an auto-unmute timer or a
// persisted word-ban) without minting a different id.  A live, different
// lease always wins so startup recovery cannot overwrite newer runtime state.
export function restoreMuteLease({
  id,
  guildId,
  userId,
  source,
  actorId = null,
  createdAt = null,
  expiresAt = null,
}, { persist = true } = {}) {
  const normalizedId = requiredId(id, "id");
  const normalizedGuildId = requiredId(guildId, "guildId");
  const normalizedUserId = requiredId(userId, "userId");
  const normalizedSource = requiredId(source, "source");
  const normalizedCreatedAt = createdAt == null ? Date.now() : Number(createdAt);
  const normalizedExpiresAt = expiresAt == null ? null : Number(expiresAt);
  if (!Number.isFinite(normalizedCreatedAt) || normalizedCreatedAt <= 0) {
    throw new TypeError("createdAt must be a positive timestamp");
  }
  if (
    normalizedExpiresAt != null &&
    (!Number.isFinite(normalizedExpiresAt) || normalizedExpiresAt <= 0)
  ) {
    throw new TypeError("expiresAt must be a positive timestamp or null");
  }

  const key = leaseKey(normalizedGuildId, normalizedUserId);
  const current = leases.get(key);
  if (current && current.id !== normalizedId) return null;
  if (current) return current;

  const lease = Object.freeze({
    id: normalizedId,
    guildId: normalizedGuildId,
    userId: normalizedUserId,
    source: normalizedSource,
    actorId: actorId == null || actorId === "" ? null : String(actorId),
    createdAt: normalizedCreatedAt,
    expiresAt: normalizedExpiresAt,
  });
  leases.set(key, lease);
  if (persist) schedulePersist();
  return lease;
}

export function getMuteLease(guildId, userId) {
  return leases.get(leaseKey(guildId, userId)) ?? null;
}

export function releaseMuteLease(guildId, userId, leaseId) {
  const key = leaseKey(guildId, userId);
  const current = leases.get(key);
  if (!current || !leaseId || current.id !== String(leaseId)) return false;
  const released = leases.delete(key);
  if (released) schedulePersist();
  return released;
}

// Force-clear is reserved for observed external state changes (member leaves,
// a human moderator unmutes them, guild removal, etc.). Normal auto-unmute code
// should use releaseMuteLease with the expected opaque id instead.
export function clearMuteLease(guildId, userId) {
  const key = leaseKey(guildId, userId);
  expectedUnmutes.delete(key);
  const cleared = leases.delete(key);
  if (cleared) schedulePersist();
  return cleared;
}

// Discord emits VoiceStateUpdate for our own setMute(false).  Keep a short
// correlation marker so that event is not mistaken for an external moderator
// overriding the bot and does not clear a newer lease created while the REST
// request was in flight.
export function expectOwnedUnmute(guildId, userId, leaseId, ttlMs = 10_000) {
  const key = leaseKey(guildId, userId);
  const normalizedLeaseId = requiredId(leaseId, "leaseId");
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError("ttlMs must be positive");
  const marker = Object.freeze({
    leaseId: normalizedLeaseId,
    expiresAt: Date.now() + ttl,
  });
  expectedUnmutes.set(key, marker);
  return marker;
}

export function cancelExpectedUnmute(guildId, userId, leaseId) {
  const key = leaseKey(guildId, userId);
  const current = expectedUnmutes.get(key);
  if (!current || current.leaseId !== String(leaseId)) return false;
  return expectedUnmutes.delete(key);
}

export function consumeExpectedUnmute(guildId, userId) {
  const key = leaseKey(guildId, userId);
  const current = expectedUnmutes.get(key);
  if (!current) return null;
  expectedUnmutes.delete(key);
  if (current.expiresAt < Date.now()) return null;
  return current;
}
