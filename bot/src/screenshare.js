// screenshare.js — AI-driven live screen share in Discord voice/text channel
// v2: smarter interactions — zoom, element highlight, scroll-to, annotate.
// Uses puppeteer-core (headless Chrome) + sharp for image annotation.

import puppeteer from "puppeteer-core";
import { execSync } from "child_process";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";

let _browser = null;
let _page = null;
let _intervalId = null;
let _currentUrl = "";
let _targetChannel = null;
let _liveMessage = null;
let _updateCount = 0;
let _startedAt = null;
let _intervalMs = 8_000;

const VIEWPORT = { width: 1280, height: 720 };

function findChrome() {
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];
  for (const c of candidates) {
    try { execSync(`test -f "${c}"`); return c; } catch { /* skip */ }
  }
  return null;
}

export function isActive() { return _browser !== null; }

export function getStatus() {
  if (!isActive()) return { active: false };
  return { active: true, url: _currentUrl, updateCount: _updateCount,
    startedAt: _startedAt?.toISOString(), intervalMs: _intervalMs };
}

async function _sendEmbed({ buf, title, description, color = 0x5865f2 }) {
  if (!_liveMessage) return;
  try {
    const att = new AttachmentBuilder(buf, { name: "screen.png" });
    const embed = new EmbedBuilder()
      .setTitle(title || `🖥️ ${_currentUrl.slice(0, 100)}`)
      .setDescription(description || `อัปเดต #${_updateCount}`)
      .setImage("attachment://screen.png")
      .setColor(color)
      .setFooter({ text: `เริ่มเมื่อ ${_startedAt?.toLocaleTimeString("th-TH")}` })
      .setTimestamp();
    await _liveMessage.edit({ embeds: [embed], files: [att] });
  } catch (e) {
    console.warn("[screenshare] embed error:", e.message);
  }
}

async function _captureAndUpdate(label) {
  if (!_page) return;
  try {
    const buf = await _page.screenshot({ type: "png" });
    _updateCount++;
    await _sendEmbed({ buf, description: label || `อัปเดตทุก ${_intervalMs / 1000}s · #${_updateCount}` });
  } catch (e) {
    console.warn("[screenshare] capture error:", e.message);
  }
}

// ── Highlight elements by drawing colored borders via JS injection ─────────────
async function _highlightElements(selectors, color = "#ff4444", durationMs = 3000) {
  if (!_page) return;
  await _page.evaluate((sels, col, dur) => {
    const added = [];
    for (const sel of sels) {
      try {
        const els = document.querySelectorAll(sel);
        els.forEach(el => {
          const orig = el.style.outline;
          el.style.outline = `3px solid ${col}`;
          el.style.outlineOffset = "2px";
          added.push({ el, orig });
        });
      } catch {}
    }
    if (dur > 0) setTimeout(() => added.forEach(({ el, orig }) => { el.style.outline = orig; }), dur);
  }, selectors, color, durationMs);
}

// ── Zoom into a bounding box area ─────────────────────────────────────────────
async function _zoomToElement(selector) {
  if (!_page) return null;
  try {
    const box = await _page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, selector);
    if (!box || box.width < 1) return null;
    // Expand the clip area a bit
    const pad = 20;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(1280, box.width + pad * 2),
      height: Math.min(720, box.height + pad * 2),
    };
    const buf = await _page.screenshot({ type: "png", clip });
    return buf;
  } catch { return null; }
}

/** Start live screen sharing */
export async function startScreenShare({ url, channel, intervalSeconds = 8 }) {
  if (isActive()) await stopScreenShare();
  const chromePath = findChrome();
  if (!chromePath) return { error: "ไม่พบ Chrome — ต้องรันบน GitHub Actions (ubuntu-latest)" };

  _intervalMs = Math.max(3, intervalSeconds) * 1000;
  _startedAt = new Date();
  _updateCount = 0;
  _currentUrl = url;
  _targetChannel = channel;

  try {
    _browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
             "--disable-gpu","--disable-software-rasterizer","--window-size=1280,720"],
    });
    _page = await _browser.newPage();
    await _page.setViewport(VIEWPORT);
    await _page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
    await _page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const buf = await _page.screenshot({ type: "png" });
    _updateCount = 1;
    const att = new AttachmentBuilder(buf, { name: "screen.png" });
    const embed = new EmbedBuilder()
      .setTitle(`🖥️ Screen Share เริ่มแล้ว`)
      .setDescription(`กำลังดู: ${url.slice(0, 120)}\nอัปเดตทุก ${intervalSeconds}s`)
      .setImage("attachment://screen.png")
      .setColor(0x57f287)
      .setFooter({ text: `เริ่มเมื่อ ${_startedAt.toLocaleTimeString("th-TH")}` })
      .setTimestamp();

    _liveMessage = await channel.send({ embeds: [embed], files: [att] });
    _intervalId = setInterval(() => _captureAndUpdate(), _intervalMs);
    return { ok: true, url, messageId: _liveMessage.id, intervalSeconds };
  } catch (e) {
    await _cleanup();
    return { error: e.message };
  }
}

/** Navigate to a new URL */
export async function navigateTo(url) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    _currentUrl = url;
    await _page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await _captureAndUpdate(`🔗 ไปที่ ${url}`);
    return { ok: true, url };
  } catch (e) { return { error: e.message }; }
}

/** Click an element and screenshot */
export async function clickElement(selector) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    await _highlightElements([selector], "#ff4444", 800);
    await _page.click(selector);
    await new Promise(r => setTimeout(r, 700));
    await _captureAndUpdate(`🖱️ คลิก \`${selector}\``);
    return { ok: true, selector };
  } catch (e) { return { error: e.message }; }
}

/** Type text into an element */
export async function typeText(selector, text) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    await _page.click(selector);
    await _page.type(selector, text, { delay: 40 });
    await _captureAndUpdate(`⌨️ พิมพ์ใน \`${selector}\`: ${text}`);
    return { ok: true, selector, text };
  } catch (e) { return { error: e.message }; }
}

/** Scroll the page */
export async function scrollPage(direction = "down", pixels = 600) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    await _page.evaluate((dir, px) => window.scrollBy(0, dir === "down" ? px : -px), direction, pixels);
    await new Promise(r => setTimeout(r, 300));
    await _captureAndUpdate(`📜 Scroll ${direction} ${pixels}px`);
    return { ok: true, direction, pixels };
  } catch (e) { return { error: e.message }; }
}

/** Zoom into a CSS selector — crops + sends just that element */
export async function zoomToElement(selector) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    await _highlightElements([selector], "#4488ff", 2000);
    await new Promise(r => setTimeout(r, 100));
    const buf = await _zoomToElement(selector);
    if (!buf) {
      // Fall back to full screenshot if element not found
      await _captureAndUpdate(`🔍 ซูมไม่เจอ \`${selector}\` — ส่งหน้าจอเต็ม`);
      return { error: `ไม่พบ element: ${selector}` };
    }
    _updateCount++;
    await _sendEmbed({ buf, description: `🔍 ซูมที่ \`${selector}\``, color: 0xfee75c });
    return { ok: true, selector };
  } catch (e) { return { error: e.message }; }
}

/** Highlight one or more elements with a colored border and screenshot */
export async function highlightElements(selectors, color = "#ff4444") {
  if (!_page) return { error: "ไม่มี screen share active" };
  const list = Array.isArray(selectors) ? selectors : [selectors];
  try {
    await _highlightElements(list, color, 5000);
    await new Promise(r => setTimeout(r, 200));
    await _captureAndUpdate(`🎯 ไฮไลต์: ${list.join(", ")}`);
    return { ok: true, selectors: list };
  } catch (e) { return { error: e.message }; }
}

/** Scroll so an element is in view, then screenshot */
export async function scrollToElement(selector) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    await _page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, selector);
    await new Promise(r => setTimeout(r, 600));
    await _highlightElements([selector], "#00cc88", 3000);
    await new Promise(r => setTimeout(r, 150));
    await _captureAndUpdate(`🎯 เลื่อนไปที่ \`${selector}\``);
    return { ok: true, selector };
  } catch (e) { return { error: e.message }; }
}

/** Run arbitrary JS on the page (for power users) */
export async function evalOnPage(code) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    const result = await _page.evaluate(code);
    await new Promise(r => setTimeout(r, 300));
    await _captureAndUpdate(`⚡ eval: ${code.slice(0, 60)}`);
    return { ok: true, result: String(result).slice(0, 500) };
  } catch (e) { return { error: e.message }; }
}

/** Take an immediate snapshot without waiting for interval */
export async function snapshotNow() {
  if (!_page) return { error: "ไม่มี screen share active" };
  await _captureAndUpdate("📸 Snapshot ทันที");
  return { ok: true, updateCount: _updateCount };
}

async function _cleanup() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  if (_liveMessage) {
    try {
      await _liveMessage.edit({
        embeds: [new EmbedBuilder().setTitle("🖥️ Screen Share — หยุดแล้ว")
          .setDescription(`อัปเดตทั้งหมด ${_updateCount} ครั้ง`).setColor(0xed4245).setTimestamp()],
        files: [],
      });
    } catch { /* ignore */ }
    _liveMessage = null;
  }
  if (_page) { try { await _page.close(); } catch {} _page = null; }
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
  const count = _updateCount;
  _currentUrl = ""; _targetChannel = null; _updateCount = 0; _startedAt = null;
  return count;
}

/** Stop screen sharing */
export async function stopScreenShare() {
  const totalUpdates = await _cleanup();
  return { ok: true, totalUpdates };
}
