// screenshare.js — AI-driven live screen share in Discord voice/text channel
// Uses puppeteer-core to open a URL, takes periodic screenshots, and posts/edits
// a Discord embed so members see a live "screen share" updated every N seconds.
// The agent controls it with: screen_share_start, screen_share_navigate,
// screen_share_click, screen_share_type, screen_share_scroll, screen_share_stop.

import puppeteer from "puppeteer-core";
import { execSync } from "child_process";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";

/** The shared session state — one screen share at a time. */
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

export function isActive() { return _intervalId !== null || _browser !== null; }

export function getStatus() {
  if (!isActive()) return { active: false };
  return {
    active: true,
    url: _currentUrl,
    updateCount: _updateCount,
    startedAt: _startedAt?.toISOString(),
    intervalMs: _intervalMs,
  };
}

async function _captureAndUpdate(label) {
  if (!_page || !_liveMessage) return;
  try {
    const buf = await _page.screenshot({ type: "png" });
    _updateCount++;
    const att = new AttachmentBuilder(buf, { name: "screen.png" });
    const embed = new EmbedBuilder()
      .setTitle(`🖥️ Screen Share — ${_currentUrl.slice(0, 100)}`)
      .setDescription(label || `อัปเดตทุก ${_intervalMs / 1000}s · #${_updateCount}`)
      .setImage("attachment://screen.png")
      .setColor(0x5865f2)
      .setFooter({ text: `เริ่มเมื่อ ${_startedAt?.toLocaleTimeString("th-TH")}` })
      .setTimestamp();
    await _liveMessage.edit({ embeds: [embed], files: [att] });
  } catch (e) {
    console.warn("[screenshare] update error:", e.message);
  }
}

/**
 * Start live screen sharing. Posts an embed to `channel` and keeps it updated.
 * @param {object} opts
 * @param {string} opts.url - URL to open
 * @param {import("discord.js").TextChannel} opts.channel - Where to post the embed
 * @param {number} [opts.intervalSeconds=8] - Screenshot interval in seconds
 */
export async function startScreenShare({ url, channel, intervalSeconds = 8 }) {
  if (isActive()) await stopScreenShare();

  const chromePath = findChrome();
  if (!chromePath) {
    return { error: "ไม่พบ Chrome บนเครื่องนี้ — ต้องรันบน GitHub Actions (ubuntu-latest) หรือเครื่องที่มี Chrome ติดตั้ง" };
  }

  _intervalMs = Math.max(3, intervalSeconds) * 1000;
  _startedAt = new Date();
  _updateCount = 0;
  _currentUrl = url;
  _targetChannel = channel;

  try {
    _browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--window-size=1280,720",
      ],
    });
    _page = await _browser.newPage();
    await _page.setViewport(VIEWPORT);
    await _page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
    await _page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Post initial screenshot
    const buf = await _page.screenshot({ type: "png" });
    _updateCount = 1;
    const att = new AttachmentBuilder(buf, { name: "screen.png" });
    const embed = new EmbedBuilder()
      .setTitle(`🖥️ Screen Share เริ่มแล้ว — ${url.slice(0, 100)}`)
      .setDescription(`อัปเดตทุก ${intervalSeconds}s · กด stop เมื่อต้องการหยุด`)
      .setImage("attachment://screen.png")
      .setColor(0x57f287)
      .setFooter({ text: `เริ่มเมื่อ ${_startedAt.toLocaleTimeString("th-TH")}` })
      .setTimestamp();

    _liveMessage = await channel.send({ embeds: [embed], files: [att] });

    // Start periodic updates
    _intervalId = setInterval(() => _captureAndUpdate(), _intervalMs);

    return { ok: true, url, messageId: _liveMessage.id, intervalSeconds };
  } catch (e) {
    await _cleanup();
    return { error: e.message };
  }
}

/** Navigate to a new URL while screen sharing */
export async function navigateTo(url) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    _currentUrl = url;
    await _page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await _captureAndUpdate(`🔗 ไปที่ ${url}`);
    return { ok: true, url };
  } catch (e) { return { error: e.message }; }
}

/** Click an element by CSS selector and take a screenshot */
export async function clickElement(selector) {
  if (!_page) return { error: "ไม่มี screen share active" };
  try {
    await _page.click(selector);
    await new Promise(r => setTimeout(r, 600));
    await _captureAndUpdate(`🖱️ คลิก \`${selector}\``);
    return { ok: true, selector };
  } catch (e) { return { error: e.message }; }
}

/** Type text into a selector */
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

/** Take an immediate screenshot (without waiting for the interval) */
export async function snapshotNow() {
  if (!_page) return { error: "ไม่มี screen share active" };
  await _captureAndUpdate("📸 Snapshot ตอนนี้");
  return { ok: true, updateCount: _updateCount };
}

async function _cleanup() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  if (_liveMessage) {
    try {
      const embed = new EmbedBuilder()
        .setTitle("🖥️ Screen Share — หยุดแล้ว")
        .setDescription(`อัปเดตทั้งหมด ${_updateCount} ครั้ง`)
        .setColor(0xed4245)
        .setTimestamp();
      await _liveMessage.edit({ embeds: [embed], files: [] });
    } catch { /* ignore */ }
    _liveMessage = null;
  }
  if (_page) { try { await _page.close(); } catch { /* ignore */ } _page = null; }
  if (_browser) { try { await _browser.close(); } catch { /* ignore */ } _browser = null; }
  const count = _updateCount;
  _currentUrl = "";
  _targetChannel = null;
  _updateCount = 0;
  _startedAt = null;
  return count;
}

/** Stop screen sharing */
export async function stopScreenShare() {
  const totalUpdates = await _cleanup();
  return { ok: true, totalUpdates };
}
