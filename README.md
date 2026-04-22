# Alxcer Guard Bot

Discord voice activity guard bot. ตรวจจับสมาชิกที่อยู่ในห้องเสียงแต่ไม่พูด แจ้งเตือน และปิดไมค์อัตโนมัติเมื่อหมดเวลา

**บอทรันบน GitHub Actions** ทั้งหมด ไม่ต้องมี server ตลอดเวลา — มี cron รันใหม่ทุก 6 ชั่วโมง

## How it works

1. เข้าห้องเสียงที่มีคนอยู่มากที่สุดในเซิร์ฟเวอร์
2. รับสตรีมเสียงของสมาชิกทุกคน เพื่อจับเวลาว่าพูดล่าสุดเมื่อไหร่ (ใช้ audio packet จริง — ไม่ได้ดูแค่ event "เริ่มพูด")
3. เงียบเกิน `warningSeconds` → แจ้งเตือนในห้องที่ตั้งค่า + DM
4. เงียบเกิน `muteSeconds` → ปิดไมค์ + ส่งปุ่มให้กด unmute เอง
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

(workflow ตั้งให้รัน cron ใหม่ทุก 6 ชั่วโมง เพื่อรักษาให้บอทออนไลน์อยู่เสมอ)

### 4. ตั้งค่าผ่าน Discord ด้วย `/setting`

หลังจากบอทออนไลน์ พิมพ์ `/setting` ในเซิร์ฟเวอร์ จะมีหน้าตั้งค่า (เฉพาะคนที่มีสิทธิ์ Manage Server เท่านั้น):

- 📢 ห้องแจ้งเตือน — เลือก text channel ที่ต้องการให้บอทส่งคำเตือน
- 🎙️ ห้องเสียงที่ตรึง — เลือกห้องเสียงเฉพาะ หรือปล่อยว่างเพื่อให้เลือกห้องที่คนเยอะที่สุดอัตโนมัติ
- ⏱️ เวลาเตือน / ปิดไมค์ — กดปุ่ม "ตั้งเวลา..." แล้วใส่จำนวนวินาที

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
- ถ้าต้องการ uptime 24/7 ไม่มี gap ให้รันบน host ของตัวเอง (Replit deployment, VPS ฯลฯ)
