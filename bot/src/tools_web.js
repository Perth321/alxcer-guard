// tools_web.js — OpenClaw-inspired web / utility tools for the Alxcer agent
// These are called by execTool() in agent.js when the LLM picks them.
// All free, no extra API key needed (DuckDuckGo, OpenMeteo, Wikipedia).

const WEB_TIMEOUT_MS = 15_000;

// ─── DuckDuckGo web search ────────────────────────────────────────────────────
// Uses two complementary endpoints:
//   1. api.duckduckgo.com JSON  — instant answers, abstract, related topics
//   2. html.duckduckgo.com HTML — real search result snippets (regex parsed)
export async function webSearch(query, maxResults = 5) {
  const q = encodeURIComponent(query.trim());

  // Phase 1: Instant answers from DuckDuckGo JSON API
  const jsonUrl = `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`;
  let abstract = "";
  let relatedTopics = [];
  try {
    const res = await fetch(jsonUrl, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: { "User-Agent": "AlxcerGuardBot/2.0" },
    });
    const json = await res.json();
    abstract = json.AbstractText || json.Answer || "";
    relatedTopics = (json.RelatedTopics || [])
      .filter((t) => t.Text && t.FirstURL)
      .slice(0, 3)
      .map((t) => ({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text.slice(0, 200) }));
  } catch { /* ignore */ }

  // Phase 2: Real search snippets — try html.duckduckgo.com
  let liteResults = [];
  try {
    const htmlUrl = `https://html.duckduckgo.com/html/?q=${q}`;
    const res = await fetch(htmlUrl, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "th,en;q=0.9",
      },
    });
    const html = await res.text();

    // DDG HTML: links inside <a class="result__a">, snippets inside <a class="result__snippet">
    const titleRx = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snipRx  = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const urls = [], titles = [], snips = [];
    let m;
    while ((m = titleRx.exec(html)) && urls.length < maxResults) {
      const href = m[1].trim();
      // DDG wraps as /l/?uddg=<encoded-real-url> — decode if needed
      const uddg = href.match(/uddg=([^&]+)/);
      const realUrl = uddg ? decodeURIComponent(uddg[1]) : href;
      if (!realUrl.startsWith("http")) continue;
      urls.push(realUrl);
      titles.push(m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120));
    }
    while ((m = snipRx.exec(html)) && snips.length < maxResults) {
      snips.push(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300));
    }
    for (let i = 0; i < urls.length; i++) {
      liteResults.push({ title: titles[i] || "—", url: urls[i], snippet: snips[i] || "" });
    }

    // Fallback: lite.duckduckgo.com if html variant returned nothing
    if (!liteResults.length) {
      const liteUrl = `https://lite.duckduckgo.com/lite/?q=${q}`;
      const lRes = await fetch(liteUrl, {
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AlxcerBot/2.0)",
          "Accept-Language": "th,en;q=0.9",
        },
      });
      const lHtml = await lRes.text();
      const lLinkRx = /<a[^>]+class="result-link"[^>]*href="(https?:[^"]+)"[^>]*>([^<]+)<\/a>|<a[^>]+href="(https?:[^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi;
      const lSnipRx = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
      const lu = [], lt = [], ls = [];
      while ((m = lLinkRx.exec(lHtml)) && lu.length < maxResults) {
        lu.push((m[1] || m[3]).trim());
        lt.push((m[2] || m[4]).trim());
      }
      while ((m = lSnipRx.exec(lHtml)) && ls.length < maxResults) {
        ls.push(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300));
      }
      for (let i = 0; i < lu.length; i++) {
        liteResults.push({ title: lt[i] || "—", url: lu[i], snippet: ls[i] || "" });
      }
    }
  } catch { /* ignore */ }

  const results = liteResults.length ? liteResults : relatedTopics;

  return {
    query,
    abstract: abstract ? abstract.slice(0, 500) : undefined,
    results: results.slice(0, maxResults),
    source: "DuckDuckGo",
    note: results.length === 0 ? "No results found — try rephrasing" : `${results.length} results`,
  };
}

// ─── Fetch & extract text from URL ───────────────────────────────────────────
export async function fetchUrl(url, maxChars = 3000) {
  if (!/^https?:\/\//i.test(url)) return { error: "URL must start with http:// or https://" };
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AlxcerBot/1.0)",
        Accept: "text/html,text/plain",
      },
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const raw = await res.text();
    let text;
    if (ct.includes("text/html")) {
      text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    } else {
      text = raw.trim();
    }
    return {
      url,
      status: res.status,
      content_type: ct.split(";")[0],
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      chars: Math.min(text.length, maxChars),
    };
  } catch (err) {
    return { error: err?.message || "fetch failed" };
  }
}

// ─── Wikipedia quick lookup ───────────────────────────────────────────────────
export async function wikipediaLookup(topic, lang = "th") {
  try {
    const q = encodeURIComponent(topic.trim());
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${q}&prop=extracts&exintro=1&explaintext=1&exsentences=5&format=json&origin=*`;
    const res = await fetch(url, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    const json = await res.json();
    const pages = Object.values(json.query?.pages || {});
    if (!pages.length || pages[0].missing !== undefined) {
      const enUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${q}&prop=extracts&exintro=1&explaintext=1&exsentences=5&format=json&origin=*`;
      const enRes = await fetch(enUrl, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
      const enJson = await enRes.json();
      const enPages = Object.values(enJson.query?.pages || {});
      if (!enPages.length || enPages[0].missing !== undefined) return { error: "ไม่พบข้อมูลใน Wikipedia" };
      const p = enPages[0];
      return { title: p.title, extract: (p.extract || "").slice(0, 1000), lang: "en", source: "Wikipedia" };
    }
    const p = pages[0];
    return { title: p.title, extract: (p.extract || "").slice(0, 1000), lang, source: "Wikipedia" };
  } catch (err) {
    return { error: err?.message || "wikipedia lookup failed" };
  }
}

// ─── Weather (OpenMeteo — completely free, no API key) ────────────────────────
export async function getWeather(city) {
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=th&format=json`;
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    const geoJson = await geoRes.json();
    const loc = geoJson.results?.[0];
    if (!loc) return { error: `ไม่พบเมือง "${city}"` };

    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature&wind_speed_unit=kmh&timezone=auto`;
    const wxRes = await fetch(wxUrl, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    const wxJson = await wxRes.json();
    const cur = wxJson.current;

    const WMO_CODES = {
      0: "ท้องฟ้าแจ่มใส", 1: "ค่อนข้างแจ่มใส", 2: "มีเมฆบางส่วน", 3: "มีเมฆมาก",
      45: "หมอกลงจัด", 48: "หมอกน้ำแข็ง", 51: "ฝนปรอยเบา", 53: "ฝนปรอยปานกลาง", 55: "ฝนปรอยหนัก",
      61: "ฝนเบา", 63: "ฝนปานกลาง", 65: "ฝนหนัก", 71: "หิมะเบา", 73: "หิมะปานกลาง",
      75: "หิมะหนัก", 80: "ฝนฟ้าคะนองเบา", 81: "ฝนฟ้าคะนองปานกลาง", 82: "ฝนฟ้าคะนองรุนแรง",
      95: "พายุฝนฟ้าคะนอง", 96: "พายุลูกเห็บ", 99: "พายุลูกเห็บรุนแรง",
    };

    return {
      city: loc.name,
      country: loc.country,
      latitude: loc.latitude,
      longitude: loc.longitude,
      timezone: wxJson.timezone,
      temperature_c: cur.temperature_2m,
      feels_like_c: cur.apparent_temperature,
      humidity_pct: cur.relative_humidity_2m,
      wind_kmh: cur.wind_speed_10m,
      condition: WMO_CODES[cur.weather_code] ?? `code ${cur.weather_code}`,
      time: cur.time,
    };
  } catch (err) {
    return { error: err?.message || "weather fetch failed" };
  }
}

// ─── Hotel Search ─────────────────────────────────────────────────────────────
// Generates direct Booking.com + Agoda deep-links for a given location/dates.
// Fixed: previous version had a hardcoded expired Replit dev URL that caused 404s.
export function searchHotels({ location, budget, checkin, checkout, guests = 1 }) {
  const today = new Date().toISOString().split("T")[0];
  const tom   = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  const cin   = checkin  || today;
  const cout  = checkout || tom;
  const g     = Number(guests) || 1;

  // Booking.com deep link
  const bkParams = new URLSearchParams({
    ss:           location,
    checkin:      cin,
    checkout:     cout,
    group_adults: String(g),
    no_rooms:     "1",
    lang:         "th",
  });
  if (budget) bkParams.set("nflt", `price=THB-min-${budget}-1`);
  const bookingUrl = `https://www.booking.com/search.html?${bkParams.toString()}`;

  // Agoda deep link
  const agParams = new URLSearchParams({
    city:     location,
    checkIn:  cin,
    checkOut: cout,
    adults:   String(g),
    rooms:    "1",
    currency: "THB",
    language: "th-th",
  });
  if (budget) agParams.set("maxPrice", String(budget));
  const agodaUrl = `https://www.agoda.com/search?${agParams.toString()}`;

  return {
    ok: true,
    location,
    checkin:     cin,
    checkout:    cout,
    guests:      g,
    budget:      budget || null,
    booking_url: bookingUrl,
    agoda_url:   agodaUrl,
    message:     `ค้นหาที่พักใน ${location} (${cin} → ${cout}, ${g} คน)${budget ? `, งบไม่เกิน ${budget} บาท` : ""}: [Booking.com](${bookingUrl}) | [Agoda](${agodaUrl})`,
  };
}

// ─── Translate text using MyMemory free API (no API key needed) ──────────────
export async function translateText(text, { from = "auto", to = "en" } = {}) {
  if (!text) return { error: "text required" };
  const maxLen = 500;
  const chunk = text.slice(0, maxLen);
  const langPair = from === "auto" ? `${to}|${to}` : `${from}|${to}`;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(from === "auto" ? "th|" + to : from + "|" + to)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `MyMemory HTTP ${res.status}` };
    const data = await res.json();
    if (data.responseStatus !== 200) return { error: data.responseDetails || "translation failed" };
    return {
      ok: true,
      original: chunk,
      translated: data.responseData?.translatedText || "",
      from: from === "auto" ? (data.responseData?.detectedLanguage || "auto") : from,
      to,
      truncated: text.length > maxLen,
    };
  } catch (err) {
    return { error: err?.message || "translateText failed" };
  }
}

// ─── Generate image via Pollinations.ai (free, no key) ────────────────────────
export async function generateImage(prompt, { width = 1024, height = 1024 } = {}) {
  if (!prompt) return { error: "prompt required" };
  const w = Math.min(Math.max(Number(width) || 1024, 256), 2048);
  const h = Math.min(Math.max(Number(height) || 1024, 256), 2048);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&enhance=false&seed=${Math.floor(Math.random()*9999)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { error: `Pollinations returned ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return { error: "image too small — generation may have failed" };
    return { ok: true, imageBuffer: buf, source_url: url };
  } catch (err) {
    return { error: err?.message || "generateImage failed" };
  }
}

// ─── Generate chart image via QuickChart.io (free, no key) ────────────────────
export async function getQuickChart(chartConfig, { width = 700, height = 400 } = {}) {
  try {
    const body = JSON.stringify({ chart: chartConfig, width, height, backgroundColor: "white", format: "png", version: "4" });
    const res = await fetch("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // Fallback: GET request
      const encoded = encodeURIComponent(JSON.stringify(chartConfig));
      const res2 = await fetch(`https://quickchart.io/chart?c=${encoded}&w=${width}&h=${height}&bkg=white&format=png`, { signal: AbortSignal.timeout(15_000) });
      if (!res2.ok) return { error: `QuickChart returned ${res2.status}` };
      const buf2 = Buffer.from(await res2.arrayBuffer());
      return { ok: true, imageBuffer: buf2 };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, imageBuffer: buf };
  } catch (err) {
    return { error: err?.message || "getQuickChart failed" };
  }
}

// ─── Define word via Free Dictionary API (free, English) ─────────────────────
export async function defineWord(word) {
  if (!word) return { error: "word required" };
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { error: `ไม่พบคำว่า "${word}" ในพจนานุกรม` };
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) return { error: "no definition found" };
    const entry = data[0];
    const phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || "";
    const meanings = (entry.meanings || []).slice(0, 3).map(m => ({
      partOfSpeech: m.partOfSpeech,
      definitions: (m.definitions || []).slice(0, 2).map(d => ({ definition: d.definition, example: d.example || "" })),
      synonyms: (m.synonyms || []).slice(0, 4),
    }));
    return { ok: true, word: entry.word, phonetic, meanings };
  } catch (err) {
    return { error: err?.message || "defineWord failed" };
  }
}

// ─── Urban Dictionary lookup (slang) ─────────────────────────────────────────
export async function urbanDefine(word) {
  if (!word) return { error: "word required" };
  try {
    const res = await fetch(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { error: "urban dictionary failed" };
    const data = await res.json();
    const list = (data.list || []).slice(0, 2);
    if (!list.length) return { error: `ไม่พบคำว่า "${word}" ใน Urban Dictionary` };
    return {
      ok: true,
      word,
      results: list.map(e => ({
        definition: (e.definition || "").replace(/\[|\]/g, "").slice(0, 500),
        example: (e.example || "").replace(/\[|\]/g, "").slice(0, 300),
        thumbs_up: e.thumbs_up,
      })),
    };
  } catch (err) {
    return { error: err?.message || "urbanDefine failed" };
  }
}

// ─── Trivia question via Open Trivia DB (free, no key) ───────────────────────
export async function getTrivia({ category = "", difficulty = "" } = {}) {
  const CAT = { general:9, science:17, history:23, geography:22, sports:21, entertainment:11, computers:18, music:12, anime:31, movies:11, tv:14 };
  const params = new URLSearchParams({ amount: "1", type: "multiple" });
  const catKey = (category || "").toLowerCase();
  if (CAT[catKey]) params.set("category", String(CAT[catKey]));
  if (difficulty) params.set("difficulty", difficulty.toLowerCase());
  try {
    const res = await fetch(`https://opentdb.com/api.php?${params}`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json();
    if (data.response_code !== 0 || !data.results?.[0]) return { error: "trivia fetch failed — try again" };
    const q = data.results[0];
    const dec = s => s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&rsquo;/g,"'");
    const choices = [...q.incorrect_answers, q.correct_answer].map(dec).sort(() => Math.random() - 0.5);
    return { ok:true, question:dec(q.question), correct:dec(q.correct_answer), choices, category:q.category, difficulty:q.difficulty };
  } catch (err) {
    return { error: err?.message || "getTrivia failed" };
  }
}

// ─── URL shortener via is.gd (free, no key) ──────────────────────────────────
export async function shortenUrl(url) {
  if (!url) return { error: "url required" };
  try {
    const res = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { error: "shortener failed" };
    const short = (await res.text()).trim();
    if (!short.startsWith("http")) return { error: "invalid response: " + short.slice(0, 50) };
    return { ok: true, short_url: short, original: url };
  } catch (err) {
    return { error: err?.message || "shortenUrl failed" };
  }
}

