# Alxcer Guard Bot

Discord voice/chat guard bot with an admin agent, voice commands and per-server runtime isolation.

**The bot runs entirely on GitHub Actions** — there is no always-on server. The workflow rotates before the hosted-runner limit and dispatches the next run.

## How it works

1. Creates an isolated runtime for every Discord server the bot is in.
2. Joins at most one populated voice channel per server and stays there until that room is empty (or an admin pins another room).
3. Plays one short local beep on a normal join, then listens for wake-word commands.
4. Keeps STT queues fair between servers and in-order for each speaker.
5. Lets every member talk to Guard, but exposes agent tools only to Owner, Administrator or Manage Server.
6. Limits host/repository/log/file/browser tools to the bot owner; a server moderator cannot read runner secrets or files.

For a spoken command that changes server state, an authorized admin must start the command body with `ยืนยัน` or `confirm`, for example: `การ์ด ยืนยัน ปิดไมค์ Alex 1 นาที`. Read-only voice questions do not need confirmation.

Automatic muting is now safe opt-in. These settings default to `false` for every server:

- `inactivityMuteEnabled`
- `voiceWordBanEnabled`
- `chatVoiceMuteEnabled`
- `aiModerationEnabled`
- `spontaneousChatEnabled`

Guard records an opaque durable mute lease whenever it applies a mute. Old timers and old buttons cannot unmute a newer mute or a mute owned by another moderator, including after a planned runner restart.

## Setup

### 1. Push this repo to GitHub

```bash
git remote add origin git@github.com:YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

### 2. Add the Discord bot token to GitHub Actions secrets

In your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `DISCORD_PERSONAL_ACCESS_TOKEN`
- Value: your Discord bot token

### 3. Enable required Discord bot intents

In the [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** tab, enable:

- ✅ SERVER MEMBERS INTENT (privileged)

Bot permissions when inviting it to your server:
- View Channels
- Connect (voice)
- Speak (voice)
- Mute Members
- Send Messages
- Embed Links
- Use Application Commands

### 4. Configure each server

Run `/setting` inside each server, then choose that server's channels and timings. `bot/config.json` uses a v2 per-server shape:

```json
{
  "version": 2,
  "ownerId": "YOUR_DISCORD_USER_ID",
  "primaryGuildId": "SERVER_ID",
  "guilds": {
    "SERVER_ID": {
      "voiceChannelId": "",
      "notifyChannelId": "CHANNEL_ID",
      "inactivityMuteEnabled": false
    }
  }
}
```

The former flat single-server config is migrated automatically without deleting settings. Saving `/setting` updates only the current server and does not overwrite other servers.

### 5. Run the bot

Click **เริ่มบอททันที** in the settings app, or trigger the workflow manually:

GitHub repo → **Actions → Alxcer Guard → Run workflow**

The workflow is also scheduled every 5 hours as a recovery trigger. Successful runs self-dispatch after a 345-minute rotation window.

## Local testing (optional)

```bash
cd bot
npm ci
DISCORD_PERSONAL_ACCESS_TOKEN=xxx node src/index.js
```

`bot/config.json` must already exist (use the settings UI to create one, or fill it in by hand).

Run regression and boot-import checks with:

```bash
npm test
npm run check:boot
```

## Limitations

- GitHub-hosted runners are not an always-on hosting SLA. Dispatch or scheduled runs can be delayed, so short or occasionally longer offline gaps remain possible even with self-restart and cron recovery.
- Cron triggers on free GitHub accounts can be delayed during high traffic.
- For 24/7 uptime with no gaps, run the bot on a dedicated host (Replit deployment, VPS, etc.).
