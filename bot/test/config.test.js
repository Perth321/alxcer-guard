import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_VERSION,
  GUILD_DEFAULTS,
  getGuildConfig,
  hasGuildConfig,
  normalizeConfigStore,
  normalizeGuildConfig,
  setGuildConfig,
  toLegacyConfig,
  updateGuildConfig,
} from "../src/config.js";

test("legacy flat config migrates to a v2 guild store", () => {
  const store = normalizeConfigStore({
    guildId: "guild-a",
    ownerId: "owner-1",
    notifyChannelId: "notify-a",
    voiceChannelId: "voice-a",
    warningSeconds: 42,
    muteSeconds: 84,
    teacherRoleId: "teacher-a",
    bannedWords: [" Foo ", "foo", "BAR"],
  });

  assert.equal(store.version, CONFIG_VERSION);
  assert.equal(store.ownerId, "owner-1");
  assert.equal(store.primaryGuildId, "guild-a");
  assert.deepEqual(Object.keys(store.guilds), ["guild-a"]);
  assert.deepEqual(getGuildConfig(store, "guild-a"), {
    ...normalizeGuildConfig(GUILD_DEFAULTS),
    notifyChannelId: "notify-a",
    voiceChannelId: "voice-a",
    warningSeconds: 42,
    muteSeconds: 84,
    teacherRoleId: "teacher-a",
    bannedWords: ["Foo", "BAR"],
  });
});

test("updating one guild cannot overwrite another guild", () => {
  const original = normalizeConfigStore({
    version: CONFIG_VERSION,
    ownerId: "owner-1",
    primaryGuildId: "guild-a",
    guilds: {
      "guild-a": { notifyChannelId: "notify-a", warningSeconds: 30 },
      "guild-b": { notifyChannelId: "notify-b", warningSeconds: 90 },
    },
  });

  const updated = updateGuildConfig(original, "guild-a", {
    notifyChannelId: "notify-a-2",
  });

  assert.equal(getGuildConfig(updated, "guild-a").notifyChannelId, "notify-a-2");
  assert.equal(getGuildConfig(updated, "guild-b").notifyChannelId, "notify-b");
  assert.equal(getGuildConfig(updated, "guild-b").warningSeconds, 90);
  assert.equal(getGuildConfig(original, "guild-a").notifyChannelId, "notify-a");
});

test("setGuildConfig adds a guild immutably and unknown guilds receive defaults", () => {
  const original = normalizeConfigStore({});
  const updated = setGuildConfig(original, "guild-new", {
    voiceChannelId: "voice-new",
  });

  assert.equal(hasGuildConfig(original, "guild-new"), false);
  assert.equal(hasGuildConfig(updated, "guild-new"), true);
  assert.equal(updated.primaryGuildId, "guild-new");
  assert.equal(getGuildConfig(updated, "guild-new").voiceChannelId, "voice-new");
  assert.deepEqual(getGuildConfig(updated, "guild-unknown"), normalizeGuildConfig(GUILD_DEFAULTS));
});

test("toLegacyConfig returns the requested guild without losing owner identity", () => {
  const store = normalizeConfigStore({
    version: CONFIG_VERSION,
    ownerId: "owner-1",
    primaryGuildId: "guild-a",
    guilds: {
      "guild-a": { notifyChannelId: "notify-a" },
      "guild-b": { notifyChannelId: "notify-b" },
    },
  });

  const flat = toLegacyConfig(store, "guild-b");
  assert.equal(flat.guildId, "guild-b");
  assert.equal(flat.ownerId, "owner-1");
  assert.equal(flat.notifyChannelId, "notify-b");
});

test("guild normalization clamps values and deduplicates case-insensitively", () => {
  const config = normalizeGuildConfig({
    warningSeconds: -100,
    muteSeconds: 99999,
    bannedWords: [" Alpha ", "alpha", "BETA", ""],
    silentJoinChannelIds: ["voice-1", "voice-1", "voice-2", ""],
    teacherRoleId: 123,
  });

  assert.equal(config.warningSeconds, 5);
  assert.equal(config.muteSeconds, 3600);
  assert.deepEqual(config.bannedWords, ["Alpha", "BETA"]);
  assert.deepEqual(config.silentJoinChannelIds, ["voice-1", "voice-2"]);
  assert.equal(config.teacherRoleId, "123");
});

test("disruptive guild features default off and require explicit true", () => {
  const defaults = normalizeGuildConfig({});
  assert.equal(defaults.inactivityMuteEnabled, false);
  assert.equal(defaults.voiceWordBanEnabled, false);
  assert.equal(defaults.chatVoiceMuteEnabled, false);
  assert.equal(defaults.aiModerationEnabled, false);
  assert.equal(defaults.spontaneousChatEnabled, false);

  const enabled = normalizeGuildConfig({
    inactivityMuteEnabled: true,
    voiceWordBanEnabled: true,
    chatVoiceMuteEnabled: true,
    aiModerationEnabled: true,
    spontaneousChatEnabled: true,
  });
  assert.equal(enabled.inactivityMuteEnabled, true);
  assert.equal(enabled.voiceWordBanEnabled, true);
  assert.equal(enabled.chatVoiceMuteEnabled, true);
  assert.equal(enabled.aiModerationEnabled, true);
  assert.equal(enabled.spontaneousChatEnabled, true);
});
