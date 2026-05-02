// screenshare.js v3 — Real Discord Go Live video streaming
// Pipeline: Xvfb (virtual display) → Chrome (non-headless) → ffmpeg (x11grab→H264)
//           → @dank074/discord-video-stream → Discord voice channel Go Live
//
// Users in the voice channel see a proper "Go Live" stream they can click to watch,
// not just images posted in chat.

import { Streamer, streamLivestreamVideo } from "@dank074/discord-video-stream";
import { spawn, execSync, spawnSync } from "child_process";
import { EmbedBuilder } from "discord.js";

const DISPLAY_NUM = ":99";
const VIEWPORT_W = 1280;
const VIEWPORT_H = 720;
const FPS = 30;

let _streamer = null;
let _xvfbProc = null;
let _chromeProc = null;
let _streamAbortController = null;
let _currentUrl = "";
let _startedAt = null;
let _guildId = null;
let _channelId = null;
let _notifyChannel = null;  // text channel to post status messages
let _notifyMessage = null;

// ── helpers ────────────────────────────────────────────────────────────────────

function findChrome() {
  for (const p of [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ]) {
    try { execSync(`test -f "${p}"`); return p; } catch { /* skip */ }
  }
  return null;
}

function isXvfbRunning() {
  try { execSync(`xdpyinfo -display ${DISPLAY_NUM}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postStatus(text, color = 0x5865f2) {
  if (!_notifyChannel) return;
  const embed = new EmbedBuilder().setDescription(text).setColor(color).setTimestamp();
  try {
    if (_notifyMessage) {
      await _notifyMessage.edit({ embeds: [embed] });
    } else {
      _notifyMessage = await _notifyChannel.send({ embeds: [embed] });
    }
  } catch { /* ignore */ }
}

// ── public API ─────────────────────────────────────────────────────────────────

export function isActive() { return _streamer !== null; }

export function getStatus() {
  if (!isActive()) return { active: false };
  return {
    active: true,
    url: _currentUrl,
    guildId: _guildId,
    channelId: _channelId,
    startedAt: _startedAt?.toISOString(),
  };
}

/**
 * Start a real Discord Go Live screen share.
 * @param {object} opts
 * @param {string}  opts.url            - URL to open in Chrome
 * @param {object}  opts.client         - discord.js Client instance
 * @param {string}  opts.guildId        - Guild ID
 * @param {string}  opts.channelId      - Voice channel ID to stream into
 * @param {object}  [opts.notifyChannel]- Text channel for status updates
 */
export async function startScreenShare({ url, client, guildId, channelId, notifyChannel }) {
  if (isActive()) await stopScreenShare();

  const chromePath = findChrome();
  if (!chromePath) return { error: "ไม่พบ Chrome — ต้องรันบน GitHub Actions (ubuntu-latest)" };

  _currentUrl = url;
  _guildId = guildId;
  _channelId = channelId;
  _notifyChannel = notifyChannel || null;
  _notifyMessage = null;
  _startedAt = new Date();

  await postStatus(`🖥️ **กำลังเริ่ม screen share…**\n> URL: ${url}`, 0xfee75c);

  // 1. Start Xvfb virtual display
  if (!isXvfbRunning()) {
    _xvfbProc = spawn("Xvfb", [DISPLAY_NUM, "-screen", "0", `${VIEWPORT_W}x${VIEWPORT_H}x24`], {
      detached: false,
      stdio: "ignore",
    });
    _xvfbProc.on("error", e => console.warn("[screenshare] Xvfb error:", e.message));
    await sleep(1200);
  }

  // 2. Open Chrome on the virtual display
  _chromeProc = spawn(chromePath, [
    `--display=${DISPLAY_NUM}`,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--start-maximized",
    `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
    url,
  ], { stdio: "ignore" });
  _chromeProc.on("error", e => console.warn("[screenshare] Chrome error:", e.message));
  await sleep(3000); // Wait for page to load

  // 3. Join Discord voice channel via Streamer
  try {
    _streamer = new Streamer(client);
    await _streamer.joinVoice(guildId, channelId);
    await sleep(800);

    // 4. Create Go Live stream (this shows "LIVE" badge to users)
    const udp = await _streamer.createStream({
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      fps: FPS,
      bitrateKbps: 3000,
      maxBitrateKbps: 8000,
      hardwareAcceleratedDecoding: false,
      videoCodec: "H264",
    });

    // 5. Stream x11grab → H264 → Discord using ffmpeg
    _streamAbortController = new AbortController();
    const { signal } = _streamAbortController;

    await postStatus(
      `🔴 **Screen Share กำลัง Live อยู่**\n` +
      `> กด **"ดู stream"** ในห้องเสียง **<#${channelId}>** เพื่อดู\n` +
      `> URL: ${url}`,
      0xed4245
    );

    // streamLivestreamVideo handles ffmpeg internally — point it at the x11grab device
    const streamPromise = streamLivestreamVideo(
      `${DISPLAY_NUM}.0`,   // x11grab input display
      udp,
      {
        fps: FPS,
        bitrateVideo: 3000,
        videoCodec: "H264",
        h26xPreset: "ultrafast",
        // Tell the library this is a screen capture (x11grab)
        inputFormat: "x11grab",
        inputOptions: ["-video_size", `${VIEWPORT_W}x${VIEWPORT_H}`, "-framerate", String(FPS)],
      }
    ).catch(e => {
      if (!signal.aborted) console.warn("[screenshare] stream ended:", e.message);
    });

    // Store promise for cleanup
    _streamer._streamPromise = streamPromise;

    return { ok: true, url, channelId, note: "Go Live stream started — users can click to watch" };
  } catch (e) {
    await _cleanup();
    return { error: e.message };
  }
}

/** Navigate Chrome to a new URL while streaming */
export async function navigateTo(url) {
  if (!_chromeProc) return { error: "ไม่มี screen share active" };
  _currentUrl = url;
  // Open new URL by spawning another chrome command (opens in same window)
  const chromePath = findChrome();
  spawn(chromePath, [
    `--display=${DISPLAY_NUM}`,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    url,
  ], { stdio: "ignore" });
  await sleep(2500);
  await postStatus(`🔴 **Live** | ไปที่: ${url}`, 0xed4245);
  return { ok: true, url };
}

/** Press a keyboard shortcut or key on the virtual display (xdotool) */
export async function pressKey(key) {
  try {
    execSync(`DISPLAY=${DISPLAY_NUM} xdotool key ${key}`, { stdio: "ignore" });
    await sleep(400);
    return { ok: true, key };
  } catch (e) { return { error: e.message }; }
}

/** Type text using xdotool on the virtual display */
export async function typeText(text) {
  try {
    execSync(`DISPLAY=${DISPLAY_NUM} xdotool type --clearmodifiers -- "${text.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
    await sleep(400);
    return { ok: true, text };
  } catch (e) { return { error: e.message }; }
}

/** Click at x,y on the virtual display */
export async function clickAt(x, y) {
  try {
    execSync(`DISPLAY=${DISPLAY_NUM} xdotool mousemove ${x} ${y} click 1`, { stdio: "ignore" });
    await sleep(500);
    return { ok: true, x, y };
  } catch (e) { return { error: e.message }; }
}

/** Zoom in/out using Ctrl+/Ctrl- in the browser */
export async function zoomBrowser(direction = "in", steps = 2) {
  const key = direction === "in" ? "ctrl+plus" : "ctrl+minus";
  for (let i = 0; i < steps; i++) {
    await pressKey(key);
    await sleep(200);
  }
  return { ok: true, direction, steps };
}

/** Reset browser zoom to 100% */
export async function resetZoom() {
  await pressKey("ctrl+0");
  await sleep(200);
  return { ok: true };
}

/** Scroll page up/down using keyboard */
export async function scrollPage(direction = "down", steps = 3) {
  const key = direction === "down" ? "Page_Down" : "Page_Up";
  for (let i = 0; i < steps; i++) {
    await pressKey(key);
    await sleep(150);
  }
  return { ok: true, direction, steps };
}

/** Search for text using Ctrl+F in browser */
export async function findInPage(query) {
  await pressKey("ctrl+f");
  await sleep(500);
  await typeText(query);
  await sleep(300);
  return { ok: true, query };
}

async function _cleanup() {
  // Abort stream
  if (_streamAbortController) {
    _streamAbortController.abort();
    _streamAbortController = null;
  }
  // Leave voice
  if (_streamer) {
    try { _streamer.leaveVoice(); } catch { /* ignore */ }
    _streamer = null;
  }
  // Kill Chrome
  if (_chromeProc) {
    try { _chromeProc.kill("SIGTERM"); } catch { /* ignore */ }
    _chromeProc = null;
  }
  // Kill Xvfb
  if (_xvfbProc) {
    try { _xvfbProc.kill("SIGTERM"); } catch { /* ignore */ }
    _xvfbProc = null;
  }
  // Kill any leftover processes
  try { execSync("pkill -f 'Xvfb :99' || true", { stdio: "ignore" }); } catch { /* ignore */ }
  try { execSync("pkill -f 'google-chrome.*:99' || true", { stdio: "ignore" }); } catch { /* ignore */ }

  // Update status message
  if (_notifyMessage) {
    try {
      await _notifyMessage.edit({
        embeds: [new EmbedBuilder().setDescription("⏹️ **Screen Share หยุดแล้ว**").setColor(0x747f8d).setTimestamp()],
      });
    } catch { /* ignore */ }
    _notifyMessage = null;
  }
  _notifyChannel = null;
  _currentUrl = "";
  _startedAt = null;
  _guildId = null;
  _channelId = null;
}

/** Stop the Go Live stream */
export async function stopScreenShare() {
  await _cleanup();
  return { ok: true };
}
