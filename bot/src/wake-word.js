// Keep the wake word deliberately narrow. Speech-to-text commonly returns
// การ์ด/การด/การ์ต/กาด/ก๊าด, but matching ordinary words such as "คาด" makes
// the bot beep and consume the next utterance without being called.
const WAKE_TOKEN_RE =
  /(?:การ์?[ดตก]์?|ก(?:๊|้)?าด์?|guard|gaurd|gard|alxcer\s+guard|hey\s+guard)(?=$|[\s,.;:!?\-])/i;
const WAKE_LEADING_NOISE_RE = /^[\s,.!?\-:'"`()\[\]{}♪♫\*<>]+/;
const WAKE_PROMPT_PREFIX_RE =
  /^(?:[\s,.;:!?\-]+|alxcer|อันนี้|อะนะ|อืม|เอ่อ|เออ|อ้า|โอ้|อะ|นี่|hey)\s*/i;

export function cleanForWake(text) {
  if (!text) return "";
  let cleaned = String(text).trim();
  for (let i = 0; i < 3; i += 1) {
    const before = cleaned;
    cleaned = cleaned
      .replace(/^\[[^\]]{1,60}\]\s*/, "")
      .replace(/^\([^)]{1,60}\)\s*/, "")
      .replace(/^♪+[^♪]{0,60}♪+\s*/, "")
      .replace(WAKE_LEADING_NOISE_RE, "");
    if (cleaned === before) break;
  }
  return cleaned.trim();
}

export function extractWakeCommand(text) {
  let cleaned = cleanForWake(text);
  if (!cleaned) return null;
  for (let i = 0; i < 2; i += 1) {
    const before = cleaned;
    cleaned = cleaned.replace(WAKE_PROMPT_PREFIX_RE, "");
    if (cleaned === before) break;
  }
  const match = cleaned.match(WAKE_TOKEN_RE);
  if (!match || match.index !== 0) return null;
  return cleaned
    .slice(match[0].length)
    .trim()
    .replace(WAKE_PROMPT_PREFIX_RE, "")
    .replace(/^[\s,.;:!?\-]+/, "")
    .trim();
}
