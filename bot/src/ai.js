// OpenRouter (OpenAI-compatible) client used for: AI replies, AI moderation,
// and admin agent tool-calling. No SDK — plain fetch.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Fallback chain. Primary first; we walk down on 429/5xx errors.
// All chosen models support tool-calling and good Thai + English.
// Smaller / faster models first — voice-command UX is dominated by LLM
// latency, and a 20B model with tool support responds in 1-3s vs 5-15s for
// the 80B / 120B tier. The bigger ones stay as fallbacks for quality.
const CHAT_FALLBACKS = (process.env.OPENROUTER_CHAT_MODELS ||
  "openai/gpt-oss-20b:free,z-ai/glm-4.5-air:free,qwen/qwen3-next-80b-a3b-instruct:free,openai/gpt-oss-120b:free,meta-llama/llama-3.3-70b-instruct:free"
).split(",").map((s) => s.trim()).filter(Boolean);

const FAST_FALLBACKS = (process.env.OPENROUTER_FAST_MODELS ||
  "openai/gpt-oss-20b:free,z-ai/glm-4.5-air:free,qwen/qwen3-next-80b-a3b-instruct:free,meta-llama/llama-3.3-70b-instruct:free"
).split(",").map((s) => s.trim()).filter(Boolean);

// Vision-capable free models. We try Llama-4 multimodal first (best image
// reasoning quality on the free tier), then Gemini, then Qwen-VL as a last
// resort. Override via env if a model gets deprecated.
const VISION_FALLBACKS = (process.env.OPENROUTER_VISION_MODELS ||
  "meta-llama/llama-4-maverick:free,meta-llama/llama-4-scout:free,google/gemini-2.0-flash-exp:free,qwen/qwen2.5-vl-72b-instruct:free,mistralai/mistral-small-3.2-24b-instruct:free"
).split(",").map((s) => s.trim()).filter(Boolean);

export const MODELS = {
  chat: CHAT_FALLBACKS[0],
  fast: FAST_FALLBACKS[0],
  vision: VISION_FALLBACKS[0],
};

const REQUEST_TIMEOUT_MS = 25_000;

export function aiAvailable() {
  return !!process.env.OPENROUTER_API_KEY;
}

async function callOnce({ model, messages, tools, tool_choice, max_tokens, temperature, response_format }) {
  const body = { model, messages, max_tokens, temperature };
  if (tools && tools.length) {
    body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
  }
  if (response_format) body.response_format = response_format;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/Perth321/alxcer-guard",
        "X-Title": "Alxcer Guard Discord Bot",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();
  if (!res.ok) {
    const retriable = res.status === 429 || res.status === 408 || res.status === 503 || res.status >= 500;
    const err = new Error(`OpenRouter ${res.status} (${model}): ${text.slice(0, 250)}`);
    err.retriable = retriable;
    err.status = res.status;
    throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`OpenRouter non-JSON (${model})`); }
  if (json.error) {
    const e = new Error(`OpenRouter error (${model}): ${json.error.message || JSON.stringify(json.error)}`);
    e.retriable = true;
    throw e;
  }
  return json.choices?.[0]?.message ?? null;
}

async function callOpenRouter({ model, models, messages, tools, tool_choice, max_tokens = 800, temperature = 0.7, response_format }) {
  if (!aiAvailable()) throw new Error("OPENROUTER_API_KEY missing");
  const chain = (models && models.length ? models : [model]).filter(Boolean);
  let lastErr;
  for (const m of chain) {
    try {
      const result = await callOnce({ model: m, messages, tools, tool_choice, max_tokens, temperature, response_format });
      if (m !== chain[0]) console.log(`[ai] fell back to model: ${m}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[ai] ${m} failed: ${err.message?.slice(0, 200)}`);
      if (!err.retriable) {
        // Non-retriable on this model — try next anyway since it might be a model-specific issue.
      }
      // brief jittered pause before next attempt to avoid hammering
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    }
  }
  throw lastErr ?? new Error("OpenRouter: all models failed");
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
  return callOpenRouter({ models: CHAT_FALLBACKS, messages, max_tokens, temperature: 0.8, tools, tool_choice });
}

// ===== VISION REPLY (image / video frames) =====
// imageUrls: an array of publicly fetchable image URLs (Discord CDN works).
// userText: the chat content from the user (their question/comment).
// detectionContext: optional Thai summary of YOLO detections to ground the reply.
export async function generateVisionReply({
  imageUrls,
  userText,
  detectionContext,
  systemExtra,
  history = [],
  max_tokens = 450,
}) {
  const persona = PERSONA + (systemExtra ? `\n\n${systemExtra}` : "");
  const visionGuide = `You are looking at ${imageUrls.length === 1 ? "an image" : `${imageUrls.length} images (frames from a video or several images)`} the user just sent. Describe what you see in 2-4 short Thai sentences with personality — keep your "guard" voice. Mention specific objects, people, mood, anything noteworthy. If the user asked something specific, answer that. Don't list every single object robotically — speak naturally.${detectionContext ? `\n\n[YOLO detector saw]: ${detectionContext}\nUse this as a hint but trust your own eyes too.` : ""}`;

  const userContent = [
    { type: "text", text: userText || "(ผู้ใช้แค่ส่งภาพมาให้ดู — ตอบสั้นๆ ว่าเห็นอะไร)" },
    ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const messages = [
    { role: "system", content: persona + "\n\n" + visionGuide },
    ...history,
    { role: "user", content: userContent },
  ];

  return callOpenRouter({
    models: VISION_FALLBACKS,
    messages,
    max_tokens,
    temperature: 0.7,
  });
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
      models: FAST_FALLBACKS,
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
  if (!recentMessages || recentMessages.length < 1) return false;
  try {
    const sample = recentMessages
      .slice(-6)
      .map((m) => `${m.author}: ${m.content}`)
      .join("\n")
      .slice(0, 1500);
    const msg = await callOpenRouter({
      models: FAST_FALLBACKS,
      messages: [
        {
          role: "system",
          content:
            'You decide if a witty Discord bot persona ("guard") should chime into a chat. Be GENEROUS — engage true ~40% of the time, especially when people are talking about something fun, opinionated, joking, gossiping, complaining, asking questions out loud, or making confident claims. Only refuse for: pure 2-word reactions, clear DMs between two people deep in private convo, or boring single-word responses. Reply ONLY with JSON: {"engage": boolean, "why": "<short>"}.',
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
  } catch (err) {
    console.warn("[ai] shouldEngage failed:", err?.message?.slice(0, 150));
    return false;
  }
}
