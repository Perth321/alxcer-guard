import test from "node:test";
import assert from "node:assert/strict";
import { shouldMuteForInactivity } from "../src/inactivity-policy.js";

const now = 1_000_000;
const readyState = {
  muted: false,
  speaking: false,
  heardOnce: true,
  lastPacketAt: now - 601_000,
  silentTicks: 3,
};
const openVoice = { serverMute: false, selfMute: false, selfDeaf: false };

test("automatic inactivity mute is disabled unless explicitly enabled", () => {
  assert.equal(shouldMuteForInactivity({
    enabled: false,
    state: readyState,
    voice: openVoice,
    now,
    muteSeconds: 600,
  }), false);
});

test("a speaking flag without a decoded packet is never mute evidence", () => {
  assert.equal(shouldMuteForInactivity({
    enabled: true,
    state: { ...readyState, heardOnce: false, lastPacketAt: 0 },
    voice: openVoice,
    now,
    muteSeconds: 600,
  }), false);
});

test("requires repeated checks and never overrides an existing server mute", () => {
  assert.equal(shouldMuteForInactivity({
    enabled: true,
    state: { ...readyState, silentTicks: 2 },
    voice: openVoice,
    now,
    muteSeconds: 600,
  }), false);
  assert.equal(shouldMuteForInactivity({
    enabled: true,
    state: readyState,
    voice: { ...openVoice, serverMute: true },
    now,
    muteSeconds: 600,
  }), false);
});

test("mutes only a proven, open, repeatedly silent user", () => {
  assert.equal(shouldMuteForInactivity({
    enabled: true,
    state: readyState,
    voice: openVoice,
    now,
    muteSeconds: 600,
  }), true);
});
