import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "index.js"), "utf8");

test("startup and reconnect contain no blanket server-unmute path", () => {
  assert.doesNotMatch(source, /clearStaleInactivityMutes/);
  assert.doesNotMatch(source, /clearing stale mutes from previous session/);
  assert.doesNotMatch(source, /restart-unmute/);
});

test("voice agent passes the authenticated Discord member to tool authorization", () => {
  assert.match(source, /authorMember:\s*member/);
  assert.match(source, /if \(canManageBot\(member\)\)/);
  assert.match(source, /non-admin voice user/);
});

test("the STT callback awaits the wake handler before releasing its FIFO slot", () => {
  assert.match(source, /await handleWakeCommand\(\{/);
});

test("timed auto-unmute requires the timer's lease id", () => {
  assert.match(source, /t\.payload\?\.leaseId/);
  assert.match(source, /unmuteOwnedLease/);
});

test("new guild chat moderation remains opt-in", () => {
  assert.match(source, /if \(cfg\.aiModerationEnabled === true\) \{/);
});
