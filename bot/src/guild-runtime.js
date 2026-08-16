function closeHandle(handle) {
  if (!handle) return;
  try {
    handle.unpipe?.();
  } catch {}
  try {
    handle.destroy?.();
  } catch {}
}

export function createGuildRuntime(guildId, now = Date.now()) {
  return {
    guildId: String(guildId),
    currentChannelId: null,
    connectionEpoch: 0,
    connectionGeneration: 0,
    userState: new Map(),
    subscriptions: new Map(),
    audioBuffers: new Map(),
    pendingWake: new Map(),
    wakeBusy: false,
    auxiliaryVoiceDepth: 0,
    joining: false,
    reevalQueued: false,
    activeReceiver: null,
    lastAnyAudio: now,
    receiverProven: false,
    lastSpeakingFlag: 0,
    receiverHealthLogged: false,
    notReadySince: 0,
    botSpeakingUntil: 0,
    beepPlaying: false,
    playingFiles: new Set(),
  };
}

export function disposeUserSubscription(runtime, userId, expectedRecord = null) {
  const rec = runtime.subscriptions.get(userId);
  if (expectedRecord && rec !== expectedRecord) return false;
  if (rec) {
    closeHandle(rec.stream);
    closeHandle(rec.decoder);
  }
  runtime.subscriptions.delete(userId);
  const buffer = runtime.audioBuffers.get(userId);
  if (buffer) {
    buffer.chunks = [];
    buffer.totalBytes = 0;
  }
  runtime.audioBuffers.delete(userId);
  return true;
}

export function resetGuildReceiver(runtime) {
  for (const userId of [...runtime.subscriptions.keys()]) {
    disposeUserSubscription(runtime, userId);
  }
  runtime.audioBuffers.clear();
  runtime.pendingWake.clear();
  runtime.activeReceiver = null;
  runtime.receiverProven = false;
  runtime.connectionGeneration += 1;
}

export function disposeGuildRuntime(runtime) {
  runtime.connectionEpoch += 1;
  resetGuildReceiver(runtime);
  runtime.userState.clear();
  runtime.currentChannelId = null;
  runtime.joining = false;
  runtime.reevalQueued = false;
  runtime.wakeBusy = false;
  runtime.auxiliaryVoiceDepth = 0;
}

export class GuildRuntimeRegistry {
  #items = new Map();

  get(guildId) {
    if (!guildId) throw new Error("guildId is required");
    const key = String(guildId);
    let runtime = this.#items.get(key);
    if (!runtime) {
      runtime = createGuildRuntime(key);
      this.#items.set(key, runtime);
    }
    return runtime;
  }

  peek(guildId) {
    return guildId ? this.#items.get(String(guildId)) ?? null : null;
  }

  delete(guildId) {
    const key = String(guildId);
    const runtime = this.#items.get(key);
    if (!runtime) return false;
    disposeGuildRuntime(runtime);
    return this.#items.delete(key);
  }

  values() {
    return this.#items.values();
  }

  get size() {
    return this.#items.size;
  }
}
