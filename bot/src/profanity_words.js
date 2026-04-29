// Multi-language profanity word list used for fast local detection.
// Keep this conservative so common false positives don't fire.
// AI moderator handles edge cases / context.

// CONSERVATIVE list — only HARD profanity / slurs that almost always carry
// offensive intent. Borderline words ("damn", "ass", "เลว", "เฮงซวย",
// "ระยำ", "shine", "hoe", "tard") have been removed because they show up too
// often in normal Thai/English chat and were causing the bot to mute people
// for nothing. Edge cases are still caught by the AI moderator with a
// severity ≥ 6 threshold (see moderation.js).
export const PROFANITY_WORDS = [
  // ===== ภาษาไทย (คำหยาบจริง ๆ ส่วนใหญ่เกี่ยวเพศ/ประณามครอบครัว) =====
  "หี", "ควย", "เย็ด", "เยด", "เหี้ย", "เหี้ยย", "เหี้ยๆ",
  "สัส", "สัด", "ไอ้สัตว์", "อีสัตว์",
  "ไอ้เหี้ย", "อีเหี้ย", "ไอ้สัส", "อีสัส",
  "อีดอก", "ดอกทอง", "อีตัว", "กระหรี่", "อีกะหรี่",
  "ขอดูหี", "ดูหี", "เลียหี", "เย็ดแม่", "เย็ดพ่อ",
  "โคตรเหี้ย", "โคตรพ่อมึง", "โคตรแม่มึง",
  "หน้าหี", "หน้าควย", "เลียควย", "อมควย", "อีหน้าหี",
  // ===== English (hard profanity + slurs) =====
  "fuck", "fck", "fuk", "fucking", "fucker", "motherfucker", "mofo",
  "shit", "sh1t", "shyt", "bullshit",
  "bitch", "biatch", "btch",
  "asshole", "arsehole",
  "dick", "dik", "cock",
  "cunt", "cnut", "kunt",
  "pussy", "twat",
  "slut", "whore", "thot",
  "bastard",
  "retard", "retarded",
  "faggot", "fag", "f4g",
  "nigger", "nigga", "n1gga",
  // ===== ภาษาอื่น (เก็บไว้เฉพาะที่ชัดว่าเป็นหยาบ) =====
  "kuso",
  "씨발", "시발", "개새끼", "병신", "좆",
  "操你妈", "傻逼", "他妈的", "草泥马",
  "puta", "mierda", "joder", "coño", "cabron", "cabrón",
  "porra", "caralho", "merda",
  "блядь", "сука", "хуй", "пизда",
  "putain", "merde", "salope", "connard",
  "scheisse", "scheiße", "arschloch", "schlampe",
  "siktir", "amk", "orospu",
  "كس", "زب", "شرموطة",
  "anjing", "babi", "kontol", "memek", "puki",
  "địt", "lồn", "cặc",
  "putang", "tangina", "gago",
  "chutiya", "madarchod", "bhenchod", "behenchod",
];

// Build a normalized set for O(1) exact-word lookup.
const normalized = new Set(PROFANITY_WORDS.map((w) => normalizeText(w)));

export function normalizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s_\-.+]+/g, " ")
    .trim();
}

// Tokenize into Thai-aware chunks + latin words.
function tokenize(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  return norm.split(/[\s,!?.…"';:()\[\]{}<>/\\|@#$%^&*~`=]+/).filter(Boolean);
}

// Returns the matched profanity word, or null.
export function findProfanity(text, extraWords = []) {
  const norm = normalizeText(text);
  if (!norm) return null;
  // 1) Substring scan for canonical bad words (catches embedded usage like "หีๆ", "fuuck", "fffuck")
  for (const w of PROFANITY_WORDS) {
    const wn = normalizeText(w);
    if (wn && norm.includes(wn)) return w;
  }
  for (const w of extraWords) {
    const wn = normalizeText(w);
    if (wn && norm.includes(wn)) return w;
  }
  // 2) Token exact match (catches leetspeak after normalize)
  const tokens = tokenize(text);
  for (const t of tokens) {
    if (normalized.has(t)) return t;
  }
  // 3) De-leet then re-check
  const deleet = norm
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s");
  for (const w of PROFANITY_WORDS) {
    const wn = normalizeText(w);
    if (wn && deleet.includes(wn)) return w;
  }
  return null;
}
