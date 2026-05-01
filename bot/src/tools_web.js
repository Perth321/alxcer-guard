// tools_web.js — OpenClaw-inspired web / utility tools for the Alxcer agent
// These are called by execTool() in agent.js when the LLM picks them.
// All free, no extra API key needed (DuckDuckGo, OpenMeteo, Wikipedia).

const WEB_TIMEOUT_MS = 15_000;

// ─── DuckDuckGo web search ────────────────────────────────────────────────────
// Uses two complementary endpoints:
//   1. api.duckduckgo.com JSON  — instant answers, abstract, related topics
//   2. lite.duckduckgo.com HTML — real search result snippets (regex parsed)
// Returns top results with title, url, snippet.
export async function webSearch(query, maxResults = 5) {
  const q = encodeURIComponent(query.trim());

  // Phase 1: Instant answers from DuckDuckGo JSON API
  const jsonUrl = `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`;
  let abstract = "";
  let relatedTopics = [];
  try {
    const res = await fetch(jsonUrl, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: { "User-Agent": "AlxcerGuardBot/1.0" },
    });
    const json = await res.json();
    abstract = json.AbstractText || json.Answer || "";
    relatedTopics = (json.RelatedTopics || [])
      .filter(t => t.Text && t.FirstURL)
      .slice(0, 3)
      .map(t => ({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text.slice(0, 200) }));
  } catch { /* ignore */ }

  // Phase 2: Real search snippets from DuckDuckGo Lite HTML
  let liteResults = [];
  try {
    const liteUrl = `https://lite.duckduckgo.com/lite/?q=${q}`;
    const res = await fetch(liteUrl, {
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AlxcerBot/1.0)",
        "Accept-Language": "th,en;q=0.9",
      },
    });
    const html = await res.text();
    // DuckDuckGo Lite HTML pattern: <a class="result-link" href="...">title</a> then <td class="result-snippet">snippet</td>
    const linkRx   = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    const snipRx   = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    const urls = [], titles = [], snips = [];
    let m;
    while ((m = linkRx.exec(html)) && urls.length < maxResults) {
      urls.push(m[1].trim());
      titles.push(m[2].trim());
    }
    while ((m = snipRx.exec(html)) && snips.length < maxResults) {
      snips.push(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300));
    }
    for (let i = 0; i < urls.length; i++) {
      liteResults.push({ title: titles[i] || "—", url: urls[i], snippet: snips[i] || "" });
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
// Strips HTML tags and returns clean readable text.
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
      // Basic HTML→text conversion
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
// Uses Wikipedia's Action API — completely free, no key.
export async function wikipediaLookup(topic, lang = "th") {
  try {
    const q = encodeURIComponent(topic.trim());
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${q}&prop=extracts&exintro=1&explaintext=1&exsentences=5&format=json&origin=*`;
    const res = await fetch(url, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    const json = await res.json();
    const pages = Object.values(json.query?.pages || {});
    if (!pages.length || pages[0].missing !== undefined) {
      // try English fallback
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
// Geocodes city using Open-Meteo geocoding API, then fetches current weather.
export async function getWeather(city) {
  try {
    // Step 1: geocode
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=th&format=json`;
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
    const geoJson = await geoRes.json();
    const loc = geoJson.results?.[0];
    if (!loc) return { error: `ไม่พบเมือง "${city}"` };

    // Step 2: fetch current weather
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

// ─── Guard AI Hotel Search ─────────────────────────────────────────────────────
// สร้าง preview URL ของ Guard AI hotel page — bot จะ screenshot หน้านี้ แล้วส่งเป็นรูปใน Discord
const GUARD_DOMAIN =
  "https://5e5b3295-7d1f-409b-9af8-893239a0279c-00-26fjm9tfs1kvk.spock.replit.dev";

export function searchHotels({ location, budget, checkin, checkout, guests = 1 }) {
  const today = new Date().toISOString().split("T")[0];
  const tom = new Date(Date.now() + 86400000).toISOString().split("T")[0];
  const cin = checkin || today;
  const cout = checkout || tom;

  const p = new URLSearchParams({ location, guests: String(guests) });
  if (budget) p.set("budget", String(budget));
  p.set("checkin", cin);
  p.set("checkout", cout);

  const preview_url = `${GUARD_DOMAIN}/api/hotels/preview?${p.toString()}`;
  return {
    ok: true,
    preview_url,
    meta: { location, budget: budget || null, checkin: cin, checkout: cout, guests: Number(guests) },
  };
}
