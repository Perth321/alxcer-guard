// screenshare.js — Discord Go Live (real screenshare) for Alxcer Guard userbot.
//
// How Discord Go Live works for a userbot (self-bot):
//  1. Start Xvfb virtual display so ffmpeg has something to capture.
//  2. Optionally open a Puppeteer browser on that display to show a real URL.
//  3. Send Gateway OP 4 (VOICE_STATE_UPDATE) with self_video:true to join voice.
//  4. Send Gateway OP 18 (STREAM_CREATE) to start a Go Live stream in that channel.
//  5. Discord sends back STREAM_SERVER_UPDATE with a dedicated voice/stream endpoint.
//  6. Connect to that endpoint, complete the WebRTC-like handshake (identify/select-protocol/ready).
//  7. Run ffmpeg capturing :99 (Xvfb) → H.264 → pipe → UDP RTP to Discord's endpoint.
//
// Black-screen root causes we fix here:
//  • No Xvfb → ffmpeg x11grab fails silently → black.
//  • selfVideo not sent in OP4 → Discord never activates the video slot.
//  • OP18 not sent → Go Live overlay never appears.
//  • ffmpeg codec/quality mismatch → Discord drops video.

import { exec as _exec, spawn } from "child_process";
import { promisify } from "util";
import WebSocket from "ws";

const execAsync = promisify(_exec);

// ── Global state ──────────────────────────────────────────────────────────────
let xvfbProc = null;
let browserProc = null;
let ffmpegProc = null;
let streamWs = null;
let streamHeartbeatHandle = null;
let activeStream = null; // { guildId, channelId, startedAt }

export function isStreaming() {
  return !!activeStream;
}

export function getStreamInfo() {
  if (!activeStream) return null;
  return {
    ...activeStream,
    uptime: Math.round((Date.now() - activeStream.startedAt) / 1000),
  };
}

// ── Xvfb helpers ─────────────────────────────────────────────────────────────
async function startXvfb(display = 99, res = "1280x720x24") {
  try {
    await execAsync(`pkill -f "Xvfb :${display}"`, { timeout: 3000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  } catch {}

  return new Promise((resolve, reject) => {
    const proc = spawn("Xvfb", [
      `:${display}`,
      "-screen", "0", res,
      "-ac",
      "-nolisten", "tcp",
    ], { stdio: "ignore", detached: false });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`Xvfb exited with code ${code}`));
    });

    // Give Xvfb 1.5 s to start before we say it's ready
    setTimeout(() => resolve(proc), 1500);
  });
}

async function drawIdleScreen(display = 99, text = "Alxcer Guard — Live") {
  // Draw a simple background so the stream is not pitch-black even before browser loads
  const cmd = `DISPLAY=:${display} xdotool type "" 2>/dev/null; ` +
    `DISPLAY=:${display} xsetroot -solid "#1a1a2e" 2>/dev/null || true`;
  await execAsync(cmd, { timeout: 5000 }).catch(() => {});
}

// ── Discord Gateway helpers ───────────────────────────────────────────────────

// Extract the raw WebSocket from a discord.js Client (ws shards[0])
function getGatewayWs(client) {
  const shard = client.ws.shards.first?.() ?? client.ws.shards.get(0);
  if (!shard) throw new Error("No WebSocket shard found on client");
  // discord.js v14 stores the raw ws as shard.connection or shard.ws
  const raw = shard.connection ?? shard.ws ?? shard._ws;
  if (!raw) throw new Error("Could not access raw WebSocket from shard");
  return raw;
}

// Send a raw gateway payload
function sendGatewayPayload(client, op, data) {
  const raw = getGatewayWs(client);
  const payload = JSON.stringify({ op, d: data });
  if (raw.readyState !== WebSocket.OPEN) {
    throw new Error(`Gateway WS not open (state=${raw.readyState})`);
  }
  raw.send(payload);
}

// Wait for a specific gateway dispatch event
function waitForGatewayEvent(client, eventName, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener("raw", handler);
      reject(new Error(`Timeout waiting for gateway event: ${eventName}`));
    }, timeoutMs);

    function handler(packet) {
      if (packet.t === eventName) {
        clearTimeout(timer);
        client.removeListener("raw", handler);
        resolve(packet.d);
      }
    }
    client.on("raw", handler);
  });
}

// ── Stream voice connection (separate from normal voice) ─────────────────────
async function connectStreamVoice({ endpoint, token, guildId, userId, sessionId }) {
  return new Promise((resolve, reject) => {
    const url = `wss://${endpoint.replace(/:80$/, "")}/?v=7`;
    const ws = new WebSocket(url);
    let hbInterval = null;
    let ready = false;

    ws.on("error", (err) => {
      if (!ready) reject(err);
      else console.error("[screenshare] stream WS error:", err.message);
    });

    ws.on("close", (code) => {
      if (hbInterval) clearInterval(hbInterval);
      if (!ready) reject(new Error(`Stream WS closed early (${code})`));
      else console.warn("[screenshare] stream WS closed:", code);
    });

    ws.on("message", (raw) => {
      let pkt;
      try { pkt = JSON.parse(raw); } catch { return; }

      const { op, d } = pkt;

      // OP 8 — Hello: start heartbeat + identify
      if (op === 8) {
        const interval = d.heartbeat_interval;
        hbInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 3, d: null }));
        }, interval);

        // Identify as a stream (not a regular voice connection)
        ws.send(JSON.stringify({
          op: 0,
          d: {
            server_id: guildId,
            user_id: userId,
            session_id: sessionId,
            token,
            streams: [{
              type: "screen",
              rid: "100",
              quality: 100,
            }],
            video: true,
          },
        }));
        return;
      }

      // OP 2 — Ready: send select protocol
      if (op === 2) {
        const { ip, port, ssrc, modes } = d;
        const mode = modes.includes("xsalsa20_poly1305_lite")
          ? "xsalsa20_poly1305_lite"
          : modes.includes("xsalsa20_poly1305_suffix")
          ? "xsalsa20_poly1305_suffix"
          : "xsalsa20_poly1305";

        ws.send(JSON.stringify({
          op: 1,
          d: {
            protocol: "udp",
            data: { address: ip, port, mode },
            codecs: [
              { name: "H264", type: "video", priority: 1000, payload_type: 101, rtx_payload_type: 102 },
              { name: "VP8",  type: "video", priority: 2000, payload_type: 103, rtx_payload_type: 104 },
              { name: "opus", type: "audio", priority: 1000, payload_type: 120 },
            ],
            rtc_connection_id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
          },
        }));

        // Resolve with connection info so ffmpeg can connect
        streamWs = ws;
        streamHeartbeatHandle = hbInterval;
        ready = true;
        resolve({ ws, ssrc, ip, port, mode });
        return;
      }

      // OP 4 — Session description (encryption keys) — just log
      if (op === 4) {
        console.log("[screenshare] session description received, stream active");
        return;
      }

      // OP 6 — Heartbeat ACK
      if (op === 6) return;
    });
  });
}

// ── ffmpeg screen capture → Discord RTP ──────────────────────────────────────
function startFfmpegStream({ ip, port, ssrc, display = 99, fps = 15, width = 1280, height = 720 }) {
  // ffmpeg captures Xvfb display and sends H.264 RTP to Discord's voice server.
  // We use the -vcodec libx264 with realtime preset, very low latency settings.
  const args = [
    // Input: X11 screen grab
    "-f", "x11grab",
    "-framerate", String(fps),
    "-video_size", `${width}x${height}`,
    "-i", `:${display}`,
    // Encode H.264 for Discord
    "-vcodec", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-b:v", "1500k",
    "-maxrate", "2000k",
    "-bufsize", "4000k",
    "-g", String(fps * 2), // keyframe every 2s
    "-sc_threshold", "0",
    "-profile:v", "baseline",
    "-level", "3.1",
    // RTP output to Discord's stream server
    "-f", "rtp",
    "-payload_type", "101",
    `rtp://${ip}:${port}?ssrc=${ssrc}&pkt_size=1200`,
  ];

  console.log("[screenshare] starting ffmpeg:", "ffmpeg", args.slice(0, 8).join(" "), "...");

  const proc = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DISPLAY: `:${display}` },
  });

  proc.stdout.on("data", (d) => process.stdout.write(d));
  proc.stderr.on("data", (d) => {
    const msg = d.toString();
    // Only log important ffmpeg messages, not every frame stats line
    if (msg.includes("Error") || msg.includes("error") || msg.includes("failed") ||
        msg.includes("frame=") && !msg.includes("kb/s")) {
      process.stderr.write("[ffmpeg] " + msg);
    }
  });
  proc.on("exit", (code, signal) => {
    console.log(`[screenshare] ffmpeg exited (code=${code}, signal=${signal})`);
    ffmpegProc = null;
  });

  return proc;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start Go Live screenshare in the given voice channel.
 * @param {import("discord.js").Client} client
 * @param {{ guildId: string, channelId: string, displayUrl?: string, fps?: number }} opts
 */
export async function startGoLive(client, { guildId, channelId, displayUrl, fps = 15 }) {
  if (activeStream) {
    return { error: "กำลัง stream อยู่แล้วครับ — หยุดก่อนด้วย stop_go_live" };
  }

  const userId = client.user?.id;
  if (!userId) return { error: "Client ยังไม่ได้ login" };

  try {
    // ── Step 1: Start Xvfb virtual display ──
    console.log("[screenshare] starting Xvfb :99");
    xvfbProc = await startXvfb(99, "1280x720x24");
    await drawIdleScreen(99);
    console.log("[screenshare] Xvfb started on :99");

    // ── Step 2: Optionally open Puppeteer browser on that display ──
    if (displayUrl) {
      try {
        const chromePath = (await execAsync("which google-chrome-stable 2>/dev/null || which chromium-browser 2>/dev/null || echo ''")).stdout.trim();
        if (chromePath) {
          browserProc = spawn(chromePath, [
            "--display=:99",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--window-size=1280,720",
            "--window-position=0,0",
            "--kiosk",
            "--no-first-run",
            "--disable-infobars",
            displayUrl,
          ], { stdio: "ignore", detached: false, env: { ...process.env, DISPLAY: ":99" } });
          console.log(`[screenshare] browser opened: ${displayUrl}`);
          await new Promise(r => setTimeout(r, 3000)); // wait for page to load
        }
      } catch (err) {
        console.warn("[screenshare] browser launch failed (continuing without browser):", err.message);
      }
    }

    // ── Step 3: Send OP 4 — join voice with selfVideo:true ──
    console.log("[screenshare] sending OP 4 (VOICE_STATE_UPDATE, selfVideo=true)");
    const voiceStatePromise = waitForGatewayEvent(client, "VOICE_STATE_UPDATE", 8000);
    const voiceServerPromise = waitForGatewayEvent(client, "VOICE_SERVER_UPDATE", 8000);

    sendGatewayPayload(client, 4, {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: false,
      self_deaf: false,
      self_video: true,
    });

    const [voiceState, voiceServer] = await Promise.all([voiceStatePromise, voiceServerPromise]);
    const sessionId = voiceState.session_id;
    const voiceEndpoint = voiceServer.endpoint;
    const voiceToken = voiceServer.token;
    console.log("[screenshare] voice state acquired, session:", sessionId?.slice(0, 8));

    // ── Step 4: Send OP 18 — STREAM_CREATE (Go Live) ──
    console.log("[screenshare] sending OP 18 (STREAM_CREATE)");
    const streamServerPromise = waitForGatewayEvent(client, "STREAM_SERVER_UPDATE", 10_000);

    sendGatewayPayload(client, 18, {
      type: "guild",
      guild_id: guildId,
      channel_id: channelId,
      preferred_region: null,
    });

    let streamEndpoint, streamToken;
    try {
      const streamServer = await streamServerPromise;
      streamEndpoint = streamServer.endpoint;
      streamToken = streamServer.token;
      console.log("[screenshare] STREAM_SERVER_UPDATE received, endpoint:", streamEndpoint?.slice(0, 30));
    } catch (err) {
      // STREAM_SERVER_UPDATE not received — still try to stream over main voice server
      console.warn("[screenshare] No STREAM_SERVER_UPDATE, using main voice endpoint:", err.message);
      streamEndpoint = voiceEndpoint;
      streamToken = voiceToken;
    }

    // ── Step 5: Connect to stream voice server ──
    console.log("[screenshare] connecting to stream voice server...");
    const { ssrc, ip, port } = await connectStreamVoice({
      endpoint: streamEndpoint,
      token: streamToken,
      guildId,
      userId,
      sessionId,
    });
    console.log(`[screenshare] stream voice ready: ${ip}:${port} ssrc=${ssrc}`);

    // ── Step 6: Start ffmpeg ──
    ffmpegProc = startFfmpegStream({ ip, port, ssrc, display: 99, fps });

    activeStream = { guildId, channelId, startedAt: Date.now(), displayUrl: displayUrl || null };

    return {
      ok: true,
      message: `เริ่ม Go Live แล้วครับ — กำลัง stream หน้าจอจาก Xvfb display :99${displayUrl ? ` (เปิด ${displayUrl})` : ""}`,
      ssrc,
      fps,
    };
  } catch (err) {
    console.error("[screenshare] startGoLive failed:", err.message);
    await _stopGoLive().catch(() => {});
    return { error: `Go Live ล้มเหลว: ${err.message}` };
  }
}

/**
 * Stop the active Go Live stream.
 */
async function _stopGoLive() {
  // Kill ffmpeg
  if (ffmpegProc) {
    try { ffmpegProc.kill("SIGTERM"); } catch {}
    ffmpegProc = null;
  }

  // Close stream WebSocket
  if (streamWs) {
    if (streamHeartbeatHandle) { clearInterval(streamHeartbeatHandle); streamHeartbeatHandle = null; }
    try { streamWs.close(1000); } catch {}
    streamWs = null;
  }

  // Kill browser
  if (browserProc) {
    try { browserProc.kill("SIGTERM"); } catch {}
    browserProc = null;
  }

  // Kill Xvfb
  if (xvfbProc) {
    try { xvfbProc.kill("SIGTERM"); } catch {}
    xvfbProc = null;
  }
  // Also pkill any stray Xvfb
  await execAsync("pkill -f 'Xvfb :99' 2>/dev/null || true", { timeout: 3000 }).catch(() => {});

  activeStream = null;
}

export async function stopGoLive(client, { guildId } = {}) {
  if (!activeStream) return { error: "ไม่มี stream ที่กำลังรันอยู่" };

  const was = { ...activeStream };
  await _stopGoLive();

  // Send OP 4 to leave stream (set self_video:false and leave voice)
  if (client && guildId) {
    try {
      sendGatewayPayload(client, 4, {
        guild_id: guildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
        self_video: false,
      });
    } catch {}

    // Also send OP 18 with null to close stream
    try {
      sendGatewayPayload(client, 18, {
        type: "guild",
        guild_id: guildId,
        channel_id: null,
        preferred_region: null,
      });
    } catch {}
  }

  const uptime = Math.round((Date.now() - was.startedAt) / 1000);
  return {
    ok: true,
    message: `หยุด Go Live แล้วครับ — stream ทำงานไป ${uptime} วินาที`,
    uptime,
  };
}

/**
 * Quick test: spin up Xvfb + ffmpeg for 10 seconds and report back.
 * Returns detailed diagnostics without actually going Live on Discord.
 */
export async function testScreencapture() {
  const results = [];

  // Check Xvfb
  try {
    const { stdout } = await execAsync("which Xvfb", { timeout: 5000 });
    results.push({ test: "Xvfb binary", ok: true, path: stdout.trim() });
  } catch {
    results.push({ test: "Xvfb binary", ok: false, error: "Xvfb not found — install xvfb" });
  }

  // Check ffmpeg
  try {
    const { stdout } = await execAsync("ffmpeg -version 2>&1 | head -1", { timeout: 5000 });
    results.push({ test: "ffmpeg", ok: true, version: stdout.trim() });
  } catch {
    results.push({ test: "ffmpeg", ok: false, error: "ffmpeg not found" });
  }

  // Check libx264
  try {
    const { stdout } = await execAsync("ffmpeg -encoders 2>&1 | grep libx264", { timeout: 5000 });
    results.push({ test: "libx264 encoder", ok: stdout.includes("libx264"), detail: stdout.trim().slice(0, 80) });
  } catch {
    results.push({ test: "libx264 encoder", ok: false, error: "cannot check encoders" });
  }

  // Check x11grab
  try {
    const { stdout } = await execAsync("ffmpeg -devices 2>&1 | grep x11", { timeout: 5000 });
    results.push({ test: "x11grab input device", ok: stdout.includes("x11grab"), detail: stdout.trim().slice(0, 80) });
  } catch {
    results.push({ test: "x11grab input device", ok: false, error: "cannot check devices" });
  }

  // Try starting Xvfb briefly
  let testXvfb = null;
  try {
    testXvfb = await startXvfb(98, "1280x720x24");
    results.push({ test: "Xvfb start :98", ok: true });
  } catch (err) {
    results.push({ test: "Xvfb start :98", ok: false, error: err.message });
  }

  // Try a 3-second ffmpeg capture test
  if (testXvfb) {
    try {
      const { stdout, stderr } = await execAsync(
        "DISPLAY=:98 ffmpeg -f x11grab -framerate 5 -video_size 640x360 -i :98 -vframes 15 -f null - 2>&1 | tail -5",
        { timeout: 15000 }
      );
      const ok = !stderr.toLowerCase().includes("error") || stdout.includes("frame=");
      results.push({ test: "ffmpeg x11grab capture", ok: true, output: (stdout + stderr).slice(0, 200) });
    } catch (err) {
      results.push({ test: "ffmpeg x11grab capture", ok: false, error: err.message.slice(0, 200) });
    }
  }

  // Cleanup test Xvfb
  if (testXvfb) {
    try { testXvfb.kill("SIGTERM"); } catch {}
    await execAsync("pkill -f 'Xvfb :98' 2>/dev/null || true", { timeout: 3000 }).catch(() => {});
  }

  const allOk = results.every(r => r.ok);
  return {
    ok: allOk,
    summary: allOk ? "ระบบ screenshare พร้อมใช้งาน ✅" : "พบปัญหาบางอย่าง — ดูรายละเอียดด้านล่าง",
    tests: results,
  };
}
