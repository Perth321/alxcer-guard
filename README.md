# Alxcer Guard Bot

Discord voice assistant/guard bot ที่ทำงานแยกกันทุกเซิร์ฟเวอร์ และเริ่มในโหมดเสียงใช้ง่ายซึ่งไม่เปลี่ยนไมค์หรือเล่นเสียงเอง

**บอทรันบน GitHub Actions** และหมุน job ประมาณทุก 5 ชั่วโมง

## ChatGPT integration test

hello

## How it works

1. เข้าห้องเสียงที่มีคนอยู่มากที่สุดในแต่ละเซิร์ฟเวอร์แบบเงียบ
2. รับสตรีมเสียงของสมาชิกทุกคน เพื่อจับเวลาว่าพูดล่าสุดเมื่อไหร่ (ใช้ audio packet จริง — ไม่ได้ดูแค่ event "เริ่มพูด")
3. ค่าเริ่มต้นจะไม่เตือน ปิดไมค์ เปิดไมค์ หรือตีกริ่งเอง
4. พูด `การ์ด` เพื่อเรียกบอท จะได้ยินเสียงปิ๊บตอบรับเพียงครั้งเดียว
5. ตรวจสอบทุก 5 วินาที และเปลี่ยนห้องอัตโนมัติถ้ามีห้องอื่นคนเยอะกว่า

## Setup

### 1. เพิ่ม secret ของ Discord bot

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `DISCORD_PERSONAL_ACCESS_TOKEN`
- Value: token ของบอท Discord

### 2. เปิด intent ที่จำเป็นใน Discord Developer Portal

[Discord Developer Portal](https://discord.com/developers/applications) → app ของคุณ → **Bot**:

- ✅ SERVER MEMBERS INTENT (privileged)

สิทธิ์ที่ต้องให้บอทตอนเชิญ:

- View Channels
- Connect / Speak (voice)
- Mute Members
- Send Messages / Embed Links
- Use Application Commands

### 3. รันบอทครั้งแรก

GitHub repo → **Actions → Alxcer Guard → Run workflow**

(workflow ตั้งให้รันใหม่เป็นระยะเพื่อรักษาให้บอทออนไลน์)

### 4. ตั้งค่าผ่าน Discord ด้วย `/setting`

หลังจากบอทออนไลน์ พิมพ์ `/setting` ในเซิร์ฟเวอร์ จะมีหน้าตั้งค่า (เฉพาะคนที่มีสิทธิ์ Manage Server เท่านั้น):

- 📢 ห้องแจ้งเตือน — เลือก text channel ที่ต้องการให้บอทส่งคำเตือน
- 🎙️ ห้องเสียงที่ตรึง — เลือกห้องเสียงเฉพาะ หรือปล่อยว่างเพื่อให้เลือกห้องที่คนเยอะที่สุดอัตโนมัติ
- ⏱️ เวลาเตือน / ปิดไมค์ — กดปุ่ม "ตั้งเวลา..." แล้วใส่จำนวนวินาที
- 🛡️ ใช้โหมดง่าย — ปิดเสียงตอนเข้า/ย้ายห้อง, classroom อัตโนมัติ และการเปลี่ยนไมค์อัตโนมัติทั้งหมดในคลิกเดียว

ฟีเจอร์ที่เปลี่ยนสถานะสมาชิกอัตโนมัติเป็น opt-in ต่อเซิร์ฟเวอร์ ได้แก่ `inactivityMuteEnabled`, `voiceWordBanEnabled` และ `chatVoiceMuteEnabled` ส่วนเสียงเข้าและ classroom อัตโนมัติควบคุมด้วย `joinSoundEnabled` และ `classroomAutomationEnabled` ตามลำดับ

ค่าจะถูกบันทึกกลับเข้า `bot/config.json` ในรีโพอัตโนมัติผ่าน GitHub API ของ Actions เอง รอบรันต่อไปจะใช้ค่าใหม่ทันที

> ครั้งแรกถ้ายังไม่มี `guildId` บอทจะออนไลน์อยู่เฉย ๆ เพื่อรอให้คุณตั้งค่า ให้ใช้ `/setting` ตั้งค่าก่อน แล้ว trigger workflow ใหม่อีกครั้ง

## Local testing (optional)

```bash
cd bot
npm install
DISCORD_PERSONAL_ACCESS_TOKEN=xxx node src/index.js
```

`bot/config.json` ต้องมีอยู่แล้ว (ตั้งค่าผ่าน `/setting` ก็จะถูกสร้างให้)

## Bug fixes

- **คนพูดอยู่แต่ถูกบอทบอกว่าไม่พูด:** เดิม `lastSpoke` อัปเดตเฉพาะตอน "เริ่มพูด" (event `speaking.start`) เท่านั้น ทำให้คนที่พูดยาวต่อเนื่องเกินค่า `warningSeconds` โดนเตือน/ปิดไมค์ทั้งที่กำลังพูดอยู่ ตอนนี้แก้ให้ subscribe สตรีมเสียงของแต่ละคน และอัปเดต `lastSpoke` ทุกครั้งที่มี audio packet จริงเข้ามา

## Limitations

- GitHub Actions รันได้สูงสุด 6 ชั่วโมงต่อ job — cron จะ relaunch ใหม่ ทำให้มี gap เล็กน้อย (~10–60s)
- Cron ของ GitHub free อาจ delay ตอน traffic สูง
- ถ้าต้องการ uptime 24/7 ไม่มี gap ให้รันบน host ของตัวเอง (VPS ฯลฯ)
