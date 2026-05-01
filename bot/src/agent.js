// Admin agent: gives the LLM a full Discord toolbox so an admin can drive the
// bot in natural language. The admin can say things like "ปิดไมค์ A",
// "เตะ B ออกจากห้อง", "ลบ 10 ข้อความล่าสุด", "แบน C" — the agent will resolve
// names, choose the right tools, chain calls, and report back.

import { PermissionFlagsBits, ChannelType } from "discord.js";
import { generateReply, aiAvailable, getModelStatus } from "./ai.js";
import { webSearch, fetchUrl, wikipediaLookup, getWeather } from "./tools_web.js";
import { runCode, deployWebpage, readOwnLog, readOwnSource, writeOwnSource,
         screenshotUrl, inspectWebpage, checkWebsite, computerBrowse,
         readLocalFile, writeLocalFile, listLocalFiles, shellExec } from "./tools_openclaw.js";
import {
  createTimer,
  cancelTimer,
  getTimer,
  listTimers,
  parseDurationToFireAt,
  alarmAtToFireAt,
  formatDurationShort,
  formatClockBangkok,
} from "./timers.js";

export function isAdmin(member) {
  if (!member) return false;
  return member.permissions?.has?.(PermissionFlagsBits.Administrator) === true;
}

// ===== TOOL DEFINITIONS (OpenAI-compatible JSON schema) =====
const TOOLS = [
  // --- Resolution helpers (use these first when admin gives a name, not an ID) ---
  {
    type: "function",
    function: {
      name: "resolve_user",
      description:
        "Find a member by display name, username, or partial match (Thai or English). ALWAYS call this first when the admin refers to a user by name instead of ID. Returns up to 5 candidates with their user_id and current voice state.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_channel",
      description: "Find a channel by name. Returns up to 5 candidates with channel_id.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["text", "voice", "any"] },
        },
        required: ["query"],
      },
    },
  },

  // --- Voice control ---
  {
    type: "function",
    function: {
      name: "voice_mute",
      description: "Server-mute a user in voice (cannot speak). Persists until you unmute.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_unmute",
      description: "Lift a server-mute on a user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_deafen",
      description: "Server-deafen a user (they cannot hear voice).",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_undeafen",
      description: "Remove server-deafen.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_disconnect",
      description: "Kick a user out of their current voice channel.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_move",
      description: "Move a user to a different voice channel.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          channel_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["user_id", "channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_voice_members",
      description:
        "List members currently in a voice channel (or all voice channels if channel_id is omitted). Includes mute/deafen state.",
      parameters: {
        type: "object",
        properties: { channel_id: { type: "string" } },
      },
    },
  },

  // --- BATCH voice tools (ALWAYS prefer these for "ทุกคน" / "all" / "everyone" requests) ---
  // Each accepts EITHER explicit user_ids OR a scope keyword. Returns a summary
  // of how many were affected. Use ONE call instead of looping voice_mute.
  {
    type: "function",
    function: {
      name: "voice_mute_many",
      description:
        "Server-mute MULTIPLE users at once (one API round-trip, parallel execution). USE THIS for any 'ปิดไมค์ทุกคน' / 'ปิดทั้งห้อง' / 'mute everyone' / 'mute all' style request. Provide EITHER explicit user_ids OR a scope. The bot itself is always excluded.",
      parameters: {
        type: "object",
        properties: {
          user_ids: { type: "array", items: { type: "string" }, description: "Explicit list of user IDs" },
          scope: {
            type: "string",
            enum: ["all_in_channel", "all_in_my_channel", "all_except_me", "all_in_voice"],
            description:
              "all_in_channel = everyone in channel_id; all_in_my_channel = everyone in the admin's current voice channel; all_except_me = same as all_in_my_channel but excludes the admin; all_in_voice = everyone in ANY voice channel in the guild.",
          },
          channel_id: { type: "string", description: "Required when scope=all_in_channel" },
          exclude_user_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_unmute_many",
      description: "Lift server-mute on MULTIPLE users at once. Same arg shape as voice_mute_many.",
      parameters: {
        type: "object",
        properties: {
          user_ids: { type: "array", items: { type: "string" } },
          scope: {
            type: "string",
            enum: ["all_in_channel", "all_in_my_channel", "all_except_me", "all_in_voice"],
          },
          channel_id: { type: "string" },
          exclude_user_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_deafen_many",
      description: "Server-deafen MULTIPLE users at once.",
      parameters: {
        type: "object",
        properties: {
          user_ids: { type: "array", items: { type: "string" } },
          scope: {
            type: "string",
            enum: ["all_in_channel", "all_in_my_channel", "all_except_me", "all_in_voice"],
          },
          channel_id: { type: "string" },
          exclude_user_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_undeafen_many",
      description: "Remove server-deafen from MULTIPLE users at once.",
      parameters: {
        type: "object",
        properties: {
          user_ids: { type: "array", items: { type: "string" } },
          scope: {
            type: "string",
            enum: ["all_in_channel", "all_in_my_channel", "all_except_me", "all_in_voice"],
          },
          channel_id: { type: "string" },
          exclude_user_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_disconnect_many",
      description: "Kick MULTIPLE users out of voice at once.",
      parameters: {
        type: "object",
        properties: {
          user_ids: { type: "array", items: { type: "string" } },
          scope: {
            type: "string",
            enum: ["all_in_channel", "all_in_my_channel", "all_except_me", "all_in_voice"],
          },
          channel_id: { type: "string" },
          exclude_user_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_move_many",
      description:
        "Move MULTIPLE users to a target voice channel at once. target_channel_id is required.",
      parameters: {
        type: "object",
        properties: {
          user_ids: { type: "array", items: { type: "string" } },
          scope: {
            type: "string",
            enum: ["all_in_channel", "all_in_my_channel", "all_except_me", "all_in_voice"],
          },
          channel_id: { type: "string", description: "SOURCE channel when scope=all_in_channel" },
          target_channel_id: { type: "string", description: "DESTINATION channel id" },
          exclude_user_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["target_channel_id"],
      },
    },
  },

  // --- Moderation ---
  {
    type: "function",
    function: {
      name: "delete_message",
      description: "Delete a single message by ID.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          channel_id: { type: "string", description: "default = current channel" },
          reason: { type: "string" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bulk_delete_messages",
      description:
        "Delete the last N messages in a channel (max 100, only messages ≤14 days old). Optionally filter to a single user.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "default = current channel" },
          count: { type: "number", description: "1-100" },
          from_user_id: { type: "string" },
        },
        required: ["count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "timeout_user",
      description:
        "Server-timeout a user (cannot send msg or talk). Max 28 days = 2419200 seconds.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          seconds: { type: "number" },
          reason: { type: "string" },
        },
        required: ["user_id", "seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "untimeout_user",
      description: "Remove an active timeout from a user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kick_user",
      description: "Kick a user from the guild.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ban_user",
      description: "Ban a user from the guild.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          delete_message_days: { type: "number", description: "0-7" },
          reason: { type: "string" },
        },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unban_user",
      description: "Unban a previously banned user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" }, reason: { type: "string" } },
        required: ["user_id"],
      },
    },
  },

  // --- Member management ---
  {
    type: "function",
    function: {
      name: "set_nickname",
      description: "Change a user's nickname in this guild. Empty string clears it.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          nickname: { type: "string" },
          reason: { type: "string" },
        },
        required: ["user_id", "nickname"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_role",
      description: "Add a role to a user.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          role_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["user_id", "role_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_role",
      description: "Remove a role from a user.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          role_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["user_id", "role_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_roles",
      description: "List roles in the guild (id, name, color).",
      parameters: { type: "object", properties: {} },
    },
  },

  // --- Channel/message ---
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a text message to a channel. Defaults to the current channel.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pin_message",
      description: "Pin a message in a channel.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          channel_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unpin_message",
      description: "Unpin a message.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          channel_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_channels",
      description: "List text/voice channels in the guild.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_members",
      description: "List members in the guild (id, displayName, isAdmin, in_voice).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_messages",
      description: "Fetch the latest messages from a channel.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          limit: { type: "number", description: "1-50" },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_offenses",
      description: "Look up the chat-offense + voice-offense history of a user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_offenses",
      description:
        "Get the most recent offense events across the WHOLE server (who did what, when, what word, severity). Use this when the admin asks 'ตรวจสอบบันทึก', 'ใครทำอะไรบ้าง', 'ดู log ล่าสุด'.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "1-30, default 10" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_user_offenses",
      description: "Reset the offense counters for a user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" } },
        required: ["user_id"],
      },
    },
  },

  // ===== Timers / alarms / sleep mode / temporary mute =====
  {
    type: "function",
    function: {
      name: "set_timer",
      description:
        "Create a countdown timer that posts a pretty Discord embed when it fires. Use for 'ตั้งเวลา 5 นาที', 'เตือนใน 30 วินาที', 'นับถอยหลังให้หน่อย'. Pings the requesting admin (or the mention_user_id) when due. Supports second-level precision.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "integer", description: "Seconds component" },
          minutes: { type: "integer", description: "Minutes component" },
          hours: { type: "integer", description: "Hours component" },
          label: { type: "string", description: "Short note shown in the embed (เช่น 'ต้มมาม่า')" },
          mention_user_id: { type: "string", description: "Optional user id to @mention when fired (defaults to the requesting admin)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_alarm",
      description:
        "Schedule an alarm at a specific clock time (Asia/Bangkok). If the time has already passed today it will fire tomorrow. Set play_wake_music=true for the soft-music wake-up flow that plays in the user's voice channel with a Stop button.",
      parameters: {
        type: "object",
        properties: {
          hour: { type: "integer", minimum: 0, maximum: 23 },
          minute: { type: "integer", minimum: 0, maximum: 59 },
          second: { type: "integer", minimum: 0, maximum: 59 },
          label: { type: "string" },
          play_wake_music: {
            type: "boolean",
            description: "If true, the bot joins the target user's voice channel and plays a soft TTS wake call + music loop until they hit Stop in the embed.",
          },
          mention_user_id: { type: "string", description: "User to wake / ping. Defaults to the requesting admin." },
        },
        required: ["hour", "minute"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_self_disconnect",
      description:
        "Sleep mode: schedule the bot to disconnect a user from voice after N seconds. Posts an embed with a Cancel button so they can wake up before the timer hits. Use for 'ปลุกตัวเอง 10 นาทีแล้วเตะออก', 'sleep mode 30 นาที', 'ดีดกูออกใน 5 นาที'.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "integer" },
          minutes: { type: "integer" },
          hours: { type: "integer" },
          user_id: { type: "string", description: "User to disconnect. Defaults to the requesting admin." },
          label: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mute_user_for",
      description:
        "Server-mute a user immediately and automatically un-mute them after the given duration. Posts an embed countdown with a manual Unmute button. Use for 'ปิดไมค์ A 30 วินาที', 'mute B for 5 min'.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          seconds: { type: "integer" },
          minutes: { type: "integer" },
          hours: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["user_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_timers",
      description: "List active timers / alarms / sleep mode / auto-unmute jobs. Optionally filter by user.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "Optional — only show timers tied to this user (owner / target / mention)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_timer",
      description: "Cancel a single timer / alarm / sleep / auto-unmute by its id (from list_timers). For an auto_unmute it ALSO immediately un-mutes the target.",
      parameters: {
        type: "object",
        properties: { timer_id: { type: "string" } },
        required: ["timer_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_ai_model",
      description:
        "ADMIN DEBUG ONLY. Returns the actual provider/model that produced the most recent AI replies. Use this when an admin asks 'ตอนนี้ใช้โมเดลอะไร / what AI model are you using right now'. Do NOT use this to brag about being GPT/Gemini in conversation — only call it when the admin asks specifically.",
      parameters: { type: "object", properties: {} },
    },
  },

  // ─── Web / Internet tools (OpenClaw-inspired) ───────────────────────────
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the internet using DuckDuckGo. Use this whenever the admin or user asks about news, facts, current events, prices, or anything that needs up-to-date web information. Returns titles, URLs, and snippets. No API key needed.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query in Thai or English" },
          max_results: { type: "number", description: "Max results to return (1-8, default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch and read the text content of any URL (news article, website, blog post, documentation, etc). Use this to get the full content of a link. Strips HTML tags and returns readable text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL starting with https://" },
          max_chars: { type: "number", description: "Max characters to return (default 3000, max 8000)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wikipedia",
      description:
        "Look up a topic on Wikipedia and return a short summary. Use for quick facts, definitions, history, people, places. Tries Thai Wikipedia first, falls back to English.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic or concept to look up" },
          lang: { type: "string", description: "Language code: 'th' (default) or 'en'" },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get current weather for any city in the world. Free, no API key. Use when someone asks about weather, temperature, rain, etc.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name in Thai or English, e.g. 'กรุงเทพ', 'Bangkok', 'Tokyo'" },
        },
        required: ["city"],
      },
    },
  },

  // ─── Discord extended tools ──────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "send_dm",
      description: "Send a private Direct Message to a user. Use only when the admin explicitly asks to DM someone.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          message: { type: "string", description: "Message content to send" },
        },
        required: ["user_id", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_thread",
      description: "Create a public thread on a message in a text channel. Useful for organizing discussions.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          message_id: { type: "string", description: "Message ID to attach the thread to (optional)" },
          name: { type: "string", description: "Thread name" },
          auto_archive_minutes: { type: "number", description: "Archive after N minutes of inactivity: 60, 1440 (1d), 4320 (3d), 10080 (7d)" },
        },
        required: ["channel_id", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_slowmode",
      description: "Set the slowmode cooldown on a text channel. 0 = disabled. Max 21600 seconds (6h).",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          seconds: { type: "number", description: "Slowmode delay in seconds (0 to disable)" },
        },
        required: ["channel_id", "seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_channel",
      description: "Lock or unlock a text channel so regular members cannot send messages. Useful for cooling down heated discussions.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          lock: { type: "boolean", description: "true = lock, false = unlock" },
          reason: { type: "string" },
        },
        required: ["channel_id", "lock"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_server_info",
      description: "Get detailed info about the Discord server: member count, roles, boost level, channels, creation date.",
      parameters: { type: "object", properties: {} },
    },
  },

  // ─── OpenClaw: code execution ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Execute code in any programming language via a secure sandboxed runner. Returns stdout, stderr, exit code. " +
        "Supports: python, javascript, typescript, bash, php, ruby, go, rust, c, cpp, java, kotlin, csharp, and 70+ more. " +
        "Use when admin asks to 'รันโค้ด', 'เขียนสคริปต์', 'คำนวณ', 'ทดสอบโค้ด', or wants to execute any code.",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", description: "Language name: python, javascript, bash, go, rust, php, ruby, cpp, java, etc." },
          code: { type: "string", description: "Full source code to execute" },
          stdin: { type: "string", description: "Optional stdin input to pass to the program" },
        },
        required: ["language", "code"],
      },
    },
  },

  // ─── OpenClaw: web deployment ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "deploy_webpage",
      description:
        "Deploy an HTML/CSS/JS webpage and return a live preview URL. " +
        "Creates a public GitHub Gist and returns an htmlpreview.github.io link anyone can open. " +
        "Use when admin asks to 'ทำเว็บ', 'สร้าง HTML', 'อัพขึ้น', 'ส่ง URL', 'deploy หน้าเว็บ'. " +
        "Always write complete, beautiful, standalone HTML (include CSS+JS inline). " +
        "Use modern design: gradient backgrounds, smooth animations, responsive layout.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename, e.g. 'dashboard.html' or 'landing.html'" },
          html: { type: "string", description: "Full HTML content (include all CSS and JS inline in the file)" },
          description: { type: "string", description: "Short description of the page (used as Gist description)" },
        },
        required: ["filename", "html"],
      },
    },
  },

  // ─── OpenClaw: self-awareness / self-healing ──────────────────────────────
  {
    type: "function",
    function: {
      name: "read_own_log",
      description:
        "Read recent GitHub Actions workflow logs for the bot's own running job. " +
        "Use to debug errors, check bot status, or diagnose issues. " +
        "Triggered by: 'ดู log', 'มีบัคอะไร', 'เกิดอะไรขึ้น', 'bot crash', 'check ระบบ'.",
      parameters: {
        type: "object",
        properties: {
          lines: { type: "number", description: "Max log lines to return (default 100, max 300)" },
          filter: { type: "string", description: "Optional keyword to filter log lines (e.g. 'ERROR', 'warn', '[agent]')" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_own_source",
      description:
        "Read a source file from the bot's own GitHub repo. Use BEFORE making any code change. " +
        "Triggered by: 'ดูซอร์สโค้ด', 'โครงสร้างระบบ', 'อยากรู้ว่า X ทำงานยังไง', 'แก้บัค X'.",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "Path relative to repo root, e.g. 'bot/src/agent.js', 'bot/src/index.js', 'bot/package.json'" },
        },
        required: ["filepath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_own_source",
      description:
        "Write/patch a source file in the bot's GitHub repo and trigger an automatic redeploy. " +
        "ALWAYS read_own_source first to understand the existing code. " +
        "Only allowed for bot/src/* files. Never modify workflow files. " +
        "Use for self-healing: 'แก้บัค', 'fix', 'patch', 'อัพเดตตัวเอง'.",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "File path: must start with 'bot/src/' — e.g. 'bot/src/tools_web.js'" },
          content: { type: "string", description: "Complete new file content (not a diff — full file)" },
          commit_message: { type: "string", description: "Git commit message, e.g. 'fix(agent): handle null reply edge case'" },
        },
        required: ["filepath", "content", "commit_message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_audit_log",
      description: "ดูประวัติ action ของคนในเซิฟเวอร์ (kick, ban, ลบข้อความ, แก้ channel, เปลี่ยน role ฯลฯ)",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "จำนวน entries (default 20, max 100)" },
          action: { type: "string", description: "kick | ban | unban | channel_create | channel_delete | channel_update | message_delete | member_update | role_create | role_delete | invite_create" },
          user_id: { type: "string", description: "Filter by executor user ID (optional)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_channel",
      description: "สร้าง text หรือ voice channel ใน Discord server",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "ชื่อ channel (ใส่ emoji ได้ เช่น 💬┃general)" },
          type: { type: "string", description: "text | voice (default: text)" },
          category_name: { type: "string", description: "ชื่อ category ที่จะใส่ (fuzzy match, optional)" },
          topic: { type: "string", description: "Topic / คำอธิบาย channel" },
          nsfw: { type: "boolean" },
          slowmode: { type: "number", description: "Slowmode วินาที (0 = ปิด)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_channel",
      description: "แก้ไข channel (ชื่อ, topic, slowmode, nsfw)",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          name: { type: "string" },
          topic: { type: "string" },
          slowmode: { type: "number", description: "Slowmode วินาที" },
          nsfw: { type: "boolean" },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_channel",
      description: "ลบ channel ออกจาก server",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["channel_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_category",
      description: "สร้าง category (folder) ใน Discord server",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          position: { type: "number", description: "Position (0 = top)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rebuild_server",
      description: "จัดระเบียบ Discord server ใหม่ให้สวยงาม สร้าง categories + channels ตาม theme ที่เลือก",
      parameters: {
        type: "object",
        properties: {
          theme: { type: "string", description: "gaming | community | professional | anime | minimal" },
          dry_run: { type: "boolean", description: "true = แสดงแผนแต่ไม่สร้างจริง" },
        },
        required: ["theme"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "สร้างไฟล์ (txt, csv, json, html, md, py, js ฯลฯ) และส่งเป็น attachment ใน Discord",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "ชื่อไฟล์พร้อมนามสกุล เช่น report.txt, data.csv" },
          content: { type: "string", description: "เนื้อหาของไฟล์ทั้งหมด" },
          channel_id: { type: "string", description: "Channel ID ที่จะส่ง (optional)" },
          message: { type: "string", description: "ข้อความประกอบ" },
        },
        required: ["filename", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_excel",
      description: "สร้างไฟล์ Excel (.xlsx) จากข้อมูลที่ระบุ แล้วส่งเป็น attachment ใน Discord",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "ชื่อไฟล์ เช่น report.xlsx" },
          sheets: {
            type: "array",
            description: "Array ของ sheet [{name, data}] โดย data คือ 2D array (rows × cols)",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                data: { type: "array", description: "[[header1, header2], [row1col1, row1col2], ...]" },
              },
            },
          },
          channel_id: { type: "string" },
        },
        required: ["filename", "sheets"],
      },
    },
  },

  // ─── OpenClaw v2: Screenshot, Web Inspect, Computer Mode, Shell ──────────
  {
    type: "function",
    function: {
      name: "screenshot_url",
      description:
        "ถ่ายภาพ screenshot ของเว็บไซต์หรือ URL ใดก็ได้ และส่งเป็น รูปภาพ ใน Discord ทันที ใช้สำหรับดูหน้าเว็บ ตรวจสอบ design หรือยืนยัน layout",
      parameters: {
        type: "object",
        properties: {
          url:       { type: "string", description: "URL ที่ต้องการ screenshot (ต้องขึ้นต้นด้วย https://)" },
          width:     { type: "number", description: "ความกว้าง viewport ในหน่วย px (default 1280)" },
          height:    { type: "number", description: "ความสูง viewport ในหน่วย px (default 800)" },
          full_page: { type: "boolean", description: "true = screenshot เต็มหน้า (scroll ยาว)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_webpage",
      description:
        "วิเคราะห์โครงสร้างเว็บไซต์แบบลึก: title, meta tags, headings (h1-h3), links (internal/external), forms, tech stack, word count, body preview. ดีกว่า fetch_url สำหรับงาน SEO / audit / reverse-engineer หน้าเว็บ",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL ที่ต้องการ inspect" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_website",
      description:
        "ตรวจสอบสถานะเว็บไซต์: up/down, response time, HTTP status, redirect chain, SSL, server headers. ใช้สำหรับ uptime check หรือ debug ว่าเว็บมีปัญหาอะไร",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL หรือ domain เช่น 'google.com' หรือ 'https://example.com'" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_browse",
      description:
        "Computer mode — ควบคุม browser จริง (headless Chrome) บน GitHub Actions: เปิด URL, คลิก element, พิมพ์ข้อความ, run JavaScript, scroll, กรอก form และส่ง screenshot แต่ละขั้นเป็นรูปภาพใน Discord ทำให้เห็น 'AI ทำอะไรบนหน้าจอ' แบบ real-time",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL เริ่มต้น" },
          actions: {
            type: "array",
            description: "ลำดับ action ที่ต้องการทำ (ถ้าไม่ระบุจะ screenshot URL เลย)",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  description: "screenshot | click | type | fill_form | eval | goto | wait | scroll | get_text | hover | select | press",
                },
                selector: { type: "string", description: "CSS selector สำหรับ click/type/get_text/hover/select" },
                text:     { type: "string", description: "ข้อความที่จะพิมพ์ (สำหรับ type)" },
                js:       { type: "string", description: "JavaScript ที่จะ run (สำหรับ eval)" },
                url:      { type: "string", description: "URL ที่จะไป (สำหรับ goto)" },
                ms:       { type: "number", description: "มิลลิวินาทีที่จะรอ (สำหรับ wait)" },
                x:        { type: "number", description: "scroll horizontal px" },
                y:        { type: "number", description: "scroll vertical px" },
                key:      { type: "string", description: "keyboard key เช่น Enter, Tab, Escape (สำหรับ press)" },
                value:    { type: "string", description: "value สำหรับ <select> element" },
                data:     {
                  type: "array",
                  description: "สำหรับ fill_form: [{selector, value}, ...]",
                  items: {
                    type: "object",
                    properties: {
                      selector: { type: "string" },
                      value:    { type: "string" },
                    },
                  },
                },
                fullPage: { type: "boolean", description: "screenshot เต็มหน้าหรือเปล่า" },
              },
              required: ["type"],
            },
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_exec",
      description:
        "รัน shell command บน GitHub Actions environment (Ubuntu Linux) ได้เลย เช่น: curl, wget, python3, node, jq, git, apt-get install, ffmpeg, convert ฯลฯ ผลลัพธ์ stdout/stderr จะถูกส่งกลับ ใช้สำหรับ: ดาวน์โหลดไฟล์, ประมวลผล data, install tools, ตรวจสอบ system",
      parameters: {
        type: "object",
        properties: {
          command:    { type: "string", description: "Shell command ที่ต้องการรัน" },
          timeout_ms: { type: "number", description: "timeout ในมิลลิวินาที (default 30000, max 60000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_local_file",
      description:
        "อ่านไฟล์จาก filesystem ของ GitHub Actions environment เช่น /tmp/output.txt หรือไฟล์ที่ shell_exec สร้างไว้",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "Path ของไฟล์ เช่น /tmp/data.json หรือ /tmp/result.txt" },
        },
        required: ["filepath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_local_file",
      description:
        "เขียนไฟล์ไปยัง /tmp บน GitHub Actions — ใช้สร้างไฟล์ temp สำหรับ shell_exec หรือส่งเป็น attachment ใน Discord ด้วย create_file",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "Path ไฟล์ (ต้องอยู่ใน /tmp เช่น /tmp/data.csv)" },
          content:  { type: "string", description: "เนื้อหาของไฟล์" },
        },
        required: ["filepath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_local_files",
      description: "แสดงรายการไฟล์และโฟลเดอร์ใน path ที่ระบุ (default: /tmp)",
      parameters: {
        type: "object",
        properties: {
          dirpath: { type: "string", description: "Directory path เช่น /tmp หรือ . (default: /tmp)" },
        },
      },
    },
  },
];

// ===== Resolution helpers =====
function normalize(s) {
  return (s || "").toLowerCase().trim();
}

async function fuzzyFindMembers(guild, query) {
  const q = normalize(query);
  if (!q) return [];
  const members = await guild.members.fetch();
  const scored = [];
  for (const m of members.values()) {
    if (m.user.bot) continue;
    const dn = normalize(m.displayName);
    const un = normalize(m.user.username);
    const gn = normalize(m.user.globalName || "");
    let score = 0;
    if (dn === q || un === q || gn === q) score = 100;
    else if (dn.startsWith(q) || un.startsWith(q) || gn.startsWith(q)) score = 80;
    else if (dn.includes(q) || un.includes(q) || gn.includes(q)) score = 60;
    if (score) scored.push({ score, member: m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((x) => x.member);
}

async function fuzzyFindChannels(guild, query, kind = "any") {
  const q = normalize(query);
  if (!q) return [];
  const all = await guild.channels.fetch();
  const matches = [];
  for (const c of all.values()) {
    if (!c) continue;
    const isText = c.type === ChannelType.GuildText;
    const isVoice = c.type === ChannelType.GuildVoice;
    if (!isText && !isVoice) continue;
    if (kind === "text" && !isText) continue;
    if (kind === "voice" && !isVoice) continue;
    const cn = normalize(c.name);
    let score = 0;
    if (cn === q) score = 100;
    else if (cn.startsWith(q)) score = 80;
    else if (cn.includes(q)) score = 60;
    if (score) matches.push({ score, channel: c });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5).map((x) => ({
    id: x.channel.id,
    name: x.channel.name,
    type: x.channel.type === ChannelType.GuildVoice ? "voice" : "text",
  }));
}

// ===== Batch target resolution =====
// Used by voice_*_many tools. Always excludes the bot itself. When scope is
// "all_except_me", also excludes the requesting admin (authorId).
async function resolveBatchTargets(args, ctx) {
  const { guild, authorId } = ctx;
  let targets = [];

  if (Array.isArray(args.user_ids) && args.user_ids.length) {
    targets = [...args.user_ids];
  } else if (args.scope) {
    let channel = null;
    if (args.scope === "all_in_channel") {
      if (args.channel_id) channel = await guild.channels.fetch(args.channel_id);
    } else if (args.scope === "all_in_my_channel" || args.scope === "all_except_me") {
      let chId = null;
      if (authorId) {
        try {
          const adminMember = await guild.members.fetch(authorId);
          chId = adminMember?.voice?.channelId || null;
        } catch {}
      }
      // Fallback: the channel the bot itself is currently sitting in
      if (!chId) {
        const me = guild.members.me;
        chId = me?.voice?.channelId || null;
      }
      if (chId) channel = await guild.channels.fetch(chId);
    } else if (args.scope === "all_in_voice") {
      const allChans = await guild.channels.fetch();
      for (const c of allChans.values()) {
        if (c?.type === ChannelType.GuildVoice) {
          for (const m of c.members.values()) targets.push(m.id);
        }
      }
    }
    if (channel && channel.type === ChannelType.GuildVoice) {
      for (const m of channel.members.values()) targets.push(m.id);
    }
  }

  const exclude = new Set(args.exclude_user_ids || []);
  if (args.scope === "all_except_me" && authorId) exclude.add(authorId);
  // Always exclude the bot itself — never mute/move/disconnect ourselves
  const botId = guild.client?.user?.id;
  if (botId) exclude.add(botId);

  return [...new Set(targets)].filter((id) => !exclude.has(id));
}

function summarizeBatch(results, verb) {
  const ok = [];
  const skipped = [];
  const failed = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      const v = r.value || {};
      if (v.ok) ok.push(v.name || v.id);
      else if (v.skipped) skipped.push(`${v.name || v.id} (${v.skipped})`);
      else failed.push(v.name || v.id || "unknown");
    } else {
      failed.push(r.reason?.message || String(r.reason).slice(0, 80));
    }
  }
  return { verb, total: results.length, success: ok.length, names: ok, skipped, failed };
}

// ===== Tool execution =====
async function execTool(name, args, ctx) {
  const { guild, channel, offenses, persistOffenses, authorId } = ctx;

  // ZERO guardrails by explicit user request — the bot now does WHATEVER
  // the admin asks, including (if asked) muting / banning the admin
  // themselves. The admin is in charge; their own typos are their own
  // problem. The only ceiling is what Discord's own API enforces (role
  // hierarchy, missing perms, etc.), and those errors will surface
  // naturally to the agent so it can explain them.

  switch (name) {
    case "resolve_user": {
      const found = await fuzzyFindMembers(guild, args.query);
      return {
        candidates: found.map((m) => ({
          user_id: m.id,
          display_name: m.displayName,
          username: m.user.username,
          is_admin: m.permissions.has(PermissionFlagsBits.Administrator),
          in_voice: !!m.voice?.channelId,
          voice_channel_id: m.voice?.channelId || null,
        })),
      };
    }
    case "resolve_channel":
      return { candidates: await fuzzyFindChannels(guild, args.query, args.kind || "any") };

    case "voice_mute": {
      const m = await guild.members.fetch(args.user_id);
      if (!m.voice?.channelId) return { error: "user is not in a voice channel" };
      await m.voice.setMute(true, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "voice_unmute": {
      const m = await guild.members.fetch(args.user_id);
      await m.voice.setMute(false, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "voice_deafen": {
      const m = await guild.members.fetch(args.user_id);
      if (!m.voice?.channelId) return { error: "user is not in a voice channel" };
      await m.voice.setDeaf(true, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "voice_undeafen": {
      const m = await guild.members.fetch(args.user_id);
      await m.voice.setDeaf(false, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "voice_disconnect": {
      const m = await guild.members.fetch(args.user_id);
      if (!m.voice?.channelId) return { error: "user is not in a voice channel" };
      await m.voice.disconnect(args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "voice_move": {
      const m = await guild.members.fetch(args.user_id);
      await m.voice.setChannel(args.channel_id, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName, channel_id: args.channel_id };
    }

    // ===== BATCH voice tools =====
    case "voice_mute_many": {
      const ids = await resolveBatchTargets(args, ctx);
      if (!ids.length) return { error: "no targets resolved (empty channel or all excluded)" };
      const reason = args.reason || "Alxcer Guard agent (batch)";
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const m = await guild.members.fetch(id);
          if (!m.voice?.channelId) return { id, name: m.displayName, skipped: "not in voice" };
          if (m.voice.serverMute) return { id, name: m.displayName, skipped: "already muted" };
          await m.voice.setMute(true, reason);
          return { id, name: m.displayName, ok: true };
        }),
      );
      return summarizeBatch(results, "muted");
    }
    case "voice_unmute_many": {
      const ids = await resolveBatchTargets(args, ctx);
      if (!ids.length) return { error: "no targets resolved" };
      const reason = args.reason || "Alxcer Guard agent (batch)";
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const m = await guild.members.fetch(id);
          if (!m.voice?.channelId) return { id, name: m.displayName, skipped: "not in voice" };
          if (!m.voice.serverMute) return { id, name: m.displayName, skipped: "not muted" };
          await m.voice.setMute(false, reason);
          return { id, name: m.displayName, ok: true };
        }),
      );
      return summarizeBatch(results, "unmuted");
    }
    case "voice_deafen_many": {
      const ids = await resolveBatchTargets(args, ctx);
      if (!ids.length) return { error: "no targets resolved" };
      const reason = args.reason || "Alxcer Guard agent (batch)";
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const m = await guild.members.fetch(id);
          if (!m.voice?.channelId) return { id, name: m.displayName, skipped: "not in voice" };
          if (m.voice.serverDeaf) return { id, name: m.displayName, skipped: "already deafened" };
          await m.voice.setDeaf(true, reason);
          return { id, name: m.displayName, ok: true };
        }),
      );
      return summarizeBatch(results, "deafened");
    }
    case "voice_undeafen_many": {
      const ids = await resolveBatchTargets(args, ctx);
      if (!ids.length) return { error: "no targets resolved" };
      const reason = args.reason || "Alxcer Guard agent (batch)";
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const m = await guild.members.fetch(id);
          if (!m.voice?.channelId) return { id, name: m.displayName, skipped: "not in voice" };
          if (!m.voice.serverDeaf) return { id, name: m.displayName, skipped: "not deafened" };
          await m.voice.setDeaf(false, reason);
          return { id, name: m.displayName, ok: true };
        }),
      );
      return summarizeBatch(results, "undeafened");
    }
    case "voice_disconnect_many": {
      const ids = await resolveBatchTargets(args, ctx);
      if (!ids.length) return { error: "no targets resolved" };
      const reason = args.reason || "Alxcer Guard agent (batch)";
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const m = await guild.members.fetch(id);
          if (!m.voice?.channelId) return { id, name: m.displayName, skipped: "not in voice" };
          await m.voice.disconnect(reason);
          return { id, name: m.displayName, ok: true };
        }),
      );
      return summarizeBatch(results, "disconnected");
    }
    case "voice_move_many": {
      if (!args.target_channel_id) return { error: "target_channel_id required" };
      const ids = await resolveBatchTargets(args, ctx);
      if (!ids.length) return { error: "no targets resolved" };
      const reason = args.reason || "Alxcer Guard agent (batch)";
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const m = await guild.members.fetch(id);
          if (!m.voice?.channelId) return { id, name: m.displayName, skipped: "not in voice" };
          if (m.voice.channelId === args.target_channel_id)
            return { id, name: m.displayName, skipped: "already in target" };
          await m.voice.setChannel(args.target_channel_id, reason);
          return { id, name: m.displayName, ok: true };
        }),
      );
      return summarizeBatch(results, "moved");
    }

    case "list_voice_members": {
      const result = [];
      const channels = args.channel_id
        ? [await guild.channels.fetch(args.channel_id)]
        : [...(await guild.channels.fetch()).values()].filter(
            (c) => c?.type === ChannelType.GuildVoice
          );
      for (const c of channels) {
        if (!c || c.type !== ChannelType.GuildVoice) continue;
        result.push({
          channel_id: c.id,
          channel_name: c.name,
          members: c.members.map((m) => ({
            user_id: m.id,
            display_name: m.displayName,
            mute: !!m.voice?.serverMute,
            deaf: !!m.voice?.serverDeaf,
            self_mute: !!m.voice?.selfMute,
          })),
        });
      }
      return { voice_channels: result };
    }

    case "delete_message": {
      const ch = args.channel_id ? await guild.channels.fetch(args.channel_id) : channel;
      const msg = await ch.messages.fetch(args.message_id);
      await msg.delete();
      return { ok: true };
    }
    case "bulk_delete_messages": {
      const ch = args.channel_id ? await guild.channels.fetch(args.channel_id) : channel;
      const count = Math.max(1, Math.min(100, Number(args.count || 1)));
      const fetchLimit = args.from_user_id ? Math.min(100, count + 80) : count;
      let messages = await ch.messages.fetch({ limit: fetchLimit });
      if (args.from_user_id) {
        messages = messages.filter((m) => m.author.id === args.from_user_id);
      }
      const toDelete = [...messages.values()].slice(0, count);
      const deleted = await ch.bulkDelete(toDelete, true);
      return { ok: true, deleted: deleted.size };
    }
    case "timeout_user": {
      const m = await guild.members.fetch(args.user_id);
      const sec = Math.max(1, Math.min(2419200, Number(args.seconds || 60)));
      await m.timeout(sec * 1000, args.reason || "Alxcer Guard agent");
      return { ok: true, applied_seconds: sec, user: m.displayName };
    }
    case "untimeout_user": {
      const m = await guild.members.fetch(args.user_id);
      await m.timeout(null, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "kick_user": {
      const m = await guild.members.fetch(args.user_id);
      await m.kick(args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "ban_user": {
      const days = Math.max(0, Math.min(7, Number(args.delete_message_days || 0)));
      await guild.members.ban(args.user_id, {
        deleteMessageSeconds: days * 86400,
        reason: args.reason || "Alxcer Guard agent",
      });
      return { ok: true };
    }
    case "unban_user": {
      await guild.bans.remove(args.user_id, args.reason || "Alxcer Guard agent");
      return { ok: true };
    }

    case "set_nickname": {
      const m = await guild.members.fetch(args.user_id);
      await m.setNickname(args.nickname || null, args.reason || "Alxcer Guard agent");
      return { ok: true, user: m.displayName };
    }
    case "add_role": {
      const m = await guild.members.fetch(args.user_id);
      await m.roles.add(args.role_id, args.reason || "Alxcer Guard agent");
      return { ok: true };
    }
    case "remove_role": {
      const m = await guild.members.fetch(args.user_id);
      await m.roles.remove(args.role_id, args.reason || "Alxcer Guard agent");
      return { ok: true };
    }
    case "list_roles": {
      const roles = await guild.roles.fetch();
      return {
        roles: [...roles.values()]
          .filter((r) => r.name !== "@everyone")
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }))
          .slice(0, 80),
      };
    }

    case "send_message": {
      const target = args.channel_id ? await guild.channels.fetch(args.channel_id) : channel;
      const sent = await target.send((args.content || "").slice(0, 2000));
      return { ok: true, message_id: sent.id, channel_id: target.id };
    }
    case "pin_message": {
      const ch = args.channel_id ? await guild.channels.fetch(args.channel_id) : channel;
      const msg = await ch.messages.fetch(args.message_id);
      await msg.pin();
      return { ok: true };
    }
    case "unpin_message": {
      const ch = args.channel_id ? await guild.channels.fetch(args.channel_id) : channel;
      const msg = await ch.messages.fetch(args.message_id);
      await msg.unpin();
      return { ok: true };
    }
    case "list_channels": {
      const chans = [...(await guild.channels.fetch()).values()]
        .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice))
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type === ChannelType.GuildVoice ? "voice" : "text",
        }));
      return { channels: chans.slice(0, 80) };
    }
    case "list_members": {
      const members = await guild.members.fetch();
      return {
        members: [...members.values()]
          .filter((m) => !m.user.bot)
          .map((m) => ({
            id: m.id,
            name: m.displayName,
            isAdmin: m.permissions.has(PermissionFlagsBits.Administrator),
            in_voice: !!m.voice?.channelId,
          }))
          .slice(0, 100),
      };
    }
    case "get_recent_messages": {
      const target = await guild.channels.fetch(args.channel_id);
      const limit = Math.max(1, Math.min(50, Number(args.limit || 20)));
      const msgs = await target.messages.fetch({ limit });
      return {
        messages: [...msgs.values()]
          .map((m) => ({
            id: m.id,
            author: m.author.username,
            author_id: m.author.id,
            content: m.content.slice(0, 500),
            at: m.createdTimestamp,
          }))
          .reverse(),
      };
    }
    case "get_user_offenses": {
      const rec = offenses.users?.[args.user_id];
      let displayName = args.user_id;
      try {
        const m = await guild.members.fetch(args.user_id);
        displayName = m.displayName;
      } catch {}
      return {
        user_id: args.user_id,
        display_name: displayName,
        voice_offenses: rec?.times || 0,
        last_voice_word: rec?.lastWord || null,
        chat_offense_count: rec?.chat?.count || 0,
        chat_history: (rec?.chat?.history || []).slice(-10),
      };
    }
    case "get_recent_offenses": {
      const limit = Math.max(1, Math.min(30, Number(args.limit || 10)));
      const events = [];
      const users = offenses.users || {};
      for (const [uid, rec] of Object.entries(users)) {
        const history = rec?.chat?.history || [];
        for (const h of history) {
          events.push({
            user_id: uid,
            at: h.at,
            severity: h.severity,
            matched: h.matched,
            reason: h.reason,
            excerpt: (h.excerpt || "").slice(0, 120),
            action: h.action,
            source: h.source,
          });
        }
        if (rec?.lastOffenseAt && rec.lastSource === "voice") {
          events.push({
            user_id: uid,
            at: rec.lastOffenseAt,
            matched: rec.lastWord,
            source: "voice",
            reason: "voice offense",
          });
        }
      }
      events.sort((a, b) => (b.at || 0) - (a.at || 0));
      const top = events.slice(0, limit);
      // Resolve display names for the top events
      for (const e of top) {
        try {
          const m = await guild.members.fetch(e.user_id);
          e.display_name = m.displayName;
        } catch {
          e.display_name = e.user_id;
        }
      }
      return { recent_offenses: top };
    }
    case "clear_user_offenses": {
      if (offenses.users?.[args.user_id]) {
        if (offenses.users[args.user_id].chat) {
          offenses.users[args.user_id].chat = { count: 0, lastAt: 0, history: [] };
        }
        offenses.users[args.user_id].times = 0;
        await persistOffenses();
      }
      return { ok: true };
    }

    // ===== Timer / alarm / sleep / mute-for tools =====
    case "set_timer": {
      let parsed;
      try {
        parsed = parseDurationToFireAt({ seconds: args.seconds, minutes: args.minutes, hours: args.hours });
      } catch (e) {
        return { error: e.message };
      }
      const t = createTimer({
        type: "timer",
        fireAt: parsed.fireAt,
        label: args.label || "Timer",
        guildId: ctx.guild.id,
        channelId: ctx.channel?.id || null,
        userId: ctx.authorId || null,
        mentionUserId: args.mention_user_id || ctx.authorId || null,
        ownerId: ctx.authorId || null,
      });
      return {
        ok: true,
        timer_id: t.id,
        fires_at_bangkok: formatClockBangkok(t.fireAt),
        in: formatDurationShort(parsed.totalSeconds),
        label: t.label,
      };
    }
    case "set_alarm": {
      let parsed;
      try {
        parsed = alarmAtToFireAt({ hour: args.hour, minute: args.minute, second: args.second });
      } catch (e) {
        return { error: e.message };
      }
      const targetUserId = args.mention_user_id || ctx.authorId || null;
      const t = createTimer({
        type: args.play_wake_music ? "wake_alarm" : "alarm",
        fireAt: parsed.fireAt,
        label: args.label || "Alarm",
        guildId: ctx.guild.id,
        channelId: ctx.channel?.id || null,
        userId: targetUserId,
        mentionUserId: targetUserId,
        ownerId: ctx.authorId || null,
        payload: { play_wake_music: !!args.play_wake_music },
      });
      return {
        ok: true,
        timer_id: t.id,
        fires_at_bangkok: formatClockBangkok(t.fireAt),
        in: formatDurationShort(parsed.totalSeconds),
        wake_music: !!args.play_wake_music,
        label: t.label,
      };
    }
    case "set_self_disconnect": {
      let parsed;
      try {
        parsed = parseDurationToFireAt({ seconds: args.seconds, minutes: args.minutes, hours: args.hours });
      } catch (e) {
        return { error: e.message };
      }
      const targetUserId = args.user_id || ctx.authorId || null;
      if (!targetUserId) return { error: "no target user" };
      // Verify the user exists in this guild
      let member;
      try {
        member = await ctx.guild.members.fetch(targetUserId);
      } catch {
        return { error: "user not found in this server" };
      }
      const t = createTimer({
        type: "sleep_disconnect",
        fireAt: parsed.fireAt,
        label: args.label || "Sleep mode",
        guildId: ctx.guild.id,
        channelId: ctx.channel?.id || null,
        userId: targetUserId,
        mentionUserId: targetUserId,
        ownerId: ctx.authorId || null,
        payload: { displayName: member.displayName },
      });
      return {
        ok: true,
        timer_id: t.id,
        target_name: member.displayName,
        in: formatDurationShort(parsed.totalSeconds),
      };
    }
    case "mute_user_for": {
      let parsed;
      try {
        parsed = parseDurationToFireAt({ seconds: args.seconds, minutes: args.minutes, hours: args.hours });
      } catch (e) {
        return { error: e.message };
      }
      let member;
      try {
        member = await ctx.guild.members.fetch(args.user_id);
      } catch {
        return { error: "user not found" };
      }
      if (!member.voice?.channel) {
        return { error: `${member.displayName} ไม่ได้อยู่ในห้องเสียงตอนนี้` };
      }
      try {
        await member.voice.setMute(true, args.reason || `mute_user_for ${parsed.totalSeconds}s`);
      } catch (e) {
        return { error: `mute failed: ${e?.message || "unknown"}` };
      }
      const t = createTimer({
        type: "auto_unmute",
        fireAt: parsed.fireAt,
        label: args.reason || "Auto-unmute",
        guildId: ctx.guild.id,
        channelId: ctx.channel?.id || null,
        userId: args.user_id,
        mentionUserId: args.user_id,
        ownerId: ctx.authorId || null,
        payload: { displayName: member.displayName, reason: args.reason || "" },
      });
      return {
        ok: true,
        timer_id: t.id,
        target_name: member.displayName,
        in: formatDurationShort(parsed.totalSeconds),
      };
    }
    case "list_timers": {
      const ts = listTimers({ guildId: ctx.guild.id, userId: args.user_id || undefined });
      const now = Date.now();
      return {
        count: ts.length,
        timers: ts.map((t) => ({
          id: t.id,
          type: t.type,
          label: t.label,
          fires_in: formatDurationShort(Math.max(0, Math.round((t.fireAt - now) / 1000))),
          fires_at_bangkok: formatClockBangkok(t.fireAt),
          target_user_id: t.userId || null,
          channel_id: t.channelId || null,
        })),
      };
    }
    case "cancel_timer": {
      const t = getTimer(args.timer_id);
      if (!t) return { error: "no such timer (it may have already fired or been cancelled)" };
      // Side-effect: if it's an auto-unmute, immediately un-mute the user
      if (t.type === "auto_unmute" && t.userId) {
        try {
          const member = await ctx.guild.members.fetch(t.userId);
          if (member?.voice?.channel) {
            await member.voice.setMute(false, "cancel_timer manual unmute");
          }
        } catch {}
      }
      const ok = cancelTimer(args.timer_id);
      return { ok, type: t.type, label: t.label };
    }
    case "get_current_ai_model": {
      const s = getModelStatus();
      return {
        provider_now: s.lastProvider,
        model_now: s.lastModel,
        last_task: s.lastTask,
        last_used_iso: s.lastAt ? new Date(s.lastAt).toISOString() : null,
        gemini_key_set: s.geminiAvailable,
        github_key_set: s.githubAvailable,
        openrouter_key_set: s.openrouterAvailable,
        top_used: s.top,
        note: "These are real model identifiers from the API call chain. You may share this with the admin who asked. NEVER say 'I am X' — say 'ตอนนี้ตัวที่ตอบคือ X (ผ่าน provider Y)'.",
      };
    }

    // ─── Web / Internet tools ─────────────────────────────────────────────
    case "web_search": {
      const maxR = Math.min(Math.max(args.max_results || 5, 1), 8);
      return webSearch(args.query, maxR);
    }

    case "fetch_url": {
      const maxC = Math.min(args.max_chars || 3000, 8000);
      return fetchUrl(args.url, maxC);
    }

    case "wikipedia": {
      return wikipediaLookup(args.topic, args.lang || "th");
    }

    case "get_weather": {
      return getWeather(args.city);
    }

    // ─── Discord extended tools ───────────────────────────────────────────
    case "send_dm": {
      const { user_id, message: dmMsg } = args;
      if (!user_id || !dmMsg) return { error: "user_id and message required" };
      try {
        const member = await ctx.guild.members.fetch(user_id);
        const dmChannel = await member.user.createDM();
        await dmChannel.send(dmMsg.slice(0, 2000));
        return { ok: true, sent_to: member.displayName };
      } catch (err) {
        return { error: err?.message || "DM failed" };
      }
    }

    case "create_thread": {
      const { channel_id: thCh, message_id: thMsg, name: thName, auto_archive_minutes } = args;
      if (!thCh || !thName) return { error: "channel_id and name required" };
      try {
        const channel = await ctx.guild.channels.fetch(thCh);
        if (!channel) return { error: "channel not found" };
        const validArchive = [60, 1440, 4320, 10080].includes(auto_archive_minutes) ? auto_archive_minutes : 1440;
        let thread;
        if (thMsg) {
          const msg = await channel.messages.fetch(thMsg);
          thread = await msg.startThread({ name: thName.slice(0, 100), autoArchiveDuration: validArchive });
        } else {
          thread = await channel.threads.create({ name: thName.slice(0, 100), autoArchiveDuration: validArchive });
        }
        return { ok: true, thread_id: thread.id, thread_name: thread.name, url: `https://discord.com/channels/${ctx.guild.id}/${thread.id}` };
      } catch (err) {
        return { error: err?.message || "create thread failed" };
      }
    }

    case "set_slowmode": {
      const { channel_id: slCh, seconds } = args;
      if (!slCh) return { error: "channel_id required" };
      const secs = Math.min(Math.max(seconds || 0, 0), 21600);
      try {
        const channel = await ctx.guild.channels.fetch(slCh);
        await channel.setRateLimitPerUser(secs);
        return { ok: true, channel: channel.name, slowmode_seconds: secs };
      } catch (err) {
        return { error: err?.message || "set slowmode failed" };
      }
    }

    case "lock_channel": {
      const { channel_id: lkCh, lock, reason: lkReason } = args;
      if (!lkCh) return { error: "channel_id required" };
      try {
        const channel = await ctx.guild.channels.fetch(lkCh);
        const everyone = ctx.guild.roles.everyone;
        await channel.permissionOverwrites.edit(everyone, { SendMessages: lock ? false : null }, { reason: lkReason });
        return { ok: true, channel: channel.name, locked: lock };
      } catch (err) {
        return { error: err?.message || "lock channel failed" };
      }
    }

    case "get_server_info": {
      try {
        const guild = ctx.guild;
        await guild.fetch();
        const roles = await guild.roles.fetch();
        const channels = await guild.channels.fetch();
        const textCh = channels.filter(c => c?.type === ChannelType.GuildText).size;
        const voiceCh = channels.filter(c => c?.type === ChannelType.GuildVoice).size;
        return {
          id: guild.id,
          name: guild.name,
          description: guild.description,
          owner_id: guild.ownerId,
          member_count: guild.memberCount,
          created_at: guild.createdAt?.toISOString(),
          boost_level: guild.premiumTier,
          boosts: guild.premiumSubscriptionCount,
          verification_level: guild.verificationLevel,
          text_channels: textCh,
          voice_channels: voiceCh,
          roles: roles.size,
          locale: guild.preferredLocale,
        };
      } catch (err) {
        return { error: err?.message || "get server info failed" };
      }
    }

    // ─── OpenClaw: code execution ─────────────────────────────────────────
    case "run_code": {
      return runCode(args.language, args.code, args.stdin || "");
    }

    // ─── OpenClaw: web deployment ─────────────────────────────────────────
    case "deploy_webpage": {
      const { filename, html, description: desc } = args;
      if (!filename || !html) return { error: "filename and html required" };
      return deployWebpage(filename, html, desc || "");
    }

    // ─── OpenClaw: self-awareness / self-healing ──────────────────────────
    case "read_own_log": {
      const maxLines = Math.min(Math.max(args.lines || 100, 10), 300);
      return readOwnLog(maxLines, args.filter || "");
    }

    case "read_own_source": {
      if (!args.filepath) return { error: "filepath required" };
      return readOwnSource(args.filepath);
    }

    case "write_own_source": {
      const { filepath, content, commit_message } = args;
      if (!filepath || !content) return { error: "filepath and content required" };
      return writeOwnSource(filepath, content, commit_message || "");
    }

    case "get_audit_log": {
      const auditLimit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const ACTION_MAP = {
        kick: 20, ban: 22, unban: 23,
        channel_create: 10, channel_update: 11, channel_delete: 12,
        message_delete: 72, member_update: 24,
        role_create: 30, role_delete: 32,
        invite_create: 40, invite_delete: 42,
        webhook_create: 50,
      };
      const fetchOpts = { limit: auditLimit };
      if (args.action && ACTION_MAP[args.action] !== undefined) fetchOpts.type = ACTION_MAP[args.action];
      if (args.user_id) {
        try { fetchOpts.user = await guild.members.fetch(args.user_id).then((m) => m.user); } catch {}
      }
      const auditLog = await guild.fetchAuditLogs(fetchOpts);
      const entries = [...auditLog.entries.values()].map((e) => ({
        action: e.actionType,
        executor: e.executor ? { id: e.executor.id, tag: e.executor.tag } : null,
        target: e.target
          ? { id: e.target.id ?? e.target, name: e.target.tag ?? e.target.name ?? String(e.target) }
          : null,
        reason: e.reason || null,
        time: new Date(e.createdTimestamp).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
        changes: (e.changes || []).slice(0, 6).map((c) => ({ key: c.key, from: c.old, to: c.new })),
      }));
      return { entries, count: entries.length };
    }

    case "create_channel": {
      const chType =
        (args.type || "text").toLowerCase() === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText;
      const createOpts = { name: args.name, type: chType };
      if (args.topic && chType === ChannelType.GuildText) createOpts.topic = args.topic;
      if (args.nsfw) createOpts.nsfw = true;
      if (args.slowmode !== undefined) createOpts.rateLimitPerUser = Number(args.slowmode);
      if (args.category_name) {
        const cats = await guild.channels.fetch();
        const cat = [...cats.values()].find(
          (c) => c?.type === ChannelType.GuildCategory &&
            c.name.toLowerCase().includes(args.category_name.toLowerCase()),
        );
        if (cat) createOpts.parent = cat.id;
      }
      const created = await guild.channels.create(createOpts);
      return { ok: true, channel_id: created.id, name: created.name, type: args.type || "text" };
    }

    case "edit_channel": {
      const editCh = await guild.channels.fetch(args.channel_id);
      if (!editCh) return { error: "channel not found" };
      const editData = {};
      if (args.name !== undefined) editData.name = args.name;
      if (args.topic !== undefined) editData.topic = args.topic;
      if (args.slowmode !== undefined) editData.rateLimitPerUser = Number(args.slowmode);
      if (args.nsfw !== undefined) editData.nsfw = Boolean(args.nsfw);
      await editCh.edit(editData);
      return { ok: true, channel_id: editCh.id, name: editCh.name };
    }

    case "delete_channel": {
      const delCh = await guild.channels.fetch(args.channel_id);
      if (!delCh) return { error: "channel not found" };
      const delName = delCh.name;
      await delCh.delete(args.reason || "Admin request");
      return { ok: true, deleted: delName };
    }

    case "create_category": {
      const newCat = await guild.channels.create({
        name: args.name,
        type: ChannelType.GuildCategory,
        ...(args.position !== undefined ? { position: Number(args.position) } : {}),
      });
      return { ok: true, category_id: newCat.id, name: newCat.name };
    }

    case "rebuild_server": {
      const THEMES = {
        gaming: [
          { cat: "📢 ประกาศ", chs: [
            { n: "📣┃announcements", t: "ประกาศสำคัญจากทีมแอดมิน" },
            { n: "📋┃กฎเซิฟ", t: "กฎกติกาของเซิฟเวอร์" },
            { n: "🎉┃events", t: "กิจกรรมพิเศษ" },
          ]},
          { cat: "💬 ทั่วไป", chs: [
            { n: "💬┃general", t: "คุยทั่วไปได้เลย" },
            { n: "🤖┃bot-commands", t: "สั่งบอทที่นี่" },
            { n: "😂┃memes", t: "มีม เฮฮา" },
            { n: "📷┃media", t: "รูปภาพ วิดีโอ" },
          ]},
          { cat: "🎮 Gaming", chs: [
            { n: "🎮┃gaming-chat", t: "คุยเรื่องเกมทุกอย่าง" },
            { n: "🏆┃achievements", t: "โชว์ความสำเร็จในเกม" },
            { n: "🎯┃lfg", t: "หาปาร์ตี้ หาคนเล่น" },
            { n: "🛒┃trading", t: "ซื้อขายของในเกม" },
          ]},
          { cat: "🔊 Voice Channels", chs: [
            { n: "🎮 Gaming Zone", v: true },
            { n: "🎵 Chill Zone", v: true },
            { n: "📞 Meeting Room", v: true },
            { n: "🎤 Karaoke", v: true },
          ]},
          { cat: "⚙️ Admin Zone", chs: [
            { n: "📋┃mod-log", t: "Log การ mod" },
            { n: "🔧┃admin-only", t: "สำหรับแอดมินเท่านั้น" },
          ]},
        ],
        community: [
          { cat: "📌 Information", chs: [
            { n: "👋┃welcome", t: "ยินดีต้อนรับ!" },
            { n: "📋┃rules", t: "กฎของเรา" },
            { n: "📢┃announcements", t: "ข่าวสาร อัปเดต" },
          ]},
          { cat: "💬 Community", chs: [
            { n: "👥┃introductions", t: "แนะนำตัว" },
            { n: "💬┃general", t: "คุยทุกเรื่อง" },
            { n: "💡┃ideas", t: "ไอเดีย ข้อเสนอแนะ" },
            { n: "🎨┃showcase", t: "โชว์ผลงาน" },
          ]},
          { cat: "🎵 Entertainment", chs: [
            { n: "🎵┃music", t: "แชร์เพลง" },
            { n: "📷┃photos", t: "รูปภาพสวยๆ" },
          ]},
          { cat: "🔊 Voice", chs: [
            { n: "🗣️ Community Lounge", v: true },
            { n: "🎵 Music Room", v: true },
            { n: "🎮 Gaming Room", v: true },
          ]},
        ],
        professional: [
          { cat: "📌 General", chs: [
            { n: "📢┃announcements", t: "ประกาศสำคัญ" },
            { n: "💬┃general", t: "พูดคุยทั่วไป" },
          ]},
          { cat: "💼 Workspace", chs: [
            { n: "📋┃projects", t: "อัปเดตสถานะโปรเจกต์" },
            { n: "💡┃brainstorm", t: "ระดมสมอง" },
            { n: "✅┃completed", t: "งานที่เสร็จแล้ว" },
            { n: "🐛┃bugs", t: "รายงาน bugs" },
          ]},
          { cat: "📞 Meeting Rooms", chs: [
            { n: "📞 Main Conference", v: true },
            { n: "🎧 Team Alpha", v: true },
            { n: "🎧 Team Beta", v: true },
          ]},
        ],
        anime: [
          { cat: "🌸 Welcome", chs: [
            { n: "🌸┃ยินดีต้อนรับ", t: "ようこそ！ยินดีต้อนรับ" },
            { n: "📋┃กฎ", t: "กฎกติกา" },
            { n: "📢┃ประกาศ", t: "ประกาศสำคัญ" },
          ]},
          { cat: "💬 ห้องคุย", chs: [
            { n: "💬┃ห้องทั่วไป", t: "คุยได้ทุกเรื่อง" },
            { n: "🎌┃อนิเมะ", t: "คุยเรื่องอนิเมะ" },
            { n: "📚┃มังงะ", t: "มังงะ ไลท์โนเวล" },
            { n: "🎮┃เกม", t: "เกมอนิเมะ gacha" },
            { n: "🖼️┃fanart", t: "แชร์ fanart สวยๆ" },
          ]},
          { cat: "🔊 Voice", chs: [
            { n: "🌸 Sakura Lounge", v: true },
            { n: "⚔️ Battle Room", v: true },
            { n: "🎵 Weeb Music", v: true },
          ]},
        ],
        minimal: [
          { cat: "general", chs: [{ n: "announcements" }, { n: "chat" }, { n: "bot" }]},
          { cat: "media", chs: [{ n: "photos" }, { n: "links" }]},
          { cat: "voice", chs: [{ n: "lounge", v: true }, { n: "work", v: true }]},
          { cat: "staff", chs: [{ n: "admin" }, { n: "logs" }]},
        ],
      };
      const plan = THEMES[(args.theme || "gaming").toLowerCase()] || THEMES.gaming;
      if (args.dry_run) {
        const preview = plan.map((p) =>
          "**" + p.cat + "**\n" + p.chs.map((c) => "  " + (c.v ? "🔊 " : "💬 ") + c.n).join("\n"),
        ).join("\n\n");
        return { dry_run: true, preview, total_channels: plan.reduce((s, p) => s + p.chs.length, 0) };
      }
      const result = { categories: [], channels: [] };
      for (const section of plan) {
        const catCh = await guild.channels.create({ name: section.cat, type: ChannelType.GuildCategory });
        result.categories.push(section.cat);
        for (const ch of section.chs) {
          await guild.channels.create({
            name: ch.n,
            type: ch.v ? ChannelType.GuildVoice : ChannelType.GuildText,
            parent: catCh.id,
            ...(ch.t ? { topic: ch.t } : {}),
          });
          result.channels.push(ch.n);
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      return { ok: true, theme: args.theme, ...result };
    }

    case "create_file": {
      const { AttachmentBuilder } = await import("discord.js");
      const targetCh = args.channel_id
        ? await guild.channels.fetch(args.channel_id).catch(() => channel)
        : channel;
      const buf = Buffer.from(args.content ?? "", "utf8");
      const att = new AttachmentBuilder(buf, { name: args.filename });
      const EXT_EMOJI = { txt: "📄", csv: "📊", json: "🗂️", html: "🌐", md: "📝", py: "🐍", js: "📜", ts: "📘", sh: "⚙️", sql: "🗄️" };
      const ext = (args.filename.split(".").pop() || "").toLowerCase();
      const emoji = EXT_EMOJI[ext] || "📎";
      await targetCh.send({ content: args.message || `${emoji} ไฟล์ **${args.filename}** ครับ`, files: [att] });
      return { ok: true, filename: args.filename, bytes: buf.length };
    }

    case "create_excel": {
      try {
        const XLSX = (await import("xlsx")).default;
        const wb = XLSX.utils.book_new();
        for (const sheet of args.sheets || []) {
          const ws = XLSX.utils.aoa_to_sheet(sheet.data || [[]]);
          XLSX.utils.book_append_sheet(wb, ws, (sheet.name || "Sheet1").slice(0, 31));
        }
        const rawBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
        const fname = args.filename.endsWith(".xlsx") ? args.filename : args.filename + ".xlsx";
        const { AttachmentBuilder } = await import("discord.js");
        const att = new AttachmentBuilder(buf, { name: fname });
        const targetCh = args.channel_id
          ? await guild.channels.fetch(args.channel_id).catch(() => channel)
          : channel;
        await targetCh.send({ content: `📊 Excel **${fname}** พร้อมแล้วครับ`, files: [att] });
        return { ok: true, filename: fname, sheets: (args.sheets || []).length };
      } catch (e) {
        return { error: `create_excel: ${e?.message}` };
      }
    }


    // ─── OpenClaw v2: Screenshot, Web Inspect, Computer Mode, Filesystem, Shell ──
    case "screenshot_url": {
      const result = await screenshotUrl(args.url, {
        width: args.width, height: args.height, fullPage: args.full_page,
      });
      if (result.imageBuffer) {
        const { AttachmentBuilder } = await import("discord.js");
        const att = new AttachmentBuilder(result.imageBuffer, { name: "screenshot.png" });
        const targetCh = ctx.msg?.channel || channel;
        if (targetCh) {
          await targetCh.send({
            content: `📸 **Screenshot:** ${args.url}\n> ${result.page_title || ""}\n${result.width}×${result.height}px`,
            files: [att],
          });
        }
        return { ok: true, preview_url: result.preview_url, width: result.width, height: result.height, page_title: result.page_title };
      }
      return result;
    }

    case "inspect_webpage": {
      return await inspectWebpage(args.url);
    }

    case "check_website": {
      return await checkWebsite(args.url);
    }

    case "computer_browse": {
      const result = await computerBrowse(args.url, args.actions || []);
      if (result.ok && result.steps) {
        const { AttachmentBuilder } = await import("discord.js");
        const targetCh = ctx.msg?.channel || channel;
        let shotNum = 0;
        for (const step of result.steps) {
          if (step.imageBuffer && targetCh) {
            shotNum++;
            const att = new AttachmentBuilder(step.imageBuffer, { name: `computer_${shotNum}.png` });
            const label = step.type === "auto_screenshot"
              ? `🖥️ หน้าจอปัจจุบัน`
              : step.type === "click"   ? `🖱️ คลิก ${step.selector}`
              : step.type === "scroll"  ? `📜 Scroll แล้ว`
              : step.type === "goto"    ? `🔗 ไปที่ ${step.url}`
              : step.type === "fill_form" ? `📝 กรอก form แล้ว`
              : step.type === "hover"   ? `👆 Hover ${step.selector}`
              : step.type === "press"   ? `⌨️ กด ${step.key}`
              : `📷 Step ${shotNum}`;
            await targetCh.send({ content: label, files: [att] });
          }
        }
        // Return results without bulky buffers
        return {
          ok: true,
          final_url: result.final_url,
          steps: result.steps.map(s => {
            const { imageBuffer, ...rest } = s;
            return { ...rest, screenshot_sent: !!imageBuffer };
          }),
        };
      }
      return result;
    }

    case "shell_exec": {
      return await shellExec(args.command, { timeout_ms: args.timeout_ms });
    }

    case "read_local_file": {
      return await readLocalFile(args.filepath);
    }

    case "write_local_file": {
      return await writeLocalFile(args.filepath, args.content);
    }

    case "list_local_files": {
      return await listLocalFiles(args.dirpath || "/tmp");
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}

// Build a compact server snapshot so the agent doesn't always need to call
// list_* first. Keeps the first turn to a single LLM call for simple commands.
async function buildServerSnapshot(guild) {
  try {
    const channels = await guild.channels.fetch();
    const voiceChannels = [];
    const textChannels = [];
    for (const c of channels.values()) {
      if (!c) continue;
      if (c.type === ChannelType.GuildVoice) {
        voiceChannels.push({
          id: c.id,
          name: c.name,
          members: c.members.map((m) => ({
            user_id: m.id,
            name: m.displayName,
            mute: !!m.voice?.serverMute,
          })),
        });
      } else if (c.type === ChannelType.GuildText) {
        textChannels.push({ id: c.id, name: c.name });
      }
    }
    return {
      guild: { id: guild.id, name: guild.name, member_count: guild.memberCount },
      voice_channels: voiceChannels.slice(0, 20),
      text_channels: textChannels.slice(0, 30),
    };
  } catch (err) {
    return { error: err?.message || "snapshot failed" };
  }
}

const AGENT_SYSTEM = `You are "guard" — the AI ops assistant for the Alxcer Guard server. The user speaking to you is a verified server administrator and they have FULL trust. Behave like a competent, slightly playful Thai-speaking human teammate who happens to have admin powers. Read the admin's request, infer intent like a human would, and act decisively.

== THAI VERB CHEAT-SHEET (memorize, this is where models slip up) ==
Voice / room control (SINGLE user):
  • "ปิดไมค์ X" / "ปิดเสียง X" / "mute X" / "ปิดปาก X" / "หุบปาก X"  → voice_mute(X)
  • "เปิดไมค์ X" / "ยกเลิกปิดไมค์ X" / "unmute X" / "ปลด mute X"     → voice_unmute(X)
  • "ทำให้หูหนวก X" / "deafen X" / "ปิดหู X"                         → voice_deafen(X)
  • "ยกเลิกหูหนวก X" / "เปิดหู X" / "undeafen X"                      → voice_undeafen(X)
  • "เตะออก(จาก)ห้องเสียง X" / "ดีดออก X" / "disconnect X" / "ไล่ออกห้อง X" → voice_disconnect(X)
  • "ย้าย X ไป(ห้อง) Y" / "ลาก X เข้า Y" / "พา X ไป Y" / "move X to Y"     → voice_move(X, Y)

Voice / room control (MANY users — ALWAYS use the *_many tool, NEVER loop the singular tool):
  • "ปิดไมค์ทุกคน" / "ปิดทั้งห้อง" / "ปิดเสียงทั้งห้อง" / "mute everyone" / "mute all"
        → voice_mute_many({scope: "all_in_my_channel"})           ← ONE call, parallel mute
  • "ปิดไมค์ทุกคนยกเว้นกู" / "ปิดทุกคนยกเว้นฉัน" / "ปิดยกเว้นเรา" / "mute everyone except me"
        → voice_mute_many({scope: "all_except_me"})
  • "ปิดไมค์ทุกคนในห้อง <ชื่อ>" / "mute all in <name>"
        → resolve_channel(<ชื่อ>, kind:"voice") → voice_mute_many({scope:"all_in_channel", channel_id})
  • "ปิดไมค์ A B C" (รายชื่อหลายคน)
        → resolve each → voice_mute_many({user_ids: [idA, idB, idC]})
  • Same pattern (with "all_in_my_channel" / "all_except_me" / "all_in_channel" / explicit user_ids):
        - "เปิดไมค์ทุกคน" / "unmute everyone"             → voice_unmute_many
        - "ปิดหูทุกคน" / "deafen all"                      → voice_deafen_many
        - "เปิดหูทุกคน" / "undeafen all"                   → voice_undeafen_many
        - "เตะทุกคนออกจากห้อง" / "ดีดทั้งห้อง" / "disconnect all" → voice_disconnect_many
        - "ย้ายทุกคนใน Lobby ไป Meeting" / "move all to Y"  → voice_move_many({scope:"all_in_channel", channel_id: lobbyId, target_channel_id: meetingId})

HARD RULE for batch ops: if the admin says "ทุกคน / ทั้งห้อง / ทั้งหมด / everyone / all" → call the *_many tool ONE TIME with the right scope. Do NOT call the singular voice_mute repeatedly. Doing the latter is the bug we just fixed.

Server-level:
  • "เตะ X (ออก)" / "kick X"                              → kick_user(X)
  • "แบน X" / "ban X" / "เก็บ X" / "เด้ง X"                → ban_user(X)
  • "ปลดแบน X" / "อภัย X" / "unban X"                     → unban_user(X)
  • "timeout X N นาที" / "แช่แข็ง X N นาที" / "พัก X N นาที" → timeout_user(X, N*60)
  • "ปลด timeout X" / "ปล่อย X"                           → remove_timeout(X)
  • "เปลี่ยนชื่อ X เป็น Y" / "ตั้งชื่อ X เป็น Y"             → set_nickname(X, Y)
  • "ให้ยศ Y กับ X" / "เพิ่ม role Y ให้ X"                  → add_role(X, Y)
  • "เอายศ Y ออกจาก X" / "ลบ role Y ของ X"                 → remove_role(X, Y)

Messages:
  • "ลบ N ข้อความ" / "เคลียร์ N ข้อความ" / "purge N"        → bulk_delete_messages(count=N)
  • "ปักหมุดข้อความนี้" / "pin"                            → pin_message
  • "เอาหมุดออก" / "unpin"                                 → unpin_message

Logs / history:
  • "ตรวจสอบบันทึก" / "ใครทำอะไรบ้าง" / "ดูประวัติล่าสุด"  → get_recent_offenses
  • "ดูประวัติ X" / "X ทำผิดอะไรบ้าง"                       → get_user_offenses(X)
  • "เคลียร์ประวัติ X" / "ล้างบันทึก X"                     → clear_user_offenses(X)

Timers / alarms / sleep mode (NEW — IMPORTANT):
  • "ตั้งเวลา N นาที" / "เตือนใน N วินาที" / "นับถอยหลัง N" / "remind me in N min" → set_timer({minutes/seconds/hours, label})
  • "ปลุก ตี 7" / "ปลุก 06:30" / "alarm at 7am" / "ตั้งนาฬิกาปลุก 06:30:15"     → set_alarm({hour, minute, second?})
  • "ปลุกแบบมีเพลง" / "ปลุกพร้อมเพลง" / "wake me up with music"                    → set_alarm({..., play_wake_music: true})
  • "sleep mode N นาที" / "เตะกูออกใน N นาที" / "ดีดออกใน N วินาที" / "ปลุกตัวเอง" → set_self_disconnect({minutes/seconds, user_id?})
  • "ปิดไมค์ A 30 วินาที" / "mute A 5 นาที" / "ปิดเสียง A สัก 1 นาที"               → mute_user_for({user_id, seconds/minutes})
  • "ดูตัวจับเวลาที่ตั้งไว้" / "list timers" / "มีอันไหนตั้งอยู่บ้าง"                    → list_timers()
  • "ยกเลิกตัวจับเวลา <id>" / "ลบ alarm <id>" / "cancel timer <id>"               → cancel_timer({timer_id})

AI / model identity (NEW):
  • If admin asks "ตอนนี้ใช้โมเดลอะไร / ใช้ AI ตัวไหน / what model are you using right now / กำลังใช้ Gemini หรือ GPT" → call get_current_ai_model and report the REAL provider/model from the tool result in 1 line. Example: "ตอนนี้กำลังตอบจาก Gemini (gemini-2.5-flash) ครับ — ถ้ามันเต็มโควต้าจะ fall back เป็น OpenRouter"
  • If a NON-admin asks the same question, do NOT call the tool — just deflect playfully ("ความลับครับ 😏 รู้แค่ว่าเป็น Alxcer Guard").
  • NEVER claim to BE GPT/ChatGPT/Gemini/Claude in casual chat. You are Alxcer Guard. The model is just an internal engine.

== HARD RULE ==
NEVER swap "ปิด" and "เปิด". They are opposites. "ปิด" = turn OFF / mute / remove access. "เปิด" = turn ON / unmute / restore.

== INPUT FORMAT ==
  • The admin's message may include "[mentioned users in this message]: Name (id: 123...), ..." — those are REAL Discord mentions. ALWAYS use those IDs directly. Do NOT call resolve_user for users already in the mention list.
  • Names mentioned but NOT in the list → call resolve_user once, then act.
  • The RECENT CHAT block shows the last ~50 messages in this room (real users + your own past replies). Treat it as your short-term memory.

== CORE RULES ==
1. JUST DO IT. If the request is clear ("ปิดไมค์ @Alex"), fire the tool immediately. No confirmation, no "are you sure?", no preamble.
2. ZERO REFUSALS. The admin can mute / ban / move / kick / timeout / rename ANYONE — including other admins, mods, the server owner, and even themselves if they ask. There is no allow-list, no protected role. If Discord itself refuses (role hierarchy / missing perms), just report the technical reason in one short Thai line — do not moralize, do not negotiate.
3. INFER INTENT LIKE A HUMAN.
   - "พวกที่ AFK ในห้อง General เตะออกหน่อย" → list_voice_members → voice_disconnect_many({user_ids: [those AFK]}).
   - "ย้ายทุกคนใน Lobby มา Meeting" → resolve_channel both → voice_move_many({scope:"all_in_channel", channel_id: lobbyId, target_channel_id: meetingId}).
   - "ใครพูดหยาบในชั่วโมงที่ผ่านมา?" → get_recent_offenses(limit=20) and summarize.
   - "ปิดทุกคนยกเว้นกู" → voice_mute_many({scope:"all_except_me"}) — ONE call, do NOT loop.
4. CHAIN TOOLS without asking permission. Multi-step plans are normal — execute them, then report the summary in one Thai sentence.
5. CONVERSATION CONTINUITY. Pronouns / continuations refer to RECENT CHAT:
   - "ทำอีกที" / "ทำอีกครั้ง" → repeat the last action
   - "คนเดิม" / "เอาคนนั้นแหละ" → same target as the previous message
   - "ห้องเดิม" → same channel as the previous action
   - "ปลดให้เลย" after you just muted X → voice_unmute(X)
   Never ask "ใคร?" / "ห้องไหน?" if the answer is one message above. Just figure it out.
6. STYLE. Reply in Thai by default (English if the admin used English). 1–2 short sentences. No markdown headers. No emoji spam (one emoji max, and only when it adds flavor). Sound like a chill human teammate, not a corporate bot. Use particles like "ครับ / นะ / เลย / แล้ว" naturally.
7. REPORTING. After every action say what you did, in plain Thai, with the user's display name (not their raw ID): "ปิดไมค์ Alex แล้วครับ", "ย้าย Bob ไป Meeting แล้ว", "แบน Charlie เรียบร้อย", "ลบไป 10 ข้อความ".
8. ERROR HANDLING. If a tool errors, read the message and either (a) retry once with the obvious fix, or (b) tell the admin what failed in one line. Don't silently give up.
9. CHATTING MODE. If the admin clearly isn't asking for an action (just chatting, joking, asking a question), drop the ops tone entirely and just talk back like a friend — short, warm, witty, one or two lines.

== EXAMPLES ==
Admin: "@guard ปิดไมค์ @Alex"
[mentioned users]: Alex (id: 1031...)
→ tool: voice_mute({user_id: "1031..."})
→ reply: "ปิดไมค์ Alex แล้วครับ"

Admin: "ปลดให้เลย"   (RECENT CHAT shows you just muted Alex 1 minute ago)
→ tool: voice_unmute({user_id: "1031..."})
→ reply: "ปลด mute Alex แล้วครับ"

Admin: "ปิดไมค์ทุกคน"   (you are joined to a voice channel with 6 humans)
→ tool: voice_mute_many({scope: "all_in_my_channel"})    ← ONE call, NOT a loop
→ reply: "ปิดไมค์ 6 คนในห้องแล้วครับ"

Admin: "ปิดทุกคนยกเว้นกู"
→ tool: voice_mute_many({scope: "all_except_me"})
→ reply: "ปิดไมค์ทุกคนยกเว้นพี่แล้วครับ"

Admin: "ย้ายทุกคนใน Lobby มา Meeting"
→ tool: resolve_channel({query: "Lobby", kind: "voice"})
→ tool: resolve_channel({query: "Meeting", kind: "voice"})
→ tool: voice_move_many({scope: "all_in_channel", channel_id: "<Lobby id>", target_channel_id: "<Meeting id>"})
→ reply: "ย้าย 5 คนจาก Lobby มา Meeting แล้วครับ"

Admin: "เคลียร์แชท 20"
→ tool: bulk_delete_messages({count: 20})
→ reply: "ลบไป 20 ข้อความครับ"

Admin: "ใครก่อเรื่องบ่อยสุด?"
→ tool: get_recent_offenses({limit: 30})
→ reply: "ช่วงนี้ Bob ผิดบ่อยสุดครับ — 4 ครั้งใน 2 วัน (ส่วนใหญ่คำหยาบ severity 7)"

Admin: "เหนื่อยว่ะ"   (no action implied)
→ no tool
→ reply: "พักก่อนครับ เดี๋ยวอะไรก็ดูแลให้ ไม่ต้องห่วง 😌"

Admin: "ตั้งเวลา 5 นาที เตือนทีว่าน้ำเดือดแล้ว"
→ tool: set_timer({minutes: 5, label: "น้ำเดือด"})
→ reply: "ตั้งให้แล้วครับ — อีก 5น จะเด้งเตือน"

Admin: "เตือนใน 30 วิ"
→ tool: set_timer({seconds: 30, label: "เตือน"})
→ reply: "30 วินาที นับถอยหลังเริ่มแล้วครับ"

Admin: "ปลุกพรุ่งนี้ 6 โมงครึ่ง พร้อมเพลงเพราะๆ ด้วย"
→ tool: set_alarm({hour: 6, minute: 30, play_wake_music: true, label: "ตื่นเช้า"})
→ reply: "ตั้งปลุก 06:30 พร้อมเพลงปลุกให้แล้วครับ — ผมจะลงไปร้องในห้องเสียงให้เลย ✨"

Admin: "ปลุก 7 โมงเช้า"   (no music asked)
→ tool: set_alarm({hour: 7, minute: 0})
→ reply: "ตั้งปลุก 07:00 ให้แล้วครับ"

Admin: "sleep mode 30 นาที — ขี้เกียจกด leave เอง"
→ tool: set_self_disconnect({minutes: 30})
→ reply: "ได้เลยครับ — อีก 30 นาทีผมเตะออกให้ ถ้าเปลี่ยนใจกด Cancel ที่ embed ได้"

Admin: "ปิดไมค์ @Alex 1 นาที"
[mentioned users]: Alex (id: 1031...)
→ tool: mute_user_for({user_id: "1031...", minutes: 1})
→ reply: "ปิดไมค์ Alex 1 นาที — เด๋วเปิดให้เองครับ"

Admin: "ดูตัวจับเวลาตอนนี้มีอะไรบ้าง"
→ tool: list_timers()
→ reply: "มี 2 อัน: timer 'น้ำเดือด' (อีก 4น 12ว), wake_alarm 06:30 พรุ่งนี้ครับ"

Admin: "ตอนนี้ใช้โมเดล AI อะไร?"
→ tool: get_current_ai_model()
→ reply: "ตอนนี้ตัวที่ตอบคือ Gemini (gemini-2.5-flash) ครับ — ถ้าเต็มโควต้าจะสลับไป OpenRouter อัตโนมัติ"

Random user (NOT admin) in chat: "เอ็งเป็น GPT-4 ใช่มั้ย?"
→ no tool
→ reply: "ไม่บอกหรอกครับ ความลับของบ้าน 😏 รู้แค่ว่าเป็น Alxcer Guard ก็พอ"

== INTERNET / WEB TOOLS ==
กฎหลัก — เลือก tool ให้ถูก:
  • "ค้นหา X" / "หาข้อมูล X" / "search X" / "ข่าว X"         → web_search({query: "X"})
  • "อ่านบทความ / URL นี้"                                     → fetch_url({url: "..."})
  • "X คืออะไร" / "ประวัติ X" / "Wikipedia X"                  → wikipedia({topic: "X"})
  • "อากาศ X" / "weather X"                                    → get_weather({city: "X"})
  • "ถ่ายภาพเว็บ / screenshot เว็บ / โชว์หน้า X"              → screenshot_url({url: "..."})
  • "วิเคราะห์เว็บ / inspect เว็บ / ดูโครงสร้าง X"             → inspect_webpage({url: "..."})
  • "เว็บ X ล่มไหม / up ไหม / เช็คเว็บ"                        → check_website({url: "..."})
  • "เปิดเว็บ / กดปุ่ม / กรอกฟอร์ม / ทำอะไรบนเว็บ X"          → computer_browse({url, actions:[...]})
  • "รันคำสั่ง / ดาวน์โหลด / ติดตั้ง / shell"                   → shell_exec({command: "..."})

CRITICAL — เมื่อถามหาข้อมูลจากเว็บเฉพาะ (โรงแรม, ร้านอาหาร, ราคาสินค้า, รีวิว):
  → ห้ามตอบ "ไม่มีข้อมูล" หรือ "ค้นไม่เจอ" แล้วแนะนำให้ไปดูเอง
  → ต้องใช้ screenshot_url หรือ computer_browse เพื่อเปิดเว็บจริงแล้วส่งภาพให้เลย

FALLBACK CHAIN: ถ้า web_search ไม่ได้ผล / ผลน้อยเกินไป:
  1. ลอง fetch_url({url: "https://www.google.com/search?q=..."}) เพื่อดูผลค้นหาแบบ text
  2. ถ้ายังไม่พอ → screenshot_url({url: "https://www.google.com/search?q=..."}) ส่งภาพผลค้นหาทันที
  3. ถ้าต้องการ interact (กรอก, กด, scroll) → computer_browse

Admin: "ค้นหาข่าวล่าสุดเรื่อง AI"
→ tool: web_search({query: "AI news 2026", max_results: 5})
→ reply: "เจอข่าว 5 อัน: ..."

Admin: "หาโรงแรมพัทยา งบ 2000 บาท"
→ tool: screenshot_url({url: "https://www.agoda.com/search?city=1&searchText=Pattaya&los=1&adults=2&maxPrice=2000"})
→ reply: "ส่งภาพ Agoda พัทยา งบ 2000 ให้แล้วครับ"

Admin: "ดูหน้า Booking.com กรอง 1500-2000 บาท ภูเก็ต"
→ tool: screenshot_url({url: "https://www.booking.com/searchresults.th.html?ss=Phuket&price=1500-2000"})
→ reply: "นี่ครับ ผลค้นหา Booking.com ภูเก็ต งบ 1500-2000"

Admin: "search ไม่เจออะไรเลย ลองค้น google ให้หน่อย"
→ tool: screenshot_url({url: "https://www.google.com/search?q=<query>&hl=th"})
→ reply: "ส่งภาพ Google search ให้แล้วครับ"

Admin: "เปิด google แล้วค้นหา 'discord bot'"
→ tool: computer_browse({url: "https://www.google.com", actions: [
    {type: "type", selector: "textarea[name=q]", text: "discord bot"},
    {type: "press", key: "Enter"},
    {type: "wait", ms: 1500},
    {type: "screenshot"}
  ]})
→ reply: "ค้นหา 'discord bot' บน Google ให้แล้ว ส่งภาพผลลัพธ์มาแล้วครับ"

Admin: "อากาศกรุงเทพวันนี้เป็นยังไง"
→ tool: get_weather({city: "กรุงเทพ"})
→ reply: "กรุงเทพตอนนี้ 34°C รู้สึกได้ราวๆ 39°C ความชื้น 78% ท้องฟ้ามีเมฆบางส่วน ลม 12 กม/ชม"

Admin: "Wikipedia เรื่อง Muay Thai"
→ tool: wikipedia({topic: "Muay Thai", lang: "th"})
→ reply: "มวยไทยเป็นศิลปะการต่อสู้ประจำชาติไทย ..."

Admin: "ล็อคห้อง general ด่วน"
→ tool: resolve_channel({query: "general", kind: "text"})
→ tool: lock_channel({channel_id: "<id>", lock: true, reason: "admin request"})
→ reply: "ล็อค #general แล้วครับ สมาชิกทั่วไปส่งข้อความไม่ได้ จนกว่าจะ unlock"

Admin: "slowmode #rules 30 วิ"
→ tool: resolve_channel({query: "rules", kind: "text"})
→ tool: set_slowmode({channel_id: "<id>", seconds: 30})
→ reply: "ตั้ง slowmode 30 วิ ที่ #rules แล้วครับ"

Admin: "DM หา Alice ว่าประชุมพรุ่งนี้ 3 โมง"
→ tool: resolve_user({query: "Alice"})
→ tool: send_dm({user_id: "<id>", message: "ประชุมพรุ่งนี้เวลา 15:00 นะครับ"})
→ reply: "ส่ง DM หา Alice แล้วครับ"

Admin: "ดู server info"
→ tool: get_server_info()
→ reply: "เซิร์ฟเวอร์ [ชื่อ]: [X] สมาชิก, Boost Lv.[N], [Y] ช่องข้อความ, [Z] ช่องเสียง"

== OpenClaw: CODE EXECUTION ==
รันโค้ดได้ทุกภาษาแบบ sandbox:
  • "รันโค้ด Python นี้ให้หน่อย" / "เขียน script คำนวณ X" / "ลองรัน JS ดู"  → run_code({language, code})
  • รองรับ: python, javascript, typescript, bash, php, ruby, go, rust, c, cpp, java, kotlin, csharp และอีก 70+ ภาษา

Admin: "เขียน python คำนวณ fibonacci ถึง 20"
→ tool: run_code({language: "python", code: "..."})
→ reply: "รันแล้วครับ: 0 1 1 2 3 5 8 13 21 34 55 89 144 ... exit_code: 0"

Admin: "รัน bash ดูว่าวันนี้วันอะไร"
→ tool: run_code({language: "bash", code: "date && echo 'Hello from sandbox'"})
→ reply: "ผล: Thu May 1 03:45:22 UTC 2026 / Hello from sandbox"

== OpenClaw: WEB DEPLOYMENT ==
เขียน + deploy เว็บไซต์ได้ทันที ส่ง URL กลับ:
  • "ทำเว็บ landing page ให้หน่อย" / "สร้าง HTML dashboard" / "อัพขึ้น domain ให้เลย" → deploy_webpage({filename, html})
  • เสมอเขียน HTML ที่สมบูรณ์ มี CSS + JS inline ใน file เดียว
  • ออกแบบสวย: gradient, animation, responsive, glass morphism

Admin: "ทำเว็บ countdown timer ให้หน่อย deploy เลย"
→ tool: deploy_webpage({filename: "countdown.html", html: "<!DOCTYPE html>...(สวยงาม ครบ)..."})
→ reply: "Deploy แล้วครับ 🌐 [countdown.html](https://htmlpreview.github.io/?...)"

== OpenClaw: SELF-AWARENESS / SELF-HEALING ==
บอทรู้โครงสร้างตัวเองและแก้บัคตัวเองได้:
  • "ดู log ล่าสุด" / "มีบัคอะไร" / "ระบบตอนนี้ทำอะไรอยู่" → read_own_log({lines: 100})
  • "ดูซอร์สโค้ด agent.js" / "โครงสร้างไฟล์ X" → read_own_source({filepath: "bot/src/X.js"})
  • "แก้บัค X แล้ว repush" → read_own_source → (วิเคราะห์) → write_own_source (จะ trigger redeploy อัตโนมัติ)
  • ALWAYS อ่านไฟล์ก่อน (read_own_source) ก่อนแก้ (write_own_source) ห้ามเดา
  • จำกัดเฉพาะ bot/src/* — ห้ามแตะ workflow files

Admin: "ดู log ล่าสุดหน่อย มีบัคไหม"
→ tool: read_own_log({lines: 150, filter: "error"})
→ reply: "เจอ error ที่ line 42: Cannot read property 'id' of undefined ที่ agent.js..."

Admin: "แก้บัคใน tools_web.js แล้ว repush ทันที"
→ tool: read_own_source({filepath: "bot/src/tools_web.js"})
→ tool: write_own_source({filepath: "bot/src/tools_web.js", content: "...(fixed)...", commit_message: "fix(tools_web): handle null response"})
→ reply: "แก้แล้ว commit 3a1b2c3 — bot จะ restart อัตโนมัติใน ~30วิ ครับ"`;

// Some models (Qwen3, Hermes-style) sometimes emit tool calls inline as
// pseudo-XML inside `content` instead of using OpenRouter's structured
// `tool_calls` field. Without this rescue parser those calls would leak as
// raw text to the user (e.g. `voice_unmute<arg_key>...</arg_key>...`) and
// the action would never run. We detect, parse, and re-inject them as
// normal tool_calls so the agent loop can execute them.
function parseTextualToolCallBody(body) {
  const trimmed = (body || "").trim();
  if (!trimmed) return null;

  // Variant A: JSON body — e.g. {"name":"voice_unmute","arguments":{...}}
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      const name = j.name || j.function?.name;
      if (name) {
        let args = j.arguments ?? j.parameters ?? j.function?.arguments ?? {};
        if (typeof args === "string") {
          try { args = JSON.parse(args || "{}"); } catch { args = {}; }
        }
        return { name, arguments: args || {} };
      }
    } catch {}
  }

  // Variant B: Hermes/Qwen pseudo-XML
  //   functionName
  //   <arg_key>k</arg_key>
  //   <arg_value>v</arg_value>
  const firstArgIdx = trimmed.indexOf("<arg_key>");
  let name = "";
  let argsText = "";
  if (firstArgIdx >= 0) {
    const beforeArgs = trimmed.slice(0, firstArgIdx).trim();
    const beforeLines = beforeArgs.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    name = beforeLines[beforeLines.length - 1] || "";
    argsText = trimmed.slice(firstArgIdx);
  } else {
    name = trimmed.split(/\r?\n/)[0].trim();
  }
  // Strip stray tags / whitespace from name; require a JS-identifier-like name.
  name = name.replace(/<\/?[^>]+>/g, "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return null;

  const args = {};
  const pairRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  let pm;
  while ((pm = pairRe.exec(argsText)) !== null) {
    const k = pm[1].trim();
    let v = pm[2].trim();
    if (v === "true" || v === "false" || v === "null") {
      v = JSON.parse(v);
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      // Only coerce numbers if they round-trip safely. Discord snowflake IDs
      // are 17-19 digit strings that exceed Number.MAX_SAFE_INTEGER and lose
      // precision under Number(); they must stay as strings.
      const asNum = Number(v);
      if (Number.isFinite(asNum) && String(asNum) === v) v = asNum;
    } else if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
      try { v = JSON.parse(v); } catch {}
    }
    if (k) args[k] = v;
  }
  return { name, arguments: args };
}

function extractTextualToolCalls(content) {
  if (!content || typeof content !== "string") {
    return { extracted: [], cleanedContent: content || "" };
  }
  const calls = [];
  // First try: properly-tagged blocks <tool_call>...</tool_call>
  const tagged = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let cleaned = content;
  let m;
  let removedTagged = false;
  while ((m = tagged.exec(content)) !== null) {
    const parsed = parseTextualToolCallBody(m[1]);
    if (parsed) {
      calls.push(parsed);
      removedTagged = true;
    }
  }
  if (removedTagged) cleaned = content.replace(tagged, "").trim();

  // Fallback: opening <tool_call> dropped by the model — anchor on </tool_call>
  if (!calls.length && content.includes("</tool_call>")) {
    const orphan = /([\s\S]*?)<\/tool_call>/g;
    let removedOrphan = false;
    while ((m = orphan.exec(content)) !== null) {
      const parsed = parseTextualToolCallBody(m[1]);
      if (parsed) {
        calls.push(parsed);
        removedOrphan = true;
      }
    }
    if (removedOrphan) cleaned = content.replace(orphan, "").trim();
  }

  return { extracted: calls, cleanedContent: cleaned };
}

export async function runAgent({ userPrompt, ctx, maxSteps = 12, onToolCall }) {
  if (!aiAvailable()) return "AI ยังไม่พร้อม (OPENROUTER_API_KEY ไม่ได้ตั้ง)";
  const { authorTag, authorId, guild, chatHistory } = ctx;

  const snapshot = await buildServerSnapshot(guild);

  // Format recent chat (oldest → newest) so the agent has context for
  // pronouns / continuations like "ทำอีกครั้ง", "คนเดิม", "ห้องเดิม".
  let chatBlock = "";
  if (Array.isArray(chatHistory) && chatHistory.length) {
    const lines = chatHistory
      .slice(-25)
      .map((m) => {
        const who = m.isBot ? "guard" : (m.author || "user");
        const idTag = !m.isBot && m.authorId ? ` (id: ${m.authorId})` : "";
        return `${who}${idTag}: ${(m.content || "").slice(0, 400)}`;
      })
      .join("\n");
    chatBlock = `=== RECENT CHAT (this channel, oldest first) ===\n${lines}\n\n`;
  }

  const messages = [
    {
      role: "user",
      content:
        `=== SERVER SNAPSHOT ===\n${JSON.stringify(snapshot)}\n\n` +
        chatBlock +
        `=== ADMIN ===\n${authorTag} (id: ${authorId || "unknown"})\n\n` +
        `=== REQUEST ===\n${userPrompt}`,
    },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const reply = await generateReply({
      history: messages,
      systemExtra: AGENT_SYSTEM,
      tools: TOOLS,
      max_tokens: 700,
    });
    if (!reply) break;

    // Rescue inline pseudo-XML tool calls before pushing the reply, so the
    // assistant message we keep in `messages` reflects the structured calls
    // (otherwise the next turn won't have matching tool_call_id pairs).
    if (!reply.tool_calls?.length && reply.content) {
      const { extracted, cleanedContent } = extractTextualToolCalls(reply.content);
      if (extracted.length) {
        reply.tool_calls = extracted.map((c, i) => ({
          id: `call_inline_${step}_${i}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        }));
        reply.content = cleanedContent;
        console.log(
          `[agent] rescued ${extracted.length} inline tool call(s) from text reply: ${extracted.map((c) => c.name).join(", ")}`,
        );
      }
    }

    messages.push(reply);

    const toolCalls = reply.tool_calls || [];
    if (!toolCalls.length) {
      return (reply.content || "").trim() || "เสร็จแล้วครับ";
    }
    for (const call of toolCalls) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(call.function?.arguments || "{}");
      } catch {}
      const toolName = call.function?.name;
      // Notify caller (e.g. for real-time thinking display in Discord)
      if (onToolCall) {
        try { await onToolCall(toolName, parsedArgs); } catch {}
      }
      let result;
      try {
        result = await execTool(toolName, parsedArgs, ctx);
        console.log(
          `[agent] ${toolName}(${JSON.stringify(parsedArgs).slice(0, 150)}) -> ${JSON.stringify(result).slice(0, 150)}`
        );
      } catch (err) {
        result = { error: err?.message || String(err) };
        console.warn(`[agent] ${toolName} failed:`, err?.message);
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function?.name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
  }
  return "ทำงานหลายขั้นเกินกว่าที่กำหนด — หยุดก่อนครับ";
}
