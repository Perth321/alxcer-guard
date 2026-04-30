// Vision module for Alxcer Guard.
//
// Capabilities:
// 1) Object detection on images using YOLOv5n (ONNX) via onnxruntime-node.
// 2) Drawing labelled bounding boxes on top of the original image (sharp + SVG).
// 3) Frame extraction from short videos via ffmpeg, then YOLO on each sample.
// 4) Helpers to summarise detections in Thai for the chat reply.
//
// The vision-LLM "what does the AI see" description is handled by ai.js
// (generateVisionReply). This module is purely the deterministic CV layer.

import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

let ort = null;
let sharp = null;
let opentype = null;
let _session = null;
let _sessionLoading = null;
let _font = null;
let _fontLoading = null;

const MODEL_DIR = path.resolve(process.cwd(), ".cache", "models");
const MODEL_PATH = path.join(MODEL_DIR, "yolov5n.onnx");
const MODEL_URL =
  process.env.YOLO_MODEL_URL ||
  // v6.0 release ships the FP32 export (~7.5 MB). The v7.0 build is FP16,
  // which onnxruntime-node 1.25's native binding refuses to accept (it
  // rejects both Uint16Array and Float16Array buffers). Stick with FP32.
  "https://github.com/ultralytics/yolov5/releases/download/v6.0/yolov5n.onnx";

const FONT_DIR = path.resolve(process.cwd(), ".cache", "fonts");
const FONT_PATH = path.join(FONT_DIR, "Sarabun-Bold.ttf");
const FONT_URL =
  process.env.SARABUN_FONT_URL ||
  "https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Bold.ttf";

const INPUT_SIZE = 640;
const SCORE_THRESHOLD = Number(process.env.YOLO_SCORE_THRESHOLD || 0.3);
const IOU_THRESHOLD = 0.45;
const MAX_DETECTIONS = 50;

// COCO 80 classes — order matches yolov5n.onnx export.
const COCO_CLASSES = [
  "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light",
  "fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow",
  "elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee",
  "skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle",
  "wine glass","cup","fork","knife","spoon","bowl","banana","apple","sandwich","orange",
  "broccoli","carrot","hot dog","pizza","donut","cake","chair","couch","potted plant","bed",
  "dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone","microwave","oven",
  "toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear","hair drier","toothbrush",
];

const TH_LABELS = {
  person: "คน", bicycle: "จักรยาน", car: "รถยนต์", motorcycle: "มอเตอร์ไซค์", bus: "รถบัส",
  train: "รถไฟ", truck: "รถบรรทุก", boat: "เรือ", "traffic light": "ไฟจราจร", bird: "นก",
  cat: "แมว", dog: "หมา", horse: "ม้า", sheep: "แกะ", cow: "วัว",
  bear: "หมี", elephant: "ช้าง", zebra: "ม้าลาย", giraffe: "ยีราฟ", backpack: "กระเป๋าเป้",
  umbrella: "ร่ม", handbag: "กระเป๋า", tie: "เนคไท", suitcase: "กระเป๋าเดินทาง",
  "sports ball": "ลูกบอล", skateboard: "สเก็ตบอร์ด", "tennis racket": "ไม้เทนนิส",
  bottle: "ขวด", "wine glass": "แก้วไวน์", cup: "แก้ว", fork: "ส้อม", knife: "มีด",
  spoon: "ช้อน", bowl: "ชาม", banana: "กล้วย", apple: "แอปเปิ้ล", sandwich: "แซนด์วิช",
  orange: "ส้ม", pizza: "พิซซ่า", donut: "โดนัท", cake: "เค้ก",
  chair: "เก้าอี้", couch: "โซฟา", "potted plant": "กระถางต้นไม้", bed: "เตียง",
  "dining table": "โต๊ะอาหาร", toilet: "ชักโครก", tv: "ทีวี", laptop: "แล็ปท็อป",
  mouse: "เมาส์", remote: "รีโมท", keyboard: "คีย์บอร์ด", "cell phone": "มือถือ",
  microwave: "ไมโครเวฟ", oven: "เตาอบ", toaster: "เครื่องปิ้งขนมปัง", sink: "อ่างล้าง",
  refrigerator: "ตู้เย็น", book: "หนังสือ", clock: "นาฬิกา", vase: "แจกัน",
  scissors: "กรรไกร", "teddy bear": "ตุ๊กตาหมี", "hair drier": "ไดร์เป่าผม", toothbrush: "แปรงสีฟัน",
};

export function thaiLabel(name) {
  return TH_LABELS[name] || name;
}

export function visionAvailable() {
  // Best-effort availability flag — actual readiness depends on model download.
  return true;
}

// Lazy-load native deps so a missing native binary never crashes the bot at boot.
async function ensureDeps() {
  if (!ort) {
    try {
      ort = await import("onnxruntime-node");
    } catch (err) {
      throw new Error(`onnxruntime-node not installed: ${err.message}`);
    }
  }
  if (!sharp) {
    try {
      sharp = (await import("sharp")).default;
    } catch (err) {
      throw new Error(`sharp not installed: ${err.message}`);
    }
  }
  if (!opentype) {
    try {
      opentype = (await import("opentype.js")).default;
    } catch (err) {
      throw new Error(`opentype.js not installed: ${err.message}`);
    }
  }
}

async function ensureFont() {
  if (existsSync(FONT_PATH)) return FONT_PATH;
  if (!existsSync(FONT_DIR)) mkdirSync(FONT_DIR, { recursive: true });
  console.log(`[vision] downloading Thai font from ${FONT_URL}`);
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`Sarabun font download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(FONT_PATH, buf);
  console.log(`[vision] saved Sarabun font (${buf.length} bytes) → ${FONT_PATH}`);
  return FONT_PATH;
}

// Get a parsed opentype font (with proper Thai glyphs) — cached after first call.
async function getFont() {
  if (_font) return _font;
  if (_fontLoading) return _fontLoading;
  _fontLoading = (async () => {
    await ensureDeps();
    const fp = await ensureFont();
    const buf = await fs.readFile(fp);
    const arrBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    _font = opentype.parse(arrBuf);
    return _font;
  })();
  try {
    return await _fontLoading;
  } finally {
    _fontLoading = null;
  }
}

// ---------------------------------------------------------------------------
// Intent extraction — decide whether the user wants object DETECTION or
// just a casual CHAT about the image.
// ---------------------------------------------------------------------------
//
// DETECT keywords (Thai + EN) — anything that asks "what's in the image" /
// "scan it" / "find objects" triggers YOLO + bounding boxes.
//
// CHAT (default) — when the user just wants the bot to look at the image
// and chat about it, no boxes drawn, no YOLO inference (much faster + nicer).
const DETECT_KEYWORDS_TH = [
  "ตรวจ", "ตรวจจับ", "ตรวจสอบ", "วิเคราะห์", "สแกน",
  "หาวัตถุ", "หาของ", "วัตถุ", "ของในรูป", "ของในภาพ",
  "อะไรในรูป", "อะไรในภาพ", "มีอะไรในรูป", "มีอะไรในภาพ", "มีอะไรบ้าง",
  "นับ", "นับคน", "วาดกรอบ", "วาด box", "วาดบ็อกซ์", "บ็อกซ์",
];
const DETECT_KEYWORDS_EN = [
  "detect", "scan", "yolo", "bounding box", "bbox", "box it", "label",
  "identify", "what.?s in", "what is in", "objects?", "count",
];

export function extractVisionIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return "chat";
  for (const k of DETECT_KEYWORDS_TH) if (t.includes(k)) return "detect";
  for (const k of DETECT_KEYWORDS_EN) {
    const re = new RegExp(`\\b${k}\\b`, "i");
    if (re.test(t)) return "detect";
  }
  return "chat";
}

async function ensureModel() {
  if (existsSync(MODEL_PATH)) return MODEL_PATH;
  if (!existsSync(MODEL_DIR)) mkdirSync(MODEL_DIR, { recursive: true });
  console.log(`[vision] downloading YOLO model from ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`YOLO model download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(MODEL_PATH, buf);
  console.log(`[vision] saved YOLO model (${buf.length} bytes) → ${MODEL_PATH}`);
  return MODEL_PATH;
}

async function getSession() {
  if (_session) return _session;
  if (_sessionLoading) return _sessionLoading;
  _sessionLoading = (async () => {
    await ensureDeps();
    const modelPath = await ensureModel();
    _session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return _session;
  })();
  try {
    return await _sessionLoading;
  } finally {
    _sessionLoading = null;
  }
}

// Letterbox-resize an image buffer to INPUT_SIZE × INPUT_SIZE, returning the
// padded RGB pixels (Float32 NCHW [1,3,H,W]) plus the scaling info needed to
// project boxes back to the original image coordinates.
async function preprocess(imageBuffer) {
  await ensureDeps();
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error("image has no dimensions");

  const scale = Math.min(INPUT_SIZE / W, INPUT_SIZE / H);
  const resizedW = Math.round(W * scale);
  const resizedH = Math.round(H * scale);
  const padX = Math.floor((INPUT_SIZE - resizedW) / 2);
  const padY = Math.floor((INPUT_SIZE - resizedH) / 2);

  const padded = await sharp(imageBuffer)
    .resize(resizedW, resizedH, { fit: "fill" })
    .extend({
      top: padY,
      bottom: INPUT_SIZE - resizedH - padY,
      left: padX,
      right: INPUT_SIZE - resizedW - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  // padded is HWC uint8 → convert to CHW float32 in [0,1].
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  const arr = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    arr[i] = padded[i * 3] / 255;                      // R
    arr[i + planeSize] = padded[i * 3 + 1] / 255;      // G
    arr[i + planeSize * 2] = padded[i * 3 + 2] / 255;  // B
  }
  return { tensor: arr, origW: W, origH: H, scale, padX, padY };
}

// Postprocess YOLOv5 ONNX output [1, N, 85]: cx, cy, w, h, obj, c0..c79.
// Returns detections in original image pixel coordinates.
function postprocess(output, dims, info) {
  const [, N, stride] = dims; // expected [1, N, 85]
  if (stride !== 85) {
    console.warn(`[vision] unexpected output stride ${stride}, attempting anyway`);
  }
  const numClasses = stride - 5;
  const raw = [];
  for (let i = 0; i < N; i++) {
    const base = i * stride;
    const obj = output[base + 4];
    if (obj < SCORE_THRESHOLD) continue;
    let bestC = 0;
    let bestS = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = output[base + 5 + c];
      if (s > bestS) { bestS = s; bestC = c; }
    }
    const score = obj * bestS;
    if (score < SCORE_THRESHOLD) continue;
    const cx = output[base];
    const cy = output[base + 1];
    const w = output[base + 2];
    const h = output[base + 3];
    // Project back to original image coords.
    const x1 = (cx - w / 2 - info.padX) / info.scale;
    const y1 = (cy - h / 2 - info.padY) / info.scale;
    const x2 = (cx + w / 2 - info.padX) / info.scale;
    const y2 = (cy + h / 2 - info.padY) / info.scale;
    raw.push({
      class: COCO_CLASSES[bestC] || `class_${bestC}`,
      classIndex: bestC,
      score,
      box: [
        Math.max(0, Math.min(info.origW - 1, x1)),
        Math.max(0, Math.min(info.origH - 1, y1)),
        Math.max(0, Math.min(info.origW - 1, x2)),
        Math.max(0, Math.min(info.origH - 1, y2)),
      ],
    });
  }
  // Sort by score desc, then NMS.
  raw.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const det of raw) {
    let overlap = false;
    for (const k of keep) {
      if (k.classIndex !== det.classIndex) continue;
      if (iou(det.box, k.box) > IOU_THRESHOLD) { overlap = true; break; }
    }
    if (!overlap) keep.push(det);
    if (keep.length >= MAX_DETECTIONS) break;
  }
  return keep;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = (a[2] - a[0]) * (a[3] - a[1]);
  const bArea = (b[2] - b[0]) * (b[3] - b[1]);
  const union = aArea + bArea - inter;
  return union <= 0 ? 0 : inter / union;
}

// Convert a Float32Array → Uint16Array of IEEE-754 half-precision values
// (so the data can be passed as a float16 ONNX tensor). Some YOLOv5 ONNX
// builds (the ultralytics v7.0 release in particular) expect float16 input.
function float32ArrayToFloat16(src) {
  const out = new Uint16Array(src.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    let exp = ((x >>> 23) & 0xff) - 127 + 15;
    const mant = x & 0x7fffff;
    let half;
    if (exp >= 31) {
      // Inf or NaN
      half = sign | 0x7c00 | (mant ? 0x200 : 0);
    } else if (exp <= 0) {
      if (exp < -10) {
        half = sign;
      } else {
        const m = (mant | 0x800000) >> (1 - exp);
        half = sign | (m >> 13);
      }
    } else {
      half = sign | (exp << 10) | (mant >> 13);
    }
    out[i] = half;
  }
  return out;
}

// Convert a Uint16Array of float16 values back to a Float32Array.
function float16ArrayToFloat32(src) {
  const out = new Float32Array(src.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < src.length; i++) {
    const h = src[i];
    const sign = (h & 0x8000) << 16;
    const exp = (h & 0x7c00) >> 10;
    const mant = h & 0x03ff;
    let bits;
    if (exp === 0) {
      if (mant === 0) {
        bits = sign;
      } else {
        // subnormal
        let e = -1;
        let m = mant;
        do { e++; m <<= 1; } while ((m & 0x0400) === 0);
        bits = sign | ((127 - 15 - e) << 23) | ((m & 0x03ff) << 13);
      }
    } else if (exp === 31) {
      bits = sign | 0x7f800000 | (mant << 13);
    } else {
      bits = sign | ((exp + (127 - 15)) << 23) | (mant << 13);
    }
    u32[0] = bits;
    out[i] = f32[0];
  }
  return out;
}

// Run object detection on an image buffer.
// Returns { detections, width, height }.
export async function detectObjects(imageBuffer) {
  const session = await getSession();
  const pre = await preprocess(imageBuffer);
  const inputName = session.inputNames[0];
  const inputMeta = session.inputMetadata?.[0] || session.inputMetadata?.[inputName];
  const inputType = inputMeta?.type || "float32";

  let inputTensor;
  if (inputType === "float16") {
    const half = float32ArrayToFloat16(pre.tensor);
    // Prefer native Float16Array (Node 24+); fall back to Uint16Array view
    // for older runtimes that onnxruntime-node still accepts.
    const data = (typeof globalThis.Float16Array !== "undefined")
      ? new globalThis.Float16Array(half.buffer, half.byteOffset, half.length)
      : half;
    inputTensor = new ort.Tensor("float16", data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  } else {
    inputTensor = new ort.Tensor("float32", pre.tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  }

  const out = await session.run({ [inputName]: inputTensor });
  const outName = session.outputNames[0];
  const outTensor = out[outName];
  let outData = outTensor.data;
  if (outTensor.type === "float16") {
    outData = float16ArrayToFloat32(outData);
  }
  const detections = postprocess(outData, outTensor.dims, pre);
  return { detections, width: pre.origW, height: pre.origH };
}

// Render bounding boxes onto an image and return a JPEG buffer.
// Thai-aware labels are vectorised with opentype.js → SVG <path>, so the
// final composite never depends on librsvg's font-handling capabilities.
export async function drawBoxes(imageBuffer, detections, width, height) {
  await ensureDeps();
  if (!detections.length) return imageBuffer;

  const font = await getFont();

  const colors = [
    "#FF3B30","#FF9500","#FFCC00","#34C759","#00C7BE","#30B0C7",
    "#007AFF","#5856D6","#AF52DE","#FF2D55","#A2845E","#8E8E93",
  ];
  const fontSize = Math.max(16, Math.round(Math.min(width, height) / 36));
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 300));
  const padX = Math.round(fontSize * 0.35);
  const padY = Math.round(fontSize * 0.25);

  const parts = detections.map((d) => {
    const [x1, y1, x2, y2] = d.box;
    const w = x2 - x1;
    const h = y2 - y1;
    const color = colors[d.classIndex % colors.length];
    const label = `${thaiLabel(d.class)} ${(d.score * 100).toFixed(0)}%`;

    // Measure the label using the actual font metrics so the background
    // pill always matches the glyph width — no more "text overflows pill".
    const advance = font.getAdvanceWidth(label, fontSize);
    const labelW = Math.ceil(advance) + padX * 2;
    const labelH = fontSize + padY * 2;

    // Place the label pill above the box; flip below if it would clip the top.
    let tagY = y1 - labelH;
    if (tagY < 0) tagY = Math.min(height - labelH, y1 + 2);
    const tagX = Math.max(0, Math.min(width - labelW, x1));

    // Vectorise the text. Baseline ≈ tagY + padY + fontSize * 0.85.
    const baseline = tagY + padY + Math.round(fontSize * 0.82);
    const textPath = font.getPath(label, tagX + padX, baseline, fontSize);
    textPath.fill = "white";
    textPath.stroke = null;
    const textSvg = textPath.toSVG();

    return `
      <rect x="${x1}" y="${y1}" width="${w}" height="${h}"
        fill="none" stroke="${color}" stroke-width="${stroke}"/>
      <rect x="${tagX}" y="${tagY}" width="${labelW}" height="${labelH}"
        fill="${color}" rx="${Math.round(padY)}"/>
      ${textSvg}
    `;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
  return await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]),
  );
}

// Extract up to `count` evenly-spaced frames from a video buffer using ffmpeg.
// Returns an array of { time, buffer } items.
export async function extractVideoFrames(videoBuffer, count = 3) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alxguard-vid-"));
  const inputPath = path.join(tmpDir, "input.bin");
  await fs.writeFile(inputPath, videoBuffer);
  try {
    const duration = await probeDuration(inputPath);
    const times =
      duration && duration > 1
        ? Array.from({ length: count }, (_, i) =>
            Math.max(0.1, ((i + 0.5) / count) * duration),
          )
        : [0.1];
    const frames = [];
    for (const t of times) {
      const framePath = path.join(tmpDir, `f_${Math.round(t * 1000)}.jpg`);
      await runFfmpeg([
        "-ss", String(t.toFixed(2)),
        "-i", inputPath,
        "-frames:v", "1",
        "-q:v", "3",
        "-y", framePath,
      ]);
      try {
        const buf = await fs.readFile(framePath);
        frames.push({ time: t, buffer: buf });
      } catch (err) {
        console.warn(`[vision] frame extract failed at ${t}s:`, err.message);
      }
    }
    return frames;
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
    proc.on("error", () => resolve(null));
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.on("error", reject);
  });
}

// Build a Thai summary line from a detections array (image or one frame).
export function summarizeDetections(detections) {
  if (!detections.length) return "ไม่เจอวัตถุที่รู้จัก";
  const counts = new Map();
  for (const d of detections) {
    counts.set(d.class, (counts.get(d.class) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cls, n]) => `${thaiLabel(cls)} ${n}`);
  return parts.join(", ");
}
