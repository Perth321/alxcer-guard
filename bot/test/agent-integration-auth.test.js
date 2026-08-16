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
