// Classroom mode: when a member with the configured "teacher" role joins
// a voice channel, start a 1-hour (configurable) class timer for that
// channel. When the timer fires, the bot joins the channel, plays the
// bell, speaks the end-of-class announcement, plays the bell again, and
// leaves. If the teacher leaves the channel before the timer expires,
// the class is cancelled.
//
// State is in-memory only; the bot runs in 6h GitHub Actions containers
// so anything in flight when the runner stops simply ends with it.

// channelId -> { guildId, channelId, teacherId, startedAt, endsAt, fired }
const activeClasses = new Map();

export function startClass({ guildId, channelId, teacherId, durationMinutes }) {
  const ms = Math.max(1, Math.min(600, Number(durationMinutes) || 60)) * 60_000;
  const now = Date.now();
  const cls = {
    guildId,
    channelId,
    teacherId,
    startedAt: now,
    endsAt: now + ms,
    fired: false,
  };
  activeClasses.set(channelId, cls);
  return cls;
}

export function stopClass(channelId) {
  return activeClasses.delete(channelId);
}

export function getClassByChannel(channelId) {
  return activeClasses.get(channelId) ?? null;
}

export function getClassByTeacher(guildId, teacherId) {
  for (const c of activeClasses.values()) {
    if (c.guildId === guildId && c.teacherId === teacherId) return c;
  }
  return null;
}

export function listActive(guildId) {
  return [...activeClasses.values()].filter((c) => c.guildId === guildId);
}

// Returns the classes whose timer has expired but haven't yet fired the
// end-of-class sequence. Caller should mark them fired (markFired) once
// the announcement is dispatched so we don't double-fire.
export function takeExpired() {
  const now = Date.now();
  const out = [];
  for (const c of activeClasses.values()) {
    if (!c.fired && now >= c.endsAt) {
      c.fired = true;
      out.push(c);
    }
  }
  return out;
}

export function removeClass(channelId) {
  activeClasses.delete(channelId);
}
