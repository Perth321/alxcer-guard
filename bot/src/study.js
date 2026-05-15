// Study mode: upload a document → bot generates a 10-question quiz →
// every user takes the SAME quiz independently (per-user progress) by
// clicking buttons. Same quiz stays active until /study reset or a new
// upload replaces it.
//
// Storage is in-memory only. The bot runs in a 6h GitHub Actions container
// so the quiz naturally expires when the run ends — admins can re-upload.

import * as XLSX from "xlsx";
import mammoth from "mammoth";
import JSZip from "jszip";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { chat } from "./ai.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_CHARS = 12_000;
const TARGET_QUESTIONS = 10;
const MIN_QUESTIONS = 5;
const LETTERS = ["A", "B", "C", "D"];

// guildId -> { id, fileName, questions[], createdAt, createdBy }
const activeQuiz = new Map();
// `${guildId}:${userId}` -> { quizId, qIdx, answers, submitted, score, outOf }
const userProgress = new Map();

function pkey(g, u) { return `${g}:${u}`; }

export function getActiveQuiz(guildId) {
  return activeQuiz.get(guildId) ?? null;
}

export function resetQuiz(guildId) {
  activeQuiz.delete(guildId);
  for (const k of [...userProgress.keys()]) {
    if (k.startsWith(guildId + ":")) userProgress.delete(k);
  }
}

export function setActiveQuiz(guildId, quiz) {
  activeQuiz.set(guildId, quiz);
  for (const k of [...userProgress.keys()]) {
    if (k.startsWith(guildId + ":")) userProgress.delete(k);
  }
}

export function listTakers(guildId) {
  const out = [];
  for (const [k, p] of userProgress) {
    if (!k.startsWith(guildId + ":")) continue;
    out.push({
      userId: k.split(":")[1],
      submitted: !!p.submitted,
      answered: Object.keys(p.answers).length,
      score: p.score ?? null,
      outOf: p.outOf ?? null,
    });
  }
  return out;
}

// ─── File parsing ────────────────────────────────────────────────────────────

function detectKind(name) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return "xlsx";
  if (n.endsWith(".pptx")) return "pptx";
  if (n.endsWith(".txt") || n.endsWith(".md")) return "txt";
  return null;
}

async function fetchAttachment(att) {
  if (att.size && att.size > MAX_FILE_BYTES) {
    throw new Error(`ไฟล์ใหญ่เกิน ${MAX_FILE_BYTES / 1024 / 1024}MB`);
  }
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์ไม่สำเร็จ: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_FILE_BYTES) {
    throw new Error(`ไฟล์ใหญ่เกิน ${MAX_FILE_BYTES / 1024 / 1024}MB`);
  }
  return Buffer.from(ab);
}

async function extractText(buf, kind) {
  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return (value || "").trim();
  }
  if (kind === "xlsx") {
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      if (csv.trim()) parts.push(`# Sheet: ${name}\n${csv}`);
    }
    return parts.join("\n\n").trim();
  }
  if (kind === "pptx") {
    const zip = await JSZip.loadAsync(buf);
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml/i)[1], 10);
        const nb = parseInt(b.match(/slide(\d+)\.xml/i)[1], 10);
        return na - nb;
      });
    const parts = [];
    for (let i = 0; i < slideNames.length; i++) {
      const xml = await zip.files[slideNames[i]].async("string");
      const texts = [];
      const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
      let m;
      while ((m = re.exec(xml))) {
        const t = m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'");
        if (t.trim()) texts.push(t);
      }
      const slideText = texts.join(" ").replace(/\s+/g, " ").trim();
      if (slideText) parts.push(`# สไลด์ ${i + 1}\n${slideText}`);
    }
    return parts.join("\n\n").trim();
  }
  if (kind === "txt") {
    return buf.toString("utf8").trim();
  }
  throw new Error("ชนิดไฟล์ไม่รองรับ");
}

// ─── Quiz generation via LLM ─────────────────────────────────────────────────

const QUIZ_PROMPT = `คุณคือผู้ออกข้อสอบที่เก่งภาษาไทย จากเนื้อหาที่ให้ จงสร้างข้อสอบปรนัย ${TARGET_QUESTIONS} ข้อ
- แต่ละข้อมี 4 ตัวเลือก (A, B, C, D)
- ตัวเลือกถูกต้อง 1 ข้อ ตัวที่เหลือเป็น distractor ที่สมเหตุสมผล
- คำถามและคำตอบเป็นภาษาไทย (เว้นคำเทคนิคที่เป็นภาษาอังกฤษได้)
- คำถามต้องวัดความเข้าใจ ไม่ใช่ลอกประโยคเดิม
- ครอบคลุมเนื้อหาหลายส่วนอย่างสมดุล

ตอบกลับเป็น JSON เท่านั้น (ห้ามมี markdown fence) ตามรูปแบบ:
{
  "questions": [
    {
      "q": "คำถาม...",
      "choices": ["ตัวเลือก A", "ตัวเลือก B", "ตัวเลือก C", "ตัวเลือก D"],
      "answer": 0,
      "explain": "เหตุผลสั้น ๆ"
    }
  ]
}`;

function tryParseJson(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function generateQuestions(sourceText) {
  const trimmed = sourceText.replace(/[ \t]+/g, " ").slice(0, MAX_TEXT_CHARS);
  if (!trimmed || trimmed.length < 50) {
    throw new Error("ไม่พบเนื้อหาที่อ่านได้ในไฟล์ (อาจเป็น scan/รูปภาพ)");
  }
  const result = await chat(
    [{ role: "user", content: `${QUIZ_PROMPT}\n\n=== เนื้อหา ===\n${trimmed}` }],
    { max_tokens: 2500, temperature: 0.6 },
  );
  const parsed = tryParseJson(result?.content ?? "");
  if (!parsed) throw new Error("AI ไม่ตอบเป็น JSON ที่อ่านได้");
  const list = Array.isArray(parsed.questions) ? parsed.questions : [];
  const cleaned = [];
  for (const q of list) {
    if (typeof q?.q !== "string") continue;
    if (!Array.isArray(q.choices) || q.choices.length !== 4) continue;
    const ans = Number(q.answer);
    if (!Number.isInteger(ans) || ans < 0 || ans > 3) continue;
    cleaned.push({
      q: q.q.trim().slice(0, 280),
      choices: q.choices.map((c) => String(c).trim().slice(0, 140)),
      answer: ans,
      explain: typeof q.explain === "string" ? q.explain.trim().slice(0, 240) : "",
    });
    if (cleaned.length >= TARGET_QUESTIONS) break;
  }
  if (cleaned.length < MIN_QUESTIONS) {
    throw new Error(`AI สร้างข้อสอบได้แค่ ${cleaned.length} ข้อ (ต้องการอย่างน้อย ${MIN_QUESTIONS}) ลองอัพไฟล์ที่มีเนื้อหามากกว่านี้`);
  }
  return cleaned;
}

export async function buildQuizFromAttachment(attachment, { createdBy }) {
  const kind = detectKind(attachment.name);
  if (!kind) throw new Error("รองรับเฉพาะ .docx .xlsx .pptx .txt");
  const buf = await fetchAttachment(attachment);
  const text = await extractText(buf, kind);
  if (!text || text.length < 50) {
    throw new Error("ไฟล์ไม่มีเนื้อหา หรือเป็น scan/รูปภาพอย่างเดียว");
  }
  const questions = await generateQuestions(text);
  return {
    id: `q_${Date.now().toString(36)}`,
    fileName: attachment.name,
    fileKind: kind,
    questions,
    createdAt: Date.now(),
    createdBy,
  };
}

// ─── Per-user progress ───────────────────────────────────────────────────────

export function getOrCreateProgress(guildId, userId, quizId) {
  const k = pkey(guildId, userId);
  let p = userProgress.get(k);
  if (!p || p.quizId !== quizId) {
    p = { quizId, qIdx: 0, answers: {}, submitted: false, startedAt: Date.now() };
    userProgress.set(k, p);
  }
  return p;
}

export function getProgress(guildId, userId) {
  return userProgress.get(pkey(guildId, userId)) ?? null;
}

export function resetUserProgress(guildId, userId) {
  userProgress.delete(pkey(guildId, userId));
}

export function recordAnswer(guildId, userId, qIdx, choice, total) {
  const p = userProgress.get(pkey(guildId, userId));
  if (!p || p.submitted) return p;
  p.answers[qIdx] = choice;
  // Auto-advance if not on last question
  if (qIdx < total - 1 && qIdx >= p.qIdx) p.qIdx = qIdx + 1;
  return p;
}

export function jumpTo(guildId, userId, qIdx) {
  const p = userProgress.get(pkey(guildId, userId));
  if (!p || p.submitted) return p;
  p.qIdx = Math.max(0, qIdx);
  return p;
}

export function submitFinal(guildId, userId) {
  const quiz = activeQuiz.get(guildId);
  const p = userProgress.get(pkey(guildId, userId));
  if (!quiz || !p) return null;
  p.submitted = true;
  let correct = 0;
  for (let i = 0; i < quiz.questions.length; i++) {
    if (p.answers[i] === quiz.questions[i].answer) correct++;
  }
  p.score = correct;
  p.outOf = quiz.questions.length;
  p.submittedAt = Date.now();
  return p;
}

// ─── Render helpers ──────────────────────────────────────────────────────────

export function renderQuestion(quiz, progress) {
  const total = quiz.questions.length;
  const idx = Math.max(0, Math.min(progress.qIdx, total - 1));
  const q = quiz.questions[idx];
  const picked = progress.answers[idx];

  const lines = [];
  lines.push(`**${q.q}**`);
  lines.push("");
  for (let i = 0; i < q.choices.length; i++) {
    const mark = picked === i ? "🔵" : "⚪";
    lines.push(`${mark} **${LETTERS[i]}.** ${q.choices[i]}`);
  }
  const answeredCount = Object.keys(progress.answers).length;

  const embed = new EmbedBuilder()
    .setColor(0x6366f1)
    .setTitle(`📚 ข้อ ${idx + 1} / ${total}`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `ตอบไปแล้ว ${answeredCount}/${total} · ไฟล์: ${quiz.fileName}` });

  const choiceRow = new ActionRowBuilder().addComponents(
    ...q.choices.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`study:ans:${idx}:${i}`)
        .setLabel(LETTERS[i])
        .setStyle(picked === i ? ButtonStyle.Success : ButtonStyle.Primary),
    ),
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`study:nav:${Math.max(0, idx - 1)}`)
      .setLabel("◀ ก่อนหน้า")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx === 0),
    new ButtonBuilder()
      .setCustomId(`study:nav:${Math.min(total - 1, idx + 1)}`)
      .setLabel("ถัดไป ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx >= total - 1),
    new ButtonBuilder()
      .setCustomId("study:submit")
      .setLabel(`ส่งคำตอบ (${answeredCount}/${total})`)
      .setStyle(answeredCount >= total ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(answeredCount < total),
  );

  return { embeds: [embed], components: [choiceRow, navRow] };
}

export function renderResult(quiz, progress) {
  const lines = [];
  lines.push(`🎯 คะแนน: **${progress.score} / ${progress.outOf}**`);
  lines.push("");
  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    const picked = progress.answers[i];
    const ok = picked === q.answer;
    const pickedLabel = picked != null
      ? `${LETTERS[picked]}. ${q.choices[picked]}`
      : "_ไม่ได้ตอบ_";
    const correctLabel = `${LETTERS[q.answer]}. ${q.choices[q.answer]}`;
    lines.push(`${ok ? "✅" : "❌"} **ข้อ ${i + 1}** ${q.q}`);
    lines.push(`• คุณตอบ: ${pickedLabel}`);
    if (!ok) lines.push(`• เฉลย: **${correctLabel}**`);
    if (q.explain) lines.push(`• 💡 ${q.explain}`);
    lines.push("");
  }
  // Discord embed description max 4096 chars; chunk overflow into a 2nd embed
  const full = lines.join("\n");
  const passed = progress.score >= Math.ceil(progress.outOf * 0.7);
  const head = new EmbedBuilder()
    .setColor(passed ? 0x22c55e : 0xef4444)
    .setTitle(`📊 ผลข้อสอบ — ${quiz.fileName}`)
    .setDescription(full.slice(0, 4000));
  const embeds = [head];
  if (full.length > 4000) {
    embeds.push(
      new EmbedBuilder()
        .setColor(passed ? 0x22c55e : 0xef4444)
        .setDescription(full.slice(4000, 8000)),
    );
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("study:retry")
      .setLabel("🔁 ทำใหม่")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds, components: [row] };
}
