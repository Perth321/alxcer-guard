import test from "node:test";
import assert from "node:assert/strict";

import {
  MUTATING_TOOLS,
  OWNER_ONLY_TOOLS,
  canExecuteAgentTool,
  hasRequiredVoiceConfirmation,
  isMutatingTool,
} from "../src/agent-auth.js";

test("read-only tools remain available without server-management permission", () => {
  assert.equal(isMutatingTool("web_search"), false);
  assert.equal(canExecuteAgentTool("web_search"), true);
});

test("spoken mutation tools require an explicit confirmation word", () => {
  assert.equal(hasRequiredVoiceConfirmation("web_search", { voiceCommand: true }), true);
  assert.equal(hasRequiredVoiceConfirmation("voice_mute", { voiceCommand: false }), true);
  assert.equal(hasRequiredVoiceConfirmation("voice_mute", {
    voiceCommand: true,
    voiceConfirmed: false,
  }), false);
  assert.equal(hasRequiredVoiceConfirmation("voice_mute", {
    voiceCommand: true,
    voiceConfirmed: true,
  }), true);
});

test("state-changing tools require owner or Manage Guild authority", () => {
  for (const name of [
    "voice_mute",
    "ban_user",
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
