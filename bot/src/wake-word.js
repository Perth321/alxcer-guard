// Keep the wake word deliberately narrow. Speech-to-text commonly returns
// การ์ด/การด/การ์ต/กาด/ก๊าด, but matching ordinary words such as "คาด" makes
// the bot beep and consume the next utterance without being called.
const WAKE_TOKEN_RE =
  /(?:การ์?[ดตก]์?|ก(?:๊|้)?าด์?|guard|gaurd|gard|alxcer\s+guard|hey\s+guard)(?=$|[\s,.;:!?\-])/i;
const THAI_WAKE_PREFIX_RE = /^(?:การ์?[ดตก]์?|ก(?:๊|้)?าด์?)/i;
// Thai STT commonly removes the space in "การ์ด ปิดไมค์". Accept that form
// only when the suffix starts like a real request; a bare prefix match would
// bring back false wakes for ordinary nouns such as "การ์ดเกม"/"การ์ดจอ".
const UNSEPARATED_THAI_COMMAND_RE =
  /^(?:ช่วย|ปิด|เปิด|สร้าง|ลบ|แก้|ย้าย|ค้น|หา|ดู|บอก|ตอบ|คุย|พูด|ทำ|ตั้ง|เตะ|แบน|ปลด|ล็อก|ปลุก|เล่น|หยุด|ส่ง|เช็ก|เช็ค|ตรวจ|สรุป|แปล|เพิ่ม|เอา|ขอ|อ่าน|จัดการ|เวลา|วันนี้|พรุ่งนี้|เมื่อไร|กี่|ใคร|อะไร|ไหน|ทำไม|สวัสดี|หวัดดี|นาย|ชื่อ|เป็น|รู้จัก|จำ|หน่อย)/;
const WAKE_LEADING_NOISE_RE = /^[\s,.!?\-:'"`()\[\]{}♪♫\*<>]+/;
const WAKE_PROMPT_PREFIX_RE =
  /^(?:[\s,.;:!?\-]+|alxcer|อันนี้|อะนะ|อืม|เอ่อ|เออ|อ้า|โอ้|อะ|นี่|hey)\s*/i;

export function cleanForWake(text) {
  if (!text) return "";
  let cleaned = String(text).trim();
  for (let i = 0; i < 3; i += 1) {
    const before = cleaned;
    cleaned = cleaned
      .replace(/^\[[^\]]{1,60}\]\s*/, "")
      .replace(/^\([^)]{1,60}\)\s*/, "")
      .replace(/^♪+[^♪]{0,60}♪+\s*/, "")
      .replace(WAKE_LEADING_NOISE_RE, "");
    if (cleaned === before) break;
  }
  return cleaned.trim();
}

export function extractWakeCommand(text) {
  let cleaned = cleanForWake(text);
  if (!cleaned) return null;
  for (let i = 0; i < 2; i += 1) {
    const before = cleaned;
    cleaned = cleaned.replace(WAKE_PROMPT_PREFIX_RE, "");
    if (cleaned === before) break;
  }
  let match = cleaned.match(WAKE_TOKEN_RE);
  if (!match || match.index !== 0) {
    const thaiWake = cleaned.match(THAI_WAKE_PREFIX_RE);
    const suffix = thaiWake ? cleaned.slice(thaiWake[0].length) : "";
    if (!thaiWake || !UNSEPARATED_THAI_COMMAND_RE.test(suffix)) return null;
    match = thaiWake;
  }
  return cleaned
    .slice(match[0].length)
    .trim()
    .replace(WAKE_PROMPT_PREFIX_RE, "")
    .replace(/^[\s,.;:!?\-]+/, "")
    .trim();
}
