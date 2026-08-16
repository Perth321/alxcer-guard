import test from "node:test";
import assert from "node:assert/strict";

import {
  MUTATING_TOOLS,
  OWNER_ONLY_TOOLS,
  canExecuteAgentTool,
  hasRequiredVoiceConfirmation,
  isMutatingTool,
} from "../src/agent-auth.js";
import { TOOLS } from "../src/agent.js";

test("core server-management executors are exposed to the model as tools", () => {
  const names = new Set(TOOLS.map((tool) => tool?.function?.name));
  for (const name of [
    "list_channels",
    "create_channel",
    "edit_channel",
    "delete_channel",
    "create_category",
    "lock_channel",
    "set_slowmode",
    "set_channel_topic",
  ]) {
    assert.equal(names.has(name), true, `${name} must have an OpenAI-compatible tool schema`);
  }

  const createChannel = TOOLS.find((tool) => tool?.function?.name === "create_channel");
  assert.deepEqual(createChannel.function.parameters.required, ["name", "type"]);
  assert.deepEqual(createChannel.function.parameters.properties.type.enum, ["text", "voice"]);
});

test("read-only tools remain available without server-management permission", () => {
  assert.equal(isMutatingTool("web_search"), false);
  assert.equal(canExecuteAgentTool("web_search"), true);
});

test("spoken tools do not require a magic confirmation word", () => {
  assert.equal(hasRequiredVoiceConfirmation("web_search", { voiceCommand: true }), true);
  assert.equal(hasRequiredVoiceConfirmation("voice_mute", { voiceCommand: false }), true);
  assert.equal(hasRequiredVoiceConfirmation("voice_mute", {
    voiceCommand: true,
    voiceConfirmed: false,
  }), true);
  assert.equal(hasRequiredVoiceConfirmation("voice_mute", {
    voiceCommand: true,
    voiceConfirmed: true,
  }), true);
});

test("state-changing tools require owner or Manage Guild authority", () => {
  for (const name of [
    "voice_mute",
    "ban_user",
    "create_channel",
    "delete_channel",
    "trivia",
  ]) {
    assert.equal(MUTATING_TOOLS.has(name), true);
    assert.equal(canExecuteAgentTool(name), false);
    assert.equal(canExecuteAgentTool(name, { isOwner: true }), true);
    assert.equal(canExecuteAgentTool(name, { canManageGuild: true }), true);
  }
});

test("host, repository, and log tools are bot-owner only", () => {
  for (const name of [
    "shell_exec",
    "read_local_file",
    "list_local_files",
    "read_own_log",
    "read_own_source",
    "write_own_source",
    "computer_browse",
    "deploy_webpage",
    "fetch_url",
    "screenshot_url",
    "inspect_webpage",
    "check_website",
  ]) {
    assert.equal(OWNER_ONLY_TOOLS.has(name), true);
    assert.equal(canExecuteAgentTool(name), false);
    assert.equal(canExecuteAgentTool(name, { canManageGuild: true }), false);
    assert.equal(canExecuteAgentTool(name, { isOwner: true }), true);
  }
});
