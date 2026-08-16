import test from "node:test";
import assert from "node:assert/strict";

import { authorizeAgentTool, setOwnerId } from "../src/agent.js";

test("Manage Server cannot cross the owner-only host boundary", async () => {
  setOwnerId("owner-1");
  const moderator = {
    id: "moderator-1",
    permissions: { has: () => true },
  };
  const ctx = {
    authorId: moderator.id,
    authorMember: moderator,
    ownerId: "owner-1",
  };

  assert.equal(await authorizeAgentTool("voice_mute", ctx), true);
  assert.equal(await authorizeAgentTool("shell_exec", ctx), false);
  assert.equal(await authorizeAgentTool("read_own_log", ctx), false);
  assert.equal(await authorizeAgentTool("web_search", ctx), true);
  assert.equal(await authorizeAgentTool("shell_exec", {
    ...ctx,
    authorId: "owner-1",
    authorMember: { id: "owner-1", permissions: { has: () => false } },
  }), true);
  setOwnerId("");
});

test("guild owner may mutate their guild but cannot use bot-host tools", async () => {
  setOwnerId("application-owner");
  const guildOwner = {
    id: "guild-owner",
    permissions: { has: () => false },
  };
  const ctx = {
    guild: { ownerId: guildOwner.id },
    authorId: guildOwner.id,
    authorMember: guildOwner,
    ownerId: "application-owner",
  };

  assert.equal(await authorizeAgentTool("voice_mute_many", ctx), true);
  assert.equal(await authorizeAgentTool("create_channel", ctx), true);
  assert.equal(await authorizeAgentTool("web_search", ctx), true);
  assert.equal(await authorizeAgentTool("shell_exec", ctx), false);
  assert.equal(await authorizeAgentTool("read_own_log", ctx), false);
  setOwnerId("");
});

test("regular members keep read-only tools without gaining mutation access", async () => {
  setOwnerId("application-owner");
  const member = {
    id: "member-1",
    permissions: { has: () => false },
  };
  const ctx = {
    guild: { ownerId: "guild-owner" },
    authorId: member.id,
    authorMember: member,
    ownerId: "application-owner",
  };

  assert.equal(await authorizeAgentTool("web_search", ctx), true);
  assert.equal(await authorizeAgentTool("list_channels", ctx), true);
  assert.equal(await authorizeAgentTool("voice_mute_many", ctx), false);
  assert.equal(await authorizeAgentTool("create_channel", ctx), false);
  assert.equal(await authorizeAgentTool("shell_exec", ctx), false);
  setOwnerId("");
});
