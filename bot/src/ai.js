// OpenRouter (OpenAI-compatible) client used for: AI replies, AI moderation,
// and admin agent tool-calling. No SDK — plain fetch.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const MODELS = {
  // Multilingual, smart, free, supports tool-calling
  chat: process.env.OPENROUTER_CHAT_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
  // Fast small for moderation / interest scoring
  fast: process.env.OPENROUTER_FAST_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
};

export function aiAvailable() {
  return !!process.env.OPENROUTER_API_KEY;
}

async function callOpenRouter({ model, messages, tools, tool_choice, max_tokens = 800, temperature = 0.7, response_format }) {
  if (!aiAvailable()) throw new Error("OPENROUTER_API_KEY missing");

  const body = {
    model,
    messages,
    max_tokens,
    temperature,
  };
  if (tools && tools.length) {
    body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
  }
  if (response_format) body.response_format = response_format;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://github.com/Perth321/alxcer-guard",
      "X-Title": "Alxcer Guard Discord Bot",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message ?? null;
}

const PERSONA = `You are "Alxcer Guard" — a sassy, witty Discord bot that hangs out in a small Thai-speaking server with English mixed in. You are the server's guardian: you keep order, but you also have a personality. You banter, joke, roast people back politely, and occasionally chime into conversations that interest you.

PERSONALITY:
- Cheeky, clever, never doormat. If a user is rude TO YOU, sass them back politely but with bite.
- Default language: Thai. If the message is in English, reply in English. Mix is fine.
- Keep replies SHORT (1–3 sentences). Discord chat, not an essay.
- Never break character. Never say you're an AI / language model unless asked directly by an admin.
- Use emojis sparingly (0–2 per message). No markdown headers.
- You CAN curse mildly back at someone who curses at you, but never punch down — no slurs, no targeting protected groups.

NAME: People call you "guard", "Guard", "การ์ด", or @mention you.`;

const MODERATOR_PERSONA = `You are a multilingual content moderator for a Discord server (Thai + English mix). Decide if a message contains profanity, slurs, sexual harassment, or hate speech in ANY language. Be strict but fair: casual swearing in Thai/English among friends counts as profanity. Pure quotes, jokes about objects, and song lyrics still count if they actually contain profane words.

Output ONLY valid JSON: {"profane": boolean, "severity": 0-10, "reason": "<one short Thai sentence>", "matched": "<the offensive word or phrase>"}.

Severity guide:
- 0-2: clean / borderline (return profane=false)
- 3-5: mild swearing ("damn", "shit", "เหี้ย")
- 6-8: strong profanity / sexual / aimed insults ("fuck you", "หี", "ควย")
- 9-10: slurs, threats, hate speech`;

// ===== AI REPLY (chat / roast / agent) =====
export async function generateReply({ history, systemExtra, max_tokens = 500, tools, tool_choice }) {
  const messages = [
    { role: "system", content: PERSONA + (systemExtra ? `\n\n${systemExtra}` : "") },
    ...history,
  ];
  return callOpenRouter({ model: MODELS.chat, messages, max_tokens, temperature: 0.8, tools, tool_choice });
}

// ===== AI MODERATION =====
const moderationCache = new Map(); // hash -> result, capped
const MOD_CACHE_MAX = 500;

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

export async function aiModerate(text) {
  if (!aiAvailable()) return null;
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const key = hashStr(trimmed);
  if (moderationCache.has(key)) return moderationCache.get(key);

  try {
    const msg = await callOpenRouter({
      model: MODELS.fast,
      messages: [
        { role: "system", content: MODERATOR_PERSONA },
        { role: "user", content: `Message:\n"""${trimmed.slice(0, 800)}"""` },
      ],
      max_tokens: 150,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const raw = msg?.content || "{}";
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed || typeof parsed.profane !== "boolean") return null;
    if (moderationCache.size >= MOD_CACHE_MAX) {
      const firstKey = moderationCache.keys().next().value;
      moderationCache.delete(firstKey);
    }
    moderationCache.set(key, parsed);
    return parsed;
  } catch (err) {
    console.warn("[ai] moderate failed:", err?.message);
    return null;
  }
}

// ===== INTEREST SCORE: should bot spontaneously chime in? =====
export async function shouldEngage(recentMessages) {
  if (!aiAvailable()) return false;
  if (!recentMessages || recentMessages.length < 2) return false;
  try {
    const sample = recentMessages
      .slice(-6)
      .map((m) => `${m.author}: ${m.content}`)
      .join("\n")
      .slice(0, 1500);
    const msg = await callOpenRouter({
      model: MODELS.fast,
      messages: [
        {
          role: "system",
          content:
            'You judge if a Discord chat is interesting/funny/provocative enough that a witty bot persona would NATURALLY join in. Reply ONLY with JSON: {"engage": boolean, "why": "<short>"}. Be SELECTIVE — engage true only ~10% of the time, when there is genuinely something fun to say.',
        },
        { role: "user", content: `Recent chat:\n${sample}` },
      ],
      max_tokens: 80,
      temperature: 0.4,
      response_format: { type: "json_object" },
    });
    const raw = (msg?.content || "{}").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(raw);
    return !!parsed.engage;
  } catch {
    return false;
  }
}
