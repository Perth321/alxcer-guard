export function shouldMuteForInactivity({
  enabled,
  state,
  voice,
  now = Date.now(),
  muteSeconds,
  minSilentTicks = 3,
}) {
  if (enabled !== true || !state || !voice) return false;
  if (state.muted || state.speaking || !state.heardOnce || !state.lastPacketAt) return false;
  if (voice.serverMute || voice.selfMute || voice.selfDeaf) return false;
  if ((state.silentTicks || 0) < minSilentTicks) return false;
  return (now - state.lastPacketAt) / 1000 >= Number(muteSeconds || 0);
}
