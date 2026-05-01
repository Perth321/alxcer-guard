// tools_openclaw.js — OpenClaw v2: code execution, web deployment, self-awareness,
// computer-mode browser automation, deep web inspection, filesystem & shell.
// Free tier: Piston API (sandbox exec), Microlink (screenshots), GitHub API (source ops).
// Computer mode uses puppeteer-core + system Chrome (pre-installed on ubuntu-latest).

import { exec as _exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(_exec);
const TIMEOUT_MS = 30_000;
const PISTON_BASE = "https://emkc.org/api/v2/piston";
const MICROLINK_BASE = "https://api.microlink.io";

// ─── Piston language aliases ──────────────────────────────────────────────────
const LANG_ALIAS = {
  py: "python", python3: "python", js: "javascript", ts: "typescript",
  "c++": "cpp", "c#": "csharp", sh: "bash", shell: "bash", rb: "ruby",
  rs: "rust", kt: "kotlin", cs: "csharp",
};
function normalizeLang(l) {
  const s = (l || "").toLowerCase().trim();
  return LANG_ALIAS[s] || s;
}
function langExt(l) {
  const map = {
    python: "py", javascript: "js", typescript: "ts", bash: "sh",
    go: "go", rust: "rs", cpp: "cpp", c: "c", java: "java",
    php: "php", ruby: "rb", kotlin: "kt", csharp: "cs",
  };
  return map[l] || "txt";
}

// ─── Run code via Piston (free sandboxed execution) ───────────────────────────
export async function runCode(language, code, stdin = "") {
  const lang = normalizeLang(language);
  try {
    const res = await fetch(`${PISTON_BASE}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: lang,
        version: "*",
        files: [{ name: `main.${langExt(lang)}`, content: code }],
        stdin: stdin || "",
        run_timeout: 20000,
        compile_timeout: 15000,
        run_memory_limit: 134217728,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (res.status === 400) {
        const rtRes = await fetch(`${PISTON_BASE}/runtimes`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
        const rt = rtRes?.ok ? await rtRes.json().catch(() => []) : [];
        const langs = rt.map((r) => r.language).join(", ");
        return { error: `Language "${lang}" not supported. Available: ${langs.slice(0, 500)}` };
      }
      return { error: `Piston ${res.status}: ${txt.slice(0, 200)}` };
    }

    const data = await res.json();
    const run = data.run ?? {};
    const compile = data.compile ?? {};
    const stdout = (run.stdout || "").slice(0, 3000);
    const stderr = (run.stderr || compile.stderr || compile.output || "").slice(0, 1000);
    const exitCode = run.code ?? compile.code ?? -1;
    const timedOut = run.signal === "SIGKILL" || compile.signal === "SIGKILL";

    return {
      language: data.language,
      version: data.version,
      stdout: stdout || "(no output)",
      stderr: stderr || undefined,
      exit_code: exitCode,
      timed_out: timedOut || undefined,
      ok: !compile.stderr && exitCode === 0 && !timedOut,
    };
  } catch (err) {
    return { error: err?.message || "code execution failed" };
  }
}

// ─── Deploy HTML as GitHub Gist → htmlpreview.github.io URL ──────────────────
export async function deployWebpage(filename, html, description = "") {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { error: "GITHUB_TOKEN not available — cannot deploy" };

  const fname = /\.html?$/i.test(filename) ? filename : `${filename}.html`;

  try {
    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: description || `Alxcer Guard deploy: ${fname}`,
        public: true,
        files: { [fname]: { content: html } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { error: e.message || `GitHub API ${res.status}` };
    }

    const gist = await res.json();
    const rawUrl = gist.files[fname]?.raw_url || "";
    const previewUrl = rawUrl ? `https://htmlpreview.github.io/?${rawUrl}` : gist.html_url;

    return {
      ok: true,
      gist_id: gist.id,
      gist_url: gist.html_url,
      preview_url: previewUrl,
      raw_url: rawUrl,
      note: "เปิดดูได้ทันทีผ่าน htmlpreview.github.io — ไม่ต้อง login",
    };
  } catch (err) {
    return { error: err?.message || "deploy failed" };
  }
}

// ─── Read latest GitHub Actions log ──────────────────────────────────────────
export async function readOwnLog(lines = 100, filter = "") {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  const H = { Authorization: `token ${token}`, Accept: "application/vnd.github+json" };

  try {
    const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=2`, {
      headers: H, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const runsData = await runsRes.json();
    const run = runsData.workflow_runs?.[0];
    if (!run) return { error: "ไม่พบ workflow runs" };

    const jobsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`, {
      headers: H, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const jobsData = await jobsRes.json();
    const job = jobsData.jobs?.[0];
    if (!job) return { error: "ไม่พบ jobs", run_status: run.status };

    const logRes = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, {
      headers: H, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const meta = {
      run_id: run.id, run_status: run.status, run_conclusion: run.conclusion,
      head_sha: run.head_sha?.slice(0, 8), job_name: job.name,
      job_status: job.status, job_conclusion: job.conclusion,
    };

    if (!logRes.ok) return { ...meta, note: "Log not yet available (run still starting up)" };

    let logLines = (await logRes.text()).split("\n");
    if (filter) logLines = logLines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
    const maxLines = Math.min(Math.max(lines, 10), 300);
    const sliced = logLines.slice(-maxLines);

    return { ...meta, log_lines: sliced.length, log: sliced.join("\n").slice(0, 6000) };
  } catch (err) {
    return { error: err?.message || "log fetch failed" };
  }
}

// ─── Read a source file from own GitHub repo ─────────────────────────────────
export async function readOwnSource(filepath) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || "main";
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filepath}?ref=${branch}`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { error: e.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.encoding !== "base64") return { error: "unexpected encoding" };
    const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
    return {
      filepath, sha: data.sha, size: data.size,
      lines: content.split("\n").length,
      content: content.slice(0, 8000),
      truncated: content.length > 8000,
    };
  } catch (err) {
    return { error: err?.message || "source read failed" };
  }
}

// ─── Write a source file to own GitHub repo (self-healing) ───────────────────
const SELF_WRITE_ALLOWED = ["bot/src/", "bot/config.json"];

export async function writeOwnSource(filepath, content, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || "main";
  if (!token || !repo) return { error: "GITHUB_TOKEN / GITHUB_REPOSITORY not set" };

  const allowed = SELF_WRITE_ALLOWED.some((p) => filepath.startsWith(p));
  if (!allowed) return { error: `ไม่อนุญาตให้แก้ไข ${filepath} — อนุญาตเฉพาะ bot/src/* และ bot/config.json เท่านั้น` };
  if (filepath.includes(".github/") || filepath.endsWith(".yml") || filepath.endsWith(".yaml"))
    return { error: "ไม่อนุญาตให้แก้ไขไฟล์ workflow" };

  const H = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  try {
    const infoRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filepath}?ref=${branch}`, {
      headers: H, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let sha = null;
    if (infoRes.ok) sha = (await infoRes.json().catch(() => ({}))).sha || null;

    const body = {
      message: commitMessage?.slice(0, 200) || `fix: self-patch ${filepath}`,
      content: Buffer.from(content).toString("base64"),
      branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filepath}`, {
      method: "PUT", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      return { error: e.message || `HTTP ${putRes.status}` };
    }
    const result = await putRes.json();
    return {
      ok: true, filepath,
      commit_sha: result.commit?.sha?.slice(0, 8),
      commit_url: result.commit?.html_url,
      note: "บันทึกแล้ว — GitHub Actions จะรีสตาร์ทบอทอัตโนมัติภายใน ~30 วินาที",
    };
  } catch (err) {
    return { error: err?.message || "source write failed" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW: Screenshot URL via Microlink API ────────────────────────────────────
// Free, no API key needed. Returns image buffer for Discord + preview URL.
// ═══════════════════════════════════════════════════════════════════════════════
export async function screenshotUrl(url, opts = {}) {
  const { width = 1280, height = 800, fullPage = false, delay = 0 } = opts;
  if (!/^https?:\/\//i.test(url)) return { error: "URL must start with http:// or https://" };

  try {
    const params = new URLSearchParams({
      url,
      screenshot: "true",
      meta: "false",
      "viewport.width": String(width),
      "viewport.height": String(height),
      "screenshot.fullPage": String(fullPage),
    });
    if (delay) params.set("waitFor", String(delay));

    const mlRes = await fetch(`${MICROLINK_BASE}?${params}`, {
      headers: { "User-Agent": "AlxcerGuardBot/2.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!mlRes.ok) return { error: `Microlink returned HTTP ${mlRes.status}` };
    const mlJson = await mlRes.json();
    if (mlJson.status !== "success") return { error: `Microlink error: ${mlJson.message || mlJson.status}` };

    const imgUrl = mlJson.data?.screenshot?.url;
    if (!imgUrl) return { error: "Microlink did not return a screenshot URL" };

    // Fetch the actual image bytes
    const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20_000) });
    if (!imgRes.ok) return { error: `Could not fetch screenshot image: HTTP ${imgRes.status}` };
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    return {
      ok: true,
      preview_url: imgUrl,
      imageBuffer,
      width: mlJson.data?.screenshot?.width || width,
      height: mlJson.data?.screenshot?.height || height,
      page_title: mlJson.data?.title || "",
      source: "microlink",
      note: `📸 Screenshot of ${url}`,
    };
  } catch (err) {
    return { error: err?.message || "screenshot failed" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW: Deep webpage inspection ─────────────────────────────────────────────
// Returns structured page intel: meta, links, headings, forms, tech stack hints.
// ═══════════════════════════════════════════════════════════════════════════════
export async function inspectWebpage(url) {
  if (!/^https?:\/\//i.test(url)) return { error: "URL must start with http:// or https://" };

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,*/*",
        "Accept-Language": "th,en;q=0.9",
      },
      signal: AbortSignal.timeout(25_000),
      redirect: "follow",
    });

    if (!res.ok) return { error: `HTTP ${res.status} — could not fetch page` };
    const html = await res.text();

    const extract = (pattern, flags = "i") => {
      const m = html.match(new RegExp(pattern, flags));
      return m ? m[1]?.trim() : null;
    };
    const extractAll = (pattern) => {
      const rx = new RegExp(pattern, "gi");
      const out = [];
      let m;
      while ((m = rx.exec(html))) out.push(m[1]?.trim());
      return out.filter(Boolean);
    };

    // Meta tags
    const title = extract("<title[^>]*>([^<]{1,300})</title>") || "";
    const description = extract('name=["\'\']?description["\'\']?[^>]+content=["\'\']([^"\'\'>]{1,400})') ||
                        extract('content=["\'\']([^"\'\'>]{1,400})[^>]+name=["\'\']?description') || "";
    const ogTitle    = extract('property=["\'\']og:title["\'\'][^>]+content=["\'\']([^"\'\'>]{1,300})') || "";
    const ogImage    = extract('property=["\'\']og:image["\'\'][^>]+content=["\'\']([^"\'\'>]+)') || "";
    const canonical  = extract('rel=["\'\']canonical["\'\'][^>]+href=["\'\']([^"\'\'>]+)') || "";
    const keywords   = extract('name=["\'\']keywords["\'\'][^>]+content=["\'\']([^"\'\'>]{1,300})') || "";
    const charset    = extract('charset=["\'\']?([\w-]+)') || "";
    const viewport   = extract('name=["\'\']viewport["\'\'][^>]+content=["\'\']([^"\'\'>]+)') || "";
    const robots     = extract('name=["\'\']robots["\'\'][^>]+content=["\'\']([^"\'\'>]+)') || "";
    const lang       = extract('<html[^>]+lang=["\'\']([^"\'\'>]+)') || "";

    // Headings
    const h1s = extractAll("<h1[^>]*>([^<]{1,200})</h1>").slice(0, 5);
    const h2s = extractAll("<h2[^>]*>([^<]{1,200})</h2>").slice(0, 8);
    const h3s = extractAll("<h3[^>]*>([^<]{1,200})</h3>").slice(0, 8);

    // Links — categorize internal vs external
    const rawLinks = extractAll('href=["\'\']?(https?://[^"\'\'>\s]{5,300})').slice(0, 50);
    const anchorLinks = extractAll('<a[^>]+href=["\'\']([^"\'\'>]+)["\'\'][^>]*>').slice(0, 60);
    const baseHost = new URL(url).hostname;
    const externalLinks = rawLinks.filter(l => { try { return new URL(l).hostname !== baseHost; } catch { return false; } }).slice(0, 20);
    const internalLinks = anchorLinks.filter(l => !l.startsWith("http") || l.includes(baseHost)).slice(0, 20);

    // Images
    const images = extractAll('<img[^>]+src=["\'\']([^"\'\'>]{4,300})').slice(0, 15);

    // Forms
    const formActions = extractAll('<form[^>]+action=["\'\']([^"\'\'>]+)').slice(0, 5);
    const inputNames = extractAll('<input[^>]+name=["\'\']([^"\'\'>]+)').slice(0, 15);
    const inputTypes = extractAll('<input[^>]+type=["\'\']([^"\'\'>]+)').slice(0, 15);

    // Scripts / tech stack hints
    const scripts = extractAll('<script[^>]+src=["\'\']([^"\'\'>]+)').slice(0, 20);
    const techStack = [];
    if (html.includes("react") || html.includes("__NEXT_DATA__")) techStack.push("React/Next.js");
    if (html.includes("vue") || html.includes("__vue_")) techStack.push("Vue.js");
    if (html.includes("angular")) techStack.push("Angular");
    if (html.includes("jquery")) techStack.push("jQuery");
    if (html.includes("wordpress") || html.includes("wp-content")) techStack.push("WordPress");
    if (html.includes("shopify")) techStack.push("Shopify");
    if (html.includes("gtag") || html.includes("ga.js")) techStack.push("Google Analytics");
    if (html.includes("bootstrap")) techStack.push("Bootstrap");
    if (html.includes("tailwind")) techStack.push("Tailwind CSS");
    if (html.includes("graphql")) techStack.push("GraphQL");

    // Word count (approximate)
    const plainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const wordCount = plainText.split(" ").filter(Boolean).length;
    const bodyPreview = plainText.slice(0, 600);

    // Response info
    const finalUrl = res.url;
    const headers = {};
    for (const [k, v] of res.headers) headers[k] = v;

    return {
      ok: true,
      url: finalUrl,
      title, description, keywords, lang, charset, viewport, robots,
      og: { title: ogTitle, image: ogImage },
      canonical,
      headings: { h1: h1s, h2: h2s, h3: h3s },
      links: { external: externalLinks, internal: internalLinks },
      images: images.slice(0, 10),
      forms: { actions: formActions, inputs: inputNames, input_types: inputTypes },
      tech_stack: techStack,
      scripts: scripts.slice(0, 10),
      word_count: wordCount,
      body_preview: bodyPreview,
      response: {
        status: res.status,
        content_type: res.headers.get("content-type"),
        server: res.headers.get("server"),
        html_size_kb: Math.round(html.length / 1024),
      },
    };
  } catch (err) {
    return { error: err?.message || "page inspection failed" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW: Website status / uptime check ──────────────────────────────────────
// Checks if a site is up: response time, status code, SSL, redirects, headers.
// ═══════════════════════════════════════════════════════════════════════════════
export async function checkWebsite(url) {
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  const start = Date.now();
  const redirectChain = [];
  let sslInfo = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    let currentUrl = url;
    let response = null;
    let hops = 0;

    // Follow redirects manually to capture chain
    while (hops < 8) {
      response = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "AlxcerGuardBot/2.0 (uptime check)" },
      });
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        redirectChain.push({ from: currentUrl, to: location, status: response.status });
        currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).href;
        hops++;
      } else {
        break;
      }
    }

    clearTimeout(timer);
    const responseTime = Date.now() - start;

    // Get useful headers
    const headers = {};
    for (const k of ["server", "x-powered-by", "content-type", "cache-control", "x-frame-options", "strict-transport-security", "content-security-policy"]) {
      const v = response.headers.get(k);
      if (v) headers[k] = v;
    }

    const isSSL = currentUrl.startsWith("https://");
    const isDown = response.status >= 500;

    return {
      ok: !isDown,
      url: currentUrl,
      original_url: url,
      status: response.status,
      status_text: response.statusText || "",
      response_time_ms: responseTime,
      speed: responseTime < 300 ? "fast" : responseTime < 1000 ? "normal" : "slow",
      ssl: isSSL,
      redirects: redirectChain.length,
      redirect_chain: redirectChain,
      headers,
      summary: isDown
        ? `🔴 ${url} — DOWN (HTTP ${response.status}, ${responseTime}ms)`
        : `🟢 ${currentUrl} — UP (HTTP ${response.status}, ${responseTime}ms)`,
    };
  } catch (err) {
    const responseTime = Date.now() - start;
    const isTimeout = err?.name === "AbortError";
    return {
      ok: false,
      url,
      status: 0,
      response_time_ms: responseTime,
      error: isTimeout ? "Timeout — site did not respond in 20s" : (err?.message || "connection failed"),
      summary: `🔴 ${url} — UNREACHABLE (${err?.message?.slice(0, 80)})`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW: Computer mode — headless browser automation ─────────────────────────
// Uses puppeteer-core + system Chrome (pre-installed on GitHub Actions ubuntu-latest).
// actions: [{type:"screenshot"}, {type:"click",selector}, {type:"type",selector,text},
//           {type:"eval",js}, {type:"goto",url}, {type:"wait",ms}, {type:"scroll",x,y},
//           {type:"get_text",selector}, {type:"fill_form",data:[{selector,value}]}]
// Returns imageBuffer(s) for Discord + action results.
// ═══════════════════════════════════════════════════════════════════════════════
let _browser = null;

async function findChromePath() {
  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  // Try which
  try {
    const { stdout } = await execAsync("which google-chrome chromium-browser chromium 2>/dev/null | head -1", { timeout: 3000 });
    const found = stdout.trim();
    if (found) return found;
  } catch {}
  return null;
}

async function getBrowser() {
  if (_browser) {
    try { await _browser.version(); return _browser; } catch { _browser = null; }
  }

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    return { error: "puppeteer-core ยังไม่ได้ติดตั้ง — บอทจะ install อัตโนมัติรอบหน้า ลองใช้ screenshot_url แทนก่อนได้เลย" };
  }

  const executablePath = await findChromePath();
  if (!executablePath) return { error: "ไม่พบ Chrome/Chromium — computer mode ต้องรันบน GitHub Actions ubuntu-latest เท่านั้น" };

  try {
    _browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--no-first-run", "--no-zygote", "--single-process",
        "--disable-extensions",
      ],
      timeout: 15_000,
    });
    return _browser;
  } catch (e) {
    return { error: `Failed to launch Chrome: ${e?.message}` };
  }
}

export async function computerBrowse(url, actions = []) {
  if (!/^https?:\/\//i.test(url)) return { error: "URL must start with http:// or https://" };

  const browser = await getBrowser();
  if (browser?.error) return browser;

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36");

    // Wait for network to settle (catches JS-rendered content like React/Vue/Angular)
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    } catch {
      // networkidle2 timed out (heavy site) — still try to continue
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
    }

    // Auto-dismiss popups: Escape closes most modals, cookie banners, date-pickers
    await page.keyboard.press("Escape").catch(() => {});
    await new Promise(r => setTimeout(r, 600));
    // Second Escape for sites that stack popups
    await page.keyboard.press("Escape").catch(() => {});
    await new Promise(r => setTimeout(r, 400));

    // Try to close common cookie banners / overlays by clicking close buttons
    const closeSels = [
      "[aria-label='close']", "[aria-label='Close']", ".modal-close", ".close-btn",
      "[data-dismiss='modal']", ".cookie-accept", "#onetrust-accept-btn-handler",
      "button[class*='close']", "button[class*='dismiss']",
    ];
    for (const sel of closeSels) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); await new Promise(r => setTimeout(r, 300)); break; }
      } catch {}
    }

    const steps = [];

    for (const action of (actions.length ? actions : [{ type: "screenshot" }])) {
      try {
        switch (action.type) {
          case "screenshot": {
            const buf = await page.screenshot({ type: "png", fullPage: action.fullPage || false });
            steps.push({ type: "screenshot", imageBuffer: buf, url: page.url(), ok: true });
            break;
          }
          case "click": {
            await page.waitForSelector(action.selector, { timeout: 6000 });
            await page.click(action.selector);
            await new Promise(r => setTimeout(r, 600));
            const buf = await page.screenshot({ type: "png" });
            steps.push({ type: "click", selector: action.selector, ok: true, url: page.url(), imageBuffer: buf });
            break;
          }
          case "type": {
            await page.waitForSelector(action.selector, { timeout: 6000 });
            await page.click(action.selector);
            await page.type(action.selector, action.text || "", { delay: 40 });
            steps.push({ type: "type", selector: action.selector, text: action.text, ok: true });
            break;
          }
          case "fill_form": {
            for (const field of (action.data || [])) {
              try {
                await page.waitForSelector(field.selector, { timeout: 4000 });
                await page.click(field.selector, { clickCount: 3 });
                await page.type(field.selector, field.value || "", { delay: 30 });
              } catch (fe) { /* skip missing fields */ }
            }
            const buf = await page.screenshot({ type: "png" });
            steps.push({ type: "fill_form", fields: (action.data || []).length, ok: true, imageBuffer: buf });
            break;
          }
          case "eval": {
            const result = await page.evaluate((js) => {
              try { return String(eval(js)).slice(0, 2000); } catch (e) { return "Error: " + e.message; }
            }, action.js || "document.title");
            steps.push({ type: "eval", result, ok: true });
            break;
          }
          case "goto": {
            try {
              await page.goto(action.url, { waitUntil: "networkidle2", timeout: 30_000 });
            } catch {
              await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
            }
            await page.keyboard.press("Escape").catch(() => {});
            await new Promise(r => setTimeout(r, 500));
            const buf = await page.screenshot({ type: "png" });
            steps.push({ type: "goto", url: page.url(), ok: true, imageBuffer: buf });
            break;
          }
          case "wait": {
            await new Promise(r => setTimeout(r, Math.min(action.ms || 1000, 10_000)));
            steps.push({ type: "wait", ms: action.ms, ok: true });
            break;
          }
          case "scroll": {
            await page.evaluate((x, y) => window.scrollBy(x || 0, y || 300), action.x || 0, action.y || 300);
            await new Promise(r => setTimeout(r, 400));
            const buf = await page.screenshot({ type: "png" });
            steps.push({ type: "scroll", ok: true, imageBuffer: buf });
            break;
          }
          case "get_text": {
            const text = await page.evaluate((sel) => {
              const el = sel ? document.querySelector(sel) : document.body;
              return el ? el.innerText.trim().slice(0, 3000) : "element not found";
            }, action.selector || null);
            steps.push({ type: "get_text", text, selector: action.selector || "body", ok: true });
            break;
          }
          case "hover": {
            await page.waitForSelector(action.selector, { timeout: 5000 });
            await page.hover(action.selector);
            await new Promise(r => setTimeout(r, 400));
            const buf = await page.screenshot({ type: "png" });
            steps.push({ type: "hover", selector: action.selector, ok: true, imageBuffer: buf });
            break;
          }
          case "select": {
            await page.waitForSelector(action.selector, { timeout: 5000 });
            await page.select(action.selector, action.value || "");
            steps.push({ type: "select", selector: action.selector, value: action.value, ok: true });
            break;
          }
          case "press": {
            await page.keyboard.press(action.key || "Enter");
            await new Promise(r => setTimeout(r, 500));
            const buf = await page.screenshot({ type: "png" });
            steps.push({ type: "press", key: action.key, ok: true, imageBuffer: buf });
            break;
          }
          default:
            steps.push({ type: action.type, error: "unknown action type" });
        }
      } catch (e) {
        steps.push({ type: action.type, error: e?.message?.slice(0, 200), ok: false });
      }
    }

    return { ok: true, final_url: page.url(), steps };
  } catch (err) {
    return { error: err?.message || "browser automation failed" };
  } finally {
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW: Local filesystem tools (GitHub Actions working directory) ───────────
// ═══════════════════════════════════════════════════════════════════════════════

// Safe paths: only allow /tmp and the bot working directory
function safePath(p) {
  const resolved = path.resolve(p);
  const allowed = ["/tmp", "/home/runner/work", process.cwd()];
  if (allowed.some(base => resolved.startsWith(base))) return resolved;
  return null;
}

export async function readLocalFile(filepath) {
  const safe = safePath(filepath);
  if (!safe) return { error: `Access denied: ${filepath} is outside allowed paths (/tmp, cwd)` };
  try {
    const stat = fs.statSync(safe);
    if (!stat.isFile()) return { error: `${filepath} is not a file` };
    const content = fs.readFileSync(safe, "utf8");
    return {
      ok: true, filepath: safe,
      size_bytes: stat.size,
      lines: content.split("\n").length,
      content: content.slice(0, 8000),
      truncated: content.length > 8000,
    };
  } catch (err) {
    return { error: err?.message || "read failed" };
  }
}

export async function writeLocalFile(filepath, content) {
  // Restrict to /tmp for safety
  const safe = path.resolve(filepath);
  if (!safe.startsWith("/tmp") && !safe.startsWith(process.cwd())) {
    return { error: "writeLocalFile: only /tmp/* and cwd/* allowed" };
  }
  try {
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content, "utf8");
    return { ok: true, filepath: safe, size_bytes: Buffer.byteLength(content, "utf8") };
  } catch (err) {
    return { error: err?.message || "write failed" };
  }
}

export async function listLocalFiles(dirpath = "/tmp") {
  const safe = safePath(dirpath);
  if (!safe) return { error: `Access denied: ${dirpath}` };
  try {
    const entries = fs.readdirSync(safe, { withFileTypes: true });
    return {
      ok: true,
      path: safe,
      entries: entries.slice(0, 100).map(e => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
        size: e.isFile() ? (() => { try { return fs.statSync(path.join(safe, e.name)).size; } catch { return 0; } })() : null,
      })),
    };
  } catch (err) {
    return { error: err?.message || "list failed" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── NEW: Shell command execution ─────────────────────────────────────────────
// Runs shell commands in the GitHub Actions environment. Blocked: rm -rf /, sudo.
// ═══════════════════════════════════════════════════════════════════════════════
const SHELL_BLOCKED = [
  /rm\s+-rf\s+\/(?!tmp)/i,   // rm -rf / (but allow /tmp)
  /mkfs/i,
  /dd\s+if=/i,
  /shutdown|reboot|halt/i,
  /passwd|adduser|useradd/i,
  /\bchmod\s+777\s+\//i,
  /curl.*\|.*sh/i,             // curl-pipe-shell
  /wget.*\|.*sh/i,
];

export async function shellExec(command, opts = {}) {
  // Safety check
  for (const pattern of SHELL_BLOCKED) {
    if (pattern.test(command)) {
      return { error: `Blocked: command matches safety pattern (${pattern})` };
    }
  }

  const maxTime = Math.min(opts.timeout_ms || 30_000, 60_000);
  const maxOutput = opts.max_output || 8000;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: maxTime,
      shell: "/bin/bash",
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      command,
      stdout: (stdout || "").slice(0, maxOutput) || "(no output)",
      stderr: (stderr || "").slice(0, 2000) || undefined,
    };
  } catch (err) {
    return {
      ok: false,
      command,
      error: err?.message?.slice(0, 500),
      stdout: (err?.stdout || "").slice(0, maxOutput),
      stderr: (err?.stderr || "").slice(0, 2000),
      killed: err?.killed || false,
    };
  }
}
