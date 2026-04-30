// Lightweight Thai TTS using Google Translate's undocumented endpoint.
// No API key required. Returns an MP3 buffer.
//
// Endpoint: https://translate.google.com/translate_tts?ie=UTF-8&tl=th&client=tw-ob&q=...
// The endpoint enforces ~200 char limit per request, so longer text is
// chunked and concatenated.

const ENDPOINT = "https://translate.google.com/translate_tts";

function chunk(text, max = 180) {
  const out = [];
  let buf = "";
  // Prefer breaking on punctuation / whitespace
  const tokens = text.split(/(\s+|[,!?\.\u3002\uFF01\uFF1F\uFF0C])/);
  for (const tk of tokens) {
    if ((buf + tk).length > max) {
      if (buf.trim()) out.push(buf.trim());
      buf = tk;
    } else {
      buf += tk;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [text.slice(0, max)];
}

async function fetchOne(text, lang) {
  const url =
    `${ENDPOINT}?ie=UTF-8&tl=${encodeURIComponent(lang)}` +
    `&client=tw-ob&total=1&idx=0&textlen=${text.length}` +
    `&q=${encodeURIComponent(text)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://translate.google.com/",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`tts http ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Synthesize text to a single MP3 buffer. Chunks long text and concatenates
 * the resulting MP3 segments (MP3 frame concatenation is safe — most decoders
 * handle it without reencoding).
 */
export async function synthesizeThai(text, { lang = "th" } = {}) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("empty text");
  const parts = chunk(clean, 180);
  const buffers = [];
  for (const p of parts) {
    try {
      const buf = await fetchOne(p, lang);
      buffers.push(buf);
    } catch (err) {
      throw new Error(`tts segment failed: ${err.message}`);
    }
  }
  return Buffer.concat(buffers);
}
