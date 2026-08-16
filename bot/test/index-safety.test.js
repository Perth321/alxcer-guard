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
  assert.doesNotMatch(source, /expired persisted mute/);
  assert.match(source, /cleared without changing Discord mute/);
});

test("quiet mode prevents unsolicited voice playback", () => {
  assert.match(source, /cfg\.joinSoundEnabled !== true/);
  assert.match(source, /cfg\.classroomAutomationEnabled === true/);
  assert.match(source, /t\.payload\?\.voiceAudio === true/);
  assert.doesNotMatch(source, /DONE_BEEP_PCM/);
});

test("persisted auto-unmute cannot open a microphone after restart", () => {
  assert.match(source, /t\.restored === true/);
  assert.match(source, /ไม่เปิดไมค์อัตโนมัติหลัง Guard รีสตาร์ต/);
});

test("word-ban restoration and join mute respect current feature flags", () => {
  assert.match(
    source,
    /cfg\.voiceWordBanEnabled !== true && cfg\.chatVoiceMuteEnabled !== true/,
  );
  assert.match(
    source,
    /cfg\.voiceWordBanEnabled === true \|\| cfg\.chatVoiceMuteEnabled === true/,
  );
  assert.match(source, /expired lease cleared without opening/);
});

test("word-ban mute creates ownership and contains no stray connection code", () => {
  const start = source.indexOf("async function applyWordBan");
  const end = source.indexOf("// ===== Timer embed helpers", start);
  const implementation = source.slice(start, end > start ? end : start + 8_000);
  assert.match(implementation, /createMuteLease\(\{/);
  assert.match(implementation, /scheduleWordBanUnmute\(/);
  assert.doesNotMatch(implementation, /connection\.joinConfig/);
  assert.doesNotMatch(implementation, /target\.id/);
});

test("voice agent stays useful while tool authorization receives the real member", () => {
  const start = source.indexOf("async function handleWakeCommand");
  const end = source.indexOf("function pickReplyChannel", start);
  const wakeHandler = source.slice(start, end);
  assert.match(source, /authorMember:\s*member/);
  assert.match(source, /Every member gets the useful agent/);
  assert.doesNotMatch(source, /voiceConfirmed:/);
  assert.match(wakeHandler, /await runAgent\(\{/);
  assert.doesNotMatch(wakeHandler, /if \(canManageBot\(member\)\)/);
  assert.doesNotMatch(wakeHandler, /await generateReply\(\{/);
});

test("every directly-triggered text user enters the agent", () => {
  const start = source.indexOf("async function handleAgentOrChatReply");
  const end = source.indexOf("async function maybeSpontaneousChime", start);
  const textHandler = source.slice(start, end);
  assert.match(textHandler, /const member = msg\.member \|\| await guild\.members\.fetch/);
  assert.match(textHandler, /await runAgent\(\{/);
  assert.doesNotMatch(textHandler, /if \(canUseAgent\)/);
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
