# Alxcer Guard Bot

Discord voice activity guard bot. Detects users who don't speak in a voice channel, warns them, and mutes them after a timeout. Provides an inline button to unmute.

**The bot runs entirely on GitHub Actions** — there is no always-on server. A scheduled workflow re-launches the runner every 6 hours.

## How it works

1. Joins the voice channel with the most humans in your guild
2. Listens for speaking events on every member
3. After `warningSeconds` of silence (default 180 = 3 min): posts a warning in the configured text channel + DMs the user
4. After `muteSeconds` of silence (default 300 = 5 min): server-mutes the user and posts a button so they can unmute themselves
5. Re-evaluates every 5 seconds and switches to a fuller channel if needed

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

### 4. Configure via the settings web app

Open the Alxcer Guard Settings web app (this Replit), enter your repo (`owner/name`), then:

- Discord Server (Guild) ID
- Notification text channel ID
- Warning seconds (default 180)
- Mute seconds (default 300)

Click **บันทึกลง GitHub** — this commits `bot/config.json` to your repo via the GitHub API.

### 5. Run the bot

Click **เริ่มบอททันที** in the settings app, or trigger the workflow manually:

GitHub repo → **Actions → Alxcer Guard → Run workflow**

The workflow is also scheduled to relaunch every 6 hours so the bot stays online.

## Local testing (optional)

```bash
cd bot
npm install
DISCORD_PERSONAL_ACCESS_TOKEN=xxx node src/index.js
```

`bot/config.json` must already exist (use the settings UI to create one, or fill it in by hand).

## Limitations

- GitHub Actions jobs have a **6 hour maximum**. The scheduled cron re-launches the workflow every 6 hours, but there will be a small gap (~10–60 seconds) between runs.
- Cron triggers on free GitHub accounts can be delayed during high traffic.
- For 24/7 uptime with no gaps, run the bot on a dedicated host (Replit deployment, VPS, etc.).
