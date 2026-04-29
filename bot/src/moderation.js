// Chat moderation: per-user offense tracking + escalating timeouts.
// Voice-channel mute logic in index.js is UNTOUCHED — this is a parallel
// system for text channels (server timeouts via member.timeout()).

import { findProfanity } from "./profanity_words.js";
import { aiModerate, aiAvailable, generateReply } from "./ai.js";

// Decay window: if user is clean for 7 days, the chat-offense counter resets.
const DECAY_MS = 7 * 24 * 3600 * 1000;

// Escalation table — capped at 1 day as user requested.
const ESCALATION_SECONDS = [
  60,        // 1st: 1 min
  5 * 60,    // 2nd: 5 min
  30 * 60,   // 3rd: 30 min
  2 * 3600,  // 4th: 2 hr
  24 * 3600, // 5th+: 24 hr (cap)
];

export function getOffenseCount(offenses, userId) {
  const rec = offenses.users?.[userId];
  if (!rec || !rec.chat) return 0;
  // Apply decay
  if (rec.chat.lastAt && Date.now() - rec.chat.lastAt > DECAY_MS) return 0;
  return rec.chat.count || 0;
}

export function nextEscalationSeconds(currentCount) {
  const idx = Math.min(currentCount, ESCALATION_SECONDS.length - 1);
  return ESCALATION_SECONDS[idx];
}

export function recordOffense(offenses, userId, entry) {
  if (!offenses.users) offenses.users = {};
  if (!offenses.users[userId]) offenses.users[userId] = {};
  const rec = offenses.users[userId];
  if (!rec.chat || (rec.chat.lastAt && Date.now() - rec.chat.lastAt > DECAY_MS)) {
    rec.chat = { count: 0, lastAt: 0, history: [] };
  }
  rec.chat.count = (rec.chat.count || 0) + 1;
  rec.chat.lastAt = Date.now();
  rec.chat.history = rec.chat.history || [];
  rec.chat.history.push(entry);
  if (rec.chat.history.length > 25) {
    rec.chat.history = rec.chat.history.slice(-25);
  }
  return rec.chat.count;
}

// Detect: returns { profane, severity, reason, matched, source }
// Source: "local" (word list) or "ai" (LLM moderator). Local is instant + free.
export async function detectProfanity({ content, extraWords, useAI = true }) {
  const localHit = findProfanity(content, extraWords);
  if (localHit) {
    return {
      profane: true,
      severity: 7,
      reason: `ใช้คำต้องห้าม: "${localHit}"`,
      matched: localHit,
      source: "local",
    };
  }
  if (!useAI || !aiAvailable()) return { profane: false, source: "skip" };
  // Skip AI on short / link-only / mention-only messages to save quota
  const stripped = content.replace(/<@!?\d+>/g, "").replace(/https?:\/\/\S+/g, "").trim();
  if (stripped.length < 6) return { profane: false, source: "short" };
  const ai = await aiModerate(content);
  if (!ai) return { profane: false, source: "ai-error" };
  return { ...ai, source: "ai" };
}

// Generate sassy roast reply when deleting a profane msg.
export async function generateRoastReply({ username, matched, severity, language = "th" }) {
  if (!aiAvailable()) {
    return `<@${username}> ระวังคำพูดด้วยครับ — ใช้คำต้องห้าม โดน timeout ไปก่อน`;
  }
  try {
    const msg = await generateReply({
      history: [
        {
          role: "user",
          content: `A user just got their message DELETED for using the profane word "${matched}" (severity ${severity}/10). Write a SHORT (1–2 sentence) sassy-but-controlled scolding reply in Thai. Tell them to behave, mention they got timed out, optional sass. Mention their name as "@user" placeholder — I will replace with the actual mention. Do NOT include slurs yourself. Do NOT apologize. Be confident and a little sharp.`,
        },
      ],
      max_tokens: 120,
    });
    let text = (msg?.content || "").trim();
    if (!text) throw new Error("empty");
    // Replace placeholder with actual mention
    text = text.replace(/@user\b/gi, `<@${username}>`);
    if (!text.includes(`<@${username}>`)) text = `<@${username}> ${text}`;
    return text.slice(0, 1000);
  } catch (err) {
    console.warn("[mod] roast gen failed:", err?.message);
    return `<@${username}> ใช้คำหยาบโดน timeout ไปก่อน — เตือนแล้วนะ 😤`;
  }
}

export function formatHumanDuration(seconds) {
  if (seconds < 60) return `${seconds} วินาที`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} นาที`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ชั่วโมง`;
  return `${Math.round(seconds / 86400)} วัน`;
}
