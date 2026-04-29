// Multi-language profanity word list used for fast local detection.
// Keep this conservative so common false positives don't fire.
// AI moderator handles edge cases / context.

export const PROFANITY_WORDS = [
  // ===== ภาษาไทย =====
  "หี", "ควย", "เย็ด", "เยด", "เหี้ย", "เหี้ยย", "เหี้ยๆ",
  "สัส", "สัด", "สาด", "ไอ้สัตว์", "อีสัตว์", "สัตว์",
  "ไอ้เหี้ย", "อีเหี้ย", "ไอ้สัส", "อีสัส", "ไอ้ห่า", "อีห่า",
  "อีดอก", "ดอกทอง", "อีตัว", "กระหรี่", "อีกะหรี่",
  "ขอดูหี", "ดูหี", "เลียหี", "เย็ดแม่", "เย็ดพ่อ",
  "แม่งโคตร", "โคตรเหี้ย", "โคตรพ่อ", "โคตรแม่",
  "แม่มึง", "พ่อมึง", "ไอ้ควาย", "อีควาย",
  "หน้าหี", "หน้าควย", "เลียควย", "อมควย", "อีหน้าหี",
  "ระยำ", "ชาติชั่ว", "เลว", "เฮงซวย",
  // ===== English =====
  "fuck", "fck", "fuk", "fucking", "fucker", "motherfucker", "mofo",
  "shit", "sh1t", "shyt", "bullshit",
  "bitch", "biatch", "btch",
  "asshole", "ass", "arse", "arsehole",
  "dick", "dik", "cock",
  "cunt", "cnut", "kunt",
  "pussy", "twat",
  "slut", "whore", "hoe", "thot",
  "bastard",
  "retard", "retarded", "tard",
  "faggot", "fag", "f4g",
  "nigger", "nigga", "n1gga",
  "damn", "damnit", "goddamn",
  // ===== ภาษาอื่นๆ ที่พบบ่อย =====
  // ญี่ปุ่น
  "kuso", "chikushou", "shine",
  // เกาหลี
  "씨발", "시발", "개새끼", "병신", "좆",
  // จีน
  "操你妈", "傻逼", "他妈的", "草泥马", "fuck你",
  // สเปน
  "puta", "mierda", "joder", "coño", "cabron", "cabrón",
  // โปรตุเกส
  "porra", "caralho", "merda",
  // รัสเซีย
  "блядь", "сука", "хуй", "пизда",
  // ฝรั่งเศส
  "putain", "merde", "salope", "connard",
  // เยอรมัน
  "scheisse", "scheiße", "arschloch", "schlampe",
  // ตุรกี
  "siktir", "amk", "orospu",
  // อาหรับ
  "كس", "زب", "شرموطة",
  // อินโดฯ/มาเลย์
  "anjing", "babi", "kontol", "memek", "puki",
  // เวียดนาม
  "địt", "lồn", "cặc",
  // ฟิลิปปินส์
  "putang", "tangina", "gago",
  // ฮินดี (latin)
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
