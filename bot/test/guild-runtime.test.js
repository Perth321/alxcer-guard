import test from "node:test";
import assert from "node:assert/strict";
import {
  GuildRuntimeRegistry,
  disposeUserSubscription,
  resetGuildReceiver,
} from "../src/guild-runtime.js";

test("guild runtimes keep voice state isolated", () => {
  const registry = new GuildRuntimeRegistry();
  const a = registry.get("guild-a");
  const b = registry.get("guild-b");
  a.currentChannelId = "voice-a";
  a.userState.set("same-user", { heardOnce: true });
  a.pendingWake.set("same-user", { at: 1 });

  assert.equal(b.currentChannelId, null);
  assert.equal(b.userState.has("same-user"), false);
  assert.equal(b.pendingWake.has("same-user"), false);
  assert.notEqual(a, b);
});

test("receiver reset tears down streams and advances generation", () => {
  const runtime = new GuildRuntimeRegistry().get("guild-a");
  let streamDestroyed = 0;
  let decoderDestroyed = 0;
  runtime.subscriptions.set("u1", {
    stream: { unpipe() {}, destroy() { streamDestroyed += 1; } },
    decoder: { unpipe() {}, destroy() { decoderDestroyed += 1; } },
  });
  runtime.audioBuffers.set("u1", { chunks: [Buffer.alloc(2)], totalBytes: 2 });
  const generation = runtime.connectionGeneration;

  resetGuildReceiver(runtime);

  assert.equal(streamDestroyed, 1);
  assert.equal(decoderDestroyed, 1);
  assert.equal(runtime.subscriptions.size, 0);
  assert.equal(runtime.audioBuffers.size, 0);
  assert.equal(runtime.connectionGeneration, generation + 1);
});

test("disposing one subscription does not affect another guild", () => {
  const registry = new GuildRuntimeRegistry();
  const a = registry.get("guild-a");
  const b = registry.get("guild-b");
  a.subscriptions.set("u", { stream: { destroy() {} }, decoder: null });
  b.subscriptions.set("u", { stream: { destroy() {} }, decoder: null });

  disposeUserSubscription(a, "u");

  assert.equal(a.subscriptions.has("u"), false);
  assert.equal(b.subscriptions.has("u"), true);
});

test("cleanup from an old stream cannot delete its replacement", () => {
  const runtime = new GuildRuntimeRegistry().get("guild-a");
  const oldRecord = { stream: { destroy() {} }, decoder: null };
  const replacement = { stream: { destroy() {} }, decoder: null };
  runtime.subscriptions.set("u", replacement);

  assert.equal(disposeUserSubscription(runtime, "u", oldRecord), false);
  assert.equal(runtime.subscriptions.get("u"), replacement);
  assert.equal(disposeUserSubscription(runtime, "u", replacement), true);
  assert.equal(runtime.subscriptions.has("u"), false);
});
