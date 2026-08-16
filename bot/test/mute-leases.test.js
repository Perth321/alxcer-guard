import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeExpectedUnmute,
  clearMuteLease,
  createMuteLease,
  expectOwnedUnmute,
  getMuteLease,
  releaseMuteLease,
  restoreMuteLease,
} from "../src/mute-leases.js";

test("a newer mute lease replaces the old lease", () => {
  const guildId = "guild-replace";
  const userId = "user-replace";
  const first = createMuteLease({
    guildId,
    userId,
    source: "inactivity",
    actorId: "bot",
    expiresAt: Date.now() + 5_000,
  });
  const second = createMuteLease({
    guildId,
    userId,
    source: "agent:mute_user_for",
    actorId: "admin",
    expiresAt: Date.now() + 10_000,
  });

  assert.notEqual(first.id, second.id);
  assert.equal(getMuteLease(guildId, userId), second);
  assert.equal(releaseMuteLease(guildId, userId, first.id), false);
  assert.equal(getMuteLease(guildId, userId), second);
  assert.equal(releaseMuteLease(guildId, userId, second.id), true);
  assert.equal(getMuteLease(guildId, userId), null);
});

test("a lease can only be released with its current opaque id", () => {
  const guildId = "guild-owner";
  const userId = "user-owner";
  const lease = createMuteLease({
    guildId,
    userId,
    source: "agent:voice_mute",
    actorId: "admin",
  });

  assert.equal(releaseMuteLease(guildId, userId, "not-the-owner"), false);
  assert.equal(getMuteLease(guildId, userId), lease);
  assert.equal(releaseMuteLease(guildId, userId, lease.id), true);
});

test("leases are isolated by guild and can be force-cleared on external changes", () => {
  const a = createMuteLease({ guildId: "guild-a", userId: "same-user", source: "test" });
  const b = createMuteLease({ guildId: "guild-b", userId: "same-user", source: "test" });

  assert.equal(getMuteLease("guild-a", "same-user"), a);
  assert.equal(getMuteLease("guild-b", "same-user"), b);
  assert.equal(clearMuteLease("guild-a", "same-user"), true);
  assert.equal(getMuteLease("guild-a", "same-user"), null);
  assert.equal(getMuteLease("guild-b", "same-user"), b);
  clearMuteLease("guild-b", "same-user");
});

test("a durable lease restores with the same id and never overwrites newer ownership", () => {
  const restored = restoreMuteLease({
    id: "durable-a",
    guildId: "guild-durable",
    userId: "user-durable",
    source: "timer",
    createdAt: Date.now() - 100,
    expiresAt: Date.now() + 10_000,
  });
  assert.equal(restored.id, "durable-a");
  assert.equal(getMuteLease("guild-durable", "user-durable")?.id, "durable-a");

  const newer = createMuteLease({
    guildId: "guild-durable",
    userId: "user-durable",
    source: "newer",
  });
  assert.equal(restoreMuteLease({
    id: "durable-a",
    guildId: "guild-durable",
    userId: "user-durable",
    source: "timer",
  }), null);
  assert.equal(getMuteLease("guild-durable", "user-durable"), newer);
  clearMuteLease("guild-durable", "user-durable");
});

test("our own unmute transition is consumed without looking external", () => {
  expectOwnedUnmute("guild-event", "user-event", "lease-event");
  assert.equal(consumeExpectedUnmute("guild-event", "user-event")?.leaseId, "lease-event");
  assert.equal(consumeExpectedUnmute("guild-event", "user-event"), null);
});
