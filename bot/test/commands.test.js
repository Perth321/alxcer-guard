import test from "node:test";
import assert from "node:assert/strict";

import { Routes } from "discord.js";
import {
  handleDebugCommand,
  handlePrankSound,
  handleSettingCommand,
  handleSettingComponent,
  registerCommands,
} from "../src/commands.js";
import { normalizeGuildConfig } from "../src/config.js";

function allowManageGuild() {
  return { has: () => true };
}

test("registerCommands publishes global application commands", async () => {
  const puts = [];
  const rest = {
    async put(route, options) {
      puts.push({ route, options });
    },
  };
  const client = {
    token: "token",
    application: { id: "app-1" },
    user: { id: "fallback-app" },
    config: { guildId: "legacy-single-guild" },
  };

  await registerCommands(client, { rest });

  assert.equal(puts.length, 2);
  assert.equal(puts[0].route, Routes.applicationCommands("app-1"));
  assert.ok(Array.isArray(puts[0].options.body));
  assert.ok(puts[0].options.body.length > 0);
  assert.equal(
    puts[1].route,
    Routes.applicationGuildCommands("app-1", "legacy-single-guild"),
  );
  assert.deepEqual(puts[1].options.body, []);
});

test("debug command reads the interaction guild runtime", async () => {
  const calls = [];
  const runtime = {
    snapshot(guildId) {
      calls.push(["snapshot", guildId]);
      return {
        connected: false,
        connStatus: "idle",
        channelId: null,
        cryptoLib: "test",
        lastAnyAudioAge: 0,
        transcription: true,
        allVoiceChannels: [],
        users: [],
      };
    },
    getConfig(guildId) {
      calls.push(["getConfig", guildId]);
      return normalizeGuildConfig({});
    },
  };
  let reply = null;
  const interaction = {
    guildId: "guild-b",
    member: { voice: { channelId: null } },
    async reply(value) {
      reply = value;
    },
  };

  await handleDebugCommand(interaction, runtime);

  assert.deepEqual(calls, [
    ["snapshot", "guild-b"],
    ["getConfig", "guild-b"],
  ]);
  assert.equal(reply.ephemeral, true);
});

test("prank command targets only the interaction guild", async () => {
  const calls = [];
  const runtime = {
    async playPrankSound(guildId, soundName) {
      calls.push([guildId, soundName]);
      return { ok: true, channelId: "voice-b" };
    },
  };
  const edits = [];
  const interaction = {
    guildId: "guild-b",
    member: null,
    memberPermissions: allowManageGuild(),
    async deferReply() {},
    async editReply(value) {
      edits.push(value);
    },
  };

  await handlePrankSound(interaction, runtime, "fart");

  assert.deepEqual(calls, [["guild-b", "fart"]]);
  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /voice-b/);
});

test("setting command renders config for the interaction guild", async () => {
  const calls = [];
  const runtime = {
    getConfig(guildId) {
      calls.push(guildId);
      return normalizeGuildConfig({ notifyChannelId: guildId + "-notify" });
    },
  };
  let reply = null;
  const interaction = {
    guildId: "guild-b",
    async reply(value) {
      reply = value;
    },
  };

  await handleSettingCommand(interaction, runtime);

  assert.deepEqual(calls, ["guild-b"]);
  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embeds.length > 0);
});

test("setting component persists, updates, and rejoins only its guild", async () => {
  const calls = [];
  const runtime = {
    getConfig(guildId) {
      calls.push(["getConfig", guildId]);
      return normalizeGuildConfig({ voiceChannelId: "voice-b" });
    },
    async persistConfig(guildId, config) {
      calls.push(["persistConfig", guildId, config.voiceChannelId]);
    },
    setConfig(guildId, config) {
      calls.push(["setConfig", guildId, config.voiceChannelId]);
    },
    requestRejoin(guildId) {
      calls.push(["requestRejoin", guildId]);
    },
  };
  let update = null;
  const interaction = {
    customId: "setting:auto-voice",
    guildId: "guild-b",
    member: null,
    memberPermissions: allowManageGuild(),
    isButton: () => true,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => false,
    async update(value) {
      update = value;
    },
  };

  const handled = await handleSettingComponent(interaction, runtime);

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    ["getConfig", "guild-b"],
    ["persistConfig", "guild-b", ""],
    ["setConfig", "guild-b", ""],
    ["requestRejoin", "guild-b"],
  ]);
  assert.ok(update.embeds.length > 0);
});
