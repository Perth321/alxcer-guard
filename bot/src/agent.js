// Admin agent: gives the LLM a full Discord toolbox so an admin can drive the
// bot in natural language. The admin can say things like "ปิดไมค์ A",
// "เตะ B ออกจากห้อง", "ลบ 10 ข้อความล่าสุด", "แบน C" — the agent will resolve
// names, choose the right tools, chain calls, and report back.

import { PermissionFlagsBits, ChannelType } from "discord.js";
import { generateReply, generateVisionReply, aiAvailable, getModelStatus } from "./ai.js";
import { webSearch, fetchUrl, wikipediaLookup, getWeather, searchHotels, translateText, generateImage, getQuickChart, defineWord, urbanDefine, getTrivia, shortenUrl } from "./tools_web.js";
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
import {
  createAutomation,
  cancelAutomationById,
  getAutomation,
  listAutomations,
  allAutomations,
  writeAutomationsLocal,
} from "./automations.js";
import {
  MUTATING_TOOLS,
  OWNER_ONLY_TOOLS,
  canExecuteAgentTool,
  hasRequiredVoiceConfirmation,
  isMutatingTool,
} from "./agent-auth.js";
import {
  cancelExpectedUnmute,
  expectOwnedUnmute,
  createMuteLease,
  getMuteLease,
  releaseMuteLease,
} from "./mute-leases.js";

export {
  MUTATING_TOOLS,
  OWNER_ONLY_TOOLS,
  canExecuteAgentTool,
  hasRequiredVoiceConfirmation,
  isMutatingTool,
} from "./agent-auth.js";

// ─── Role panel button toggle handler (called from index.js InteractionCreate) ───
export async function handleRolePanelButton(interaction) {
  // customId = "role_panel:<role_id>"
  const roleId = interaction.customId.split(":")[1];
  if (!roleId) return false;
  try {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) { await interaction.editReply({ content: "❌ ยศนี้ไม่มีแล้วในเซิร์ฟเวอร์" }); return true; }
    const member = interaction.member;
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(role);
      await interaction.editReply({ content: `✅ คืนยศ **${role.name}** แล้ว` });
    } else {
      await member.roles.add(role);
      await interaction.editReply({ content: `✅ ได้รับยศ **${role.name}** แล้ว 🎉` });
    }
  } catch (err) {
    await interaction.editReply({ content: `❌ ${err?.message || "เกิดข้อผิดพลาด"}` }).catch(() => {});
  }
  return true;
}

// Owner ID (set at startup from config.ownerId). Owner gets full admin trust
// even without the Discord Administrator permission flag.
let _ownerId = "";
export function setOwnerId(id) { _ownerId = id ? String(id) : ""; }

function memberUserId(member) {
  return member?.id || member?.user?.id || member?.userId || "";
}

export function permissionSetHas(perms, permission) {
  if (!perms) return false;
  if (typeof perms.has === "function") {
    try {
      return perms.has(permission);
    } catch {}
  }
  try {
    const bits = typeof perms === "bigint" ? perms : BigInt(perms);
    return (bits & BigInt(permission)) === BigInt(permission);
  } catch {
    return false;
  }
}

export function memberHasPermission(member, permission) {
  return permissionSetHas(member?.permissions, permission);
}

export function isAdmin(member) {
  if (!member) return false;
  const id = memberUserId(member);
  if (_ownerId && id === _ownerId) return true;
  return memberHasPermission(member, PermissionFlagsBits.Administrator);
}

export function canManageBot(member, fallbackPermissions = null) {
  if (isAdmin(member)) return true;
  if (memberHasPermission(member, PermissionFlagsBits.ManageGuild)) return true;
  if (permissionSetHas(fallbackPermissions, PermissionFlagsBits.Administrator)) return true;
  return permissionSetHas(fallbackPermissions, PermissionFlagsBits.ManageGuild);
}

// Defense-in-depth for tool calls. The outer message handler currently routes
// admin prompts into the agent, but voice/automation/future callers can invoke
// runAgent too. Every state-changing tool therefore checks authority again at
// the execution boundary instead of trusting the LLM routing path.
export async function authorizeAgentTool(toolName, ctx = {}) {
  if (!isMutatingTool(toolName) && !OWNER_ONLY_TOOLS.has(String(toolName || ""))) {
    return true;
  }

  const authorId = ctx.authorId ? String(ctx.authorId) : "";
  const contextOwnerId = ctx.ownerId ? String(ctx.ownerId) : "";
  const owner =
    !!authorId &&
    ((!!contextOwnerId && authorId === contextOwnerId) ||
      (!!_ownerId && authorId === _ownerId));
  if (canExecuteAgentTool(toolName, { isOwner: owner })) return true;

  let member = ctx.authorMember || null;
  if (member && authorId && memberUserId(member) !== authorId) member = null;
  if (!member && authorId && ctx.guild?.members?.fetch) {
    member = await ctx.guild.members.fetch(authorId).catch(() => null);
  }
  const fallbackPermissions =
    ctx.authorPermissions || ctx.memberPermissions || ctx.fallbackPermissions || null;
  return canExecuteAgentTool(toolName, {
    canManageGuild: canManageBot(member, fallbackPermissions),
  });
}

async function releaseOwnedMute({ guild, member, leaseId, reason }) {
  const guildId = guild?.id;
  const userId = member?.id;
  const current = guildId && userId ? getMuteLease(guildId, userId) : null;
  if (!current || !leaseId || current.id !== String(leaseId)) {
    return { ok: false, code: "mute_not_owned", lease: current };
  }

  // A member who left voice no longer has an active server mute to release,
  // but the exact matching lease can still be cleaned up safely.
  if (!member.voice?.channel) {
    const released = releaseMuteLease(guildId, userId, leaseId);
    return { ok: released, code: released ? "not_in_voice" : "lease_conflict" };
  }

  expectOwnedUnmute(guildId, userId, leaseId);
  try {
    await member.voice.setMute(false, reason);
  } catch (err) {
    cancelExpectedUnmute(guildId, userId, leaseId);
    throw err;
  }
  const released = releaseMuteLease(guildId, userId, leaseId);
  if (released) return { ok: true };

  // A newer mute replaced this lease while Discord REST was in flight. Restore
  // the muted state so the stale unmute cannot defeat the newer owner.
  const replacement = getMuteLease(guildId, userId);
  if (replacement) {
    await member.voice
      .setMute(true, `Alxcer Guard: preserving newer mute lease ${replacement.source}`)
      .catch(() => {});
  }
  return { ok: false, code: "lease_conflict", lease: replacement };
}

// ===== TOOL DEFINITIONS (OpenAI-compatible JSON schema) =====
export const TOOLS = [
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
  {
    type: "function",
    function: {
      name: "list_channels",
      description: "List the text and voice channels that the requester can see in this Discord server.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_channel",
      description: "Create one text or voice channel. Use type=voice for a voice room and type=text for a chat room.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "New channel name" },
          type: { type: "string", enum: ["text", "voice"], description: "Channel kind; defaults to text" },
          category_name: { type: "string", description: "Optional existing category name" },
          topic: { type: "string", description: "Optional topic for a text channel" },
          slowmode: { type: "integer", minimum: 0, maximum: 21600, description: "Text-channel slowmode in seconds" },
          nsfw: { type: "boolean" },
        },
        required: ["name", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_channel",
      description: "Rename a channel or update its topic, slowmode, or NSFW setting.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          name: { type: "string", description: "New channel name" },
          topic: { type: "string" },
          slowmode: { type: "integer", minimum: 0, maximum: 21600 },
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
      description: "Delete one Discord channel after it has been resolved to an exact channel_id.",
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
      description: "Create a Discord channel category.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          position: { type: "integer", minimum: 0 },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_channel",
      description: "Lock or unlock sending messages for @everyone in a text channel.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          lock: { type: "boolean", description: "true locks; false unlocks" },
          reason: { type: "string" },
        },
        required: ["channel_id", "lock"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_slowmode",
      description: "Set text-channel slowmode in seconds; use 0 to disable it.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          seconds: { type: "integer", minimum: 0, maximum: 21600 },
        },
        required: ["channel_id", "seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_channel_topic",
      description: "Set or clear the topic of a text channel.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Defaults to the current text channel" },
          topic: { type: "string" },
        },
        required: ["topic"],
      },
    },
  },
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
      name: "clear_user_offenses",
      description: "Reset the offense counters for a user.",
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
      name: "set_self_disconnect",
      description:
        "Sleep mode สำหรับคนเดียว: ตั้งตัวจับเวลาแล้วบอทจะเตะ user คนนั้นออกจากห้องเสียงเมื่อครบเวลา พร้อม embed countdown + ปุ่มยกเลิก ใช้สำหรับ 'sleep mode 30 นาที', 'เตะกูออกใน 2 ชั่วโมง', 'ดีดออกใน 5 นาที', 'ปลุกตัวเองอีก 1 ชม'",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "integer", description: "จำนวนวินาที" },
          minutes: { type: "integer", description: "จำนวนนาที" },
          hours:   { type: "integer", description: "จำนวนชั่วโมง (ใส่ได้พร้อมกับ minutes เช่น hours:1 minutes:30 = 1.5 ชม)" },
          user_id: { type: "string",  description: "User ที่จะเตะออก — ถ้าไม่ระบุจะใช้คนที่สั่ง" },
          label:   { type: "string",  description: "ป้ายกำกับ เช่น 'นอนละ'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_group_sleep",
      description:
        "Group sleep mode: ตั้งตัวจับเวลาแล้วบอทจะเตะ **ทุกคน** ออกจากทุกห้องเสียงในเซิร์ฟพร้อมกัน ใช้เมื่อต้องการปิดเซิร์ฟหลัง N ชั่วโมง/นาที ใช้สำหรับ 'sleep mode ทุกคน 2 ชม', 'เตะทุกคนออกอีก 1 ชั่วโมง', 'ปิดเซิร์ฟในอีก 30 นาที', 'group sleep 2 ชั่วโมง'",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "integer", description: "จำนวนวินาที" },
          minutes: { type: "integer", description: "จำนวนนาที" },
          hours:   { type: "integer", description: "จำนวนชั่วโมง" },
          label:   { type: "string",  description: "ป้ายกำกับ เช่น 'ปิดเซิร์ฟ'" },
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
      name: "set_automation",
      description: "สร้าง automation ทำงานซ้ำตามเวลาที่กำหนด เช่น 'ทุกวัน 10 โมงเช้า สรุปข่าว', 'ทุกวันจันทร์ 9 โมง ส่งรายงาน'. รองรับ daily/weekdays/weekends/วันเฉพาะ",
      parameters: {
        type: "object",
        required: ["label", "hour", "minute", "task"],
        properties: {
          label:      { type: "string",  description: "ชื่อ automation เช่น 'สรุปข่าวเช้า'" },
          hour:       { type: "integer", description: "ชั่วโมง 0-23 (เวลาไทย Bangkok UTC+7)" },
          minute:     { type: "integer", description: "นาที 0-59" },
          days:       { type: "array",   items: { type: "string" },
                        description: "['daily']=ทุกวัน | ['weekdays']=จันทร์-ศุกร์ | ['weekends']=เสาร์-อาทิตย์ | ['mon','wed','fri'] เป็นต้น" },
          task:       { type: "string",  description: "งานที่จะทำ เป็น natural language เช่น 'ค้นหาข่าวเด่นวันนี้แล้วสรุปเป็นภาษาไทย 5 ข้อ'" },
          channel_id: { type: "string",  description: "channel ที่จะโพสต์ — ถ้าไม่ระบุใช้ channel ปัจจุบัน" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_automations",
      description: "ดูรายการ automation ทั้งหมดที่ตั้งไว้ใน server นี้",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_automation",
      description: "ยกเลิก automation ตาม id (ได้จาก list_automations)",
      parameters: {
        type: "object",
        required: ["automation_id"],
        properties: { automation_id: { type: "string" } },
      },
    },
  },
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
      name: "get_server_info",
      description: "Get detailed info about the Discord server: member count, roles, boost level, channels, creation date.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "translate",
      description: "แปลภาษา — รองรับ th, en, ja, ko, zh, fr, de, es, ar และอีกกว่า 50 ภาษา ใช้ฟรีไม่ต้องมี API key",
      parameters: {
        type: "object",
        required: ["text", "to"],
        properties: {
          text: { type: "string", description: "ข้อความที่ต้องการแปล (สูงสุด 500 ตัวอักษร)" },
          from: { type: "string", description: "ภาษาต้นทาง เช่น 'th', 'en', 'ja' — ถ้าไม่ระบุจะ auto-detect" },
          to:   { type: "string", description: "ภาษาปลายทาง เช่น 'en', 'th', 'ja', 'ko', 'zh', 'fr', 'de', 'ar'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_invite",
      description: "สร้างลิงก์เชิญ (invite link) สำหรับเซิร์ฟเวอร์",
      parameters: {
        type: "object",
        properties: {
          channel_id:    { type: "string",  description: "ID ของห้อง (default: ห้องปัจจุบัน)" },
          max_uses:      { type: "number",  description: "จำนวนครั้งสูงสุด (0 = ไม่จำกัด, default: 0)" },
          max_age_hours: { type: "number",  description: "อายุในชั่วโมง (0 = ไม่หมดอายุ, default: 24)" },
          temporary:     { type: "boolean", description: "สมาชิกชั่วคราว" },
          reason:        { type: "string"  },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_member_info",
      description: "ดูข้อมูลสมาชิกแบบละเอียด: roles, join date, permissions, voice state, boost status ฯลฯ",
      parameters: {
        type: "object",
        required: ["user_id"],
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "server_stats",
      description: "สถิติเซิร์ฟเวอร์ละเอียด: online/offline/idle, bots, channels ทุกประเภท, boosts",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "announce",
      description: "ส่ง embed ประกาศสวยงามไปยัง Discord channel รองรับ title/description/color/image/thumbnail/fields/footer/mention ใช้สำหรับ 'ประกาศว่า X', 'โพสต์ข่าว Y', 'สร้าง embed', 'แจ้งเตือน Z', 'ทำ embed สวยๆ'",
      parameters: {
        type: "object",
        required: ["title"],
        properties: {
          title:         { type: "string",  description: "หัวข้อ embed" },
          description:   { type: "string",  description: "เนื้อหา (รองรับ Discord markdown: **bold**, *italic*, code, > quote)" },
          color:         { type: "string",  description: "สีของแถบ: red/blue/green/yellow/purple/orange/pink/gold/cyan หรือ hex #RRGGBB" },
          channel_id:    { type: "string",  description: "ส่งไปห้องไหน (default: ห้องปัจจุบัน)" },
          thumbnail_url: { type: "string",  description: "URL รูปมุมขวาบน (icon เล็กๆ)" },
          image_url:     { type: "string",  description: "URL รูปขนาดใหญ่ด้านล่าง embed" },
          footer:        { type: "string",  description: "ข้อความ footer เล็กๆ ด้านล่าง" },
          author:        { type: "string",  description: "ชื่อในแถบ author บนสุด" },
          fields:        { type: "array",   description: "fields [{name, value, inline?}]", items: { type: "object" } },
          mention:       { type: "string",  description: "@everyone, @here หรือ role mention ที่จะโพสต์ก่อน embed" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "สร้างรูปภาพ AI จากคำอธิบาย (text-to-image) แล้วส่งให้ Discord ทันที ฟรีไม่ต้อง API key ใช้สำหรับ 'วาดรูป X', 'สร้างภาพ Y', 'generate image', 'AI art'",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt:     { type: "string",  description: "คำอธิบายรูป (อังกฤษจะได้ผลดีกว่า เช่น 'cute cat on cloud, anime style')" },
          width:      { type: "integer", description: "ความกว้าง px (default: 1024)" },
          height:     { type: "integer", description: "ความสูง px (default: 1024)" },
          channel_id: { type: "string"  },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "random_pick",
      description: "สุ่มทุกอย่าง: โยนเหรียญ (coin), ทอยลูกเต๋า (dice), สุ่มตัวเลข (number), เลือกสมาชิกแบบสุ่ม (member), สุ่มจากรายการ (list)",
      parameters: {
        type: "object",
        required: ["type"],
        properties: {
          type:       { type: "string", enum: ["coin","dice","number","member","list"] },
          sides:      { type: "integer", description: "จำนวนหน้าลูกเต๋า (default: 6)" },
          count:      { type: "integer", description: "จำนวนครั้ง (default: 1, max: 20)" },
          min:        { type: "integer", description: "ตัวเลขต่ำสุด (type:number, default: 1)" },
          max:        { type: "integer", description: "ตัวเลขสูงสุด (type:number, default: 100)" },
          items:      { type: "array",   items: { type: "string" }, description: "รายการ (type:list)" },
          channel_id: { type: "string",  description: "ห้องเสียงสุ่มสมาชิก (type:member)" },
          count_members: { type: "integer", description: "สุ่มสมาชิกกี่คน (default: 1)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "purge_user_messages",
      description: "ลบข้อความทั้งหมดของ user คนนึงใน channel (เฉพาะ ≤14 วัน) ใช้สำหรับ 'ลบข้อความของ X', 'เคลียร์ spam ของ X'",
      parameters: {
        type: "object",
        required: ["user_id"],
        properties: {
          user_id:    { type: "string" },
          channel_id: { type: "string" },
          limit:      { type: "integer", description: "สแกนกี่ข้อความ (default: 100, max: 500)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_avatar",
      description: "ดูรูปโปรไฟล์ (avatar) ของ Discord user แบบขนาดใหญ่ชัด 4096px ส่งเป็น embed สวยงามทันที ใช้สำหรับ 'ขยายรูปโปรไฟล์ @user', 'รูป profile ของ X', 'ดูรูป avatar', 'โปรไฟล์ใคร'",
      parameters: {
        type: "object",
        required: ["user_id"],
        properties: {
          user_id:    { type: "string", description: "Discord user ID" },
          channel_id: { type: "string", description: "ส่งไปห้องไหน (default: ห้องปัจจุบัน)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bot_info",
      description: "ดูสถานะบอท: uptime, ping, memory, guilds ใช้สำหรับ 'สถานะบอท', 'bot status', 'บอทโอเคไหม', 'ping เท่าไหร่'",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "setup_role_panel",
      description: "สร้างปุ่มรับยศ (role panel) ใน channel ที่กำหนด ผู้ใช้กดปุ่มเพื่อรับ/คืนยศได้เอง รองรับหลายยศพร้อมกัน ใช้สำหรับ 'สร้างที่กดรับยศ', 'ทำปุ่มยศ', 'role panel', 'self-role', 'เพศ/ที่อยู่/สี role'",
      parameters: {
        type: "object",
        required: ["roles"],
        properties: {
          channel_id: { type: "string", description: "ห้องที่จะโพสต์ panel (default: ห้องปัจจุบัน)" },
          title:      { type: "string", description: "หัวข้อ embed เช่น '🎮 เลือกยศเกม'" },
          description:{ type: "string", description: "คำอธิบายใต้หัวข้อ" },
          color:      { type: "string", description: "สีแถบ embed เช่น 'blue','purple','#ff6b6b'" },
          roles: {
            type: "array",
            description: "รายการยศ [{role_id, label, emoji?}]",
            items: {
              type: "object",
              properties: {
                role_id: { type: "string" },
                label:   { type: "string", description: "ชื่อบนปุ่ม เช่น 'เพศชาย'" },
                emoji:   { type: "string", description: "emoji หน้าปุ่ม เช่น '♂️'" },
              },
              required: ["role_id", "label"],
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_channel_permissions",
      description: "ตั้งสิทธิ์ channel สำหรับ role หรือ user เฉพาะ — allow/deny/neutral สำหรับ view, send, react, attach, connect, speak, manage ใช้สำหรับ 'ล็อค channel', 'ห้ามพิมพ์ใน X', 'ให้เฉพาะยศ A เห็น', 'ซ่อน channel'",
      parameters: {
        type: "object",
        required: ["channel_id", "target_id"],
        properties: {
          channel_id: { type: "string" },
          target_id:  { type: "string", description: "Role ID หรือ User ID" },
          target_type:{ type: "string", enum: ["role","member"], description: "default: role" },
          allow:  { type: "array", items:{ type:"string" }, description: "สิทธิ์ที่จะ allow: view_channel, send_messages, add_reactions, attach_files, connect, speak, manage_messages" },
          deny:   { type: "array", items:{ type:"string" }, description: "สิทธิ์ที่จะ deny" },
          neutral:{ type: "array", items:{ type:"string" }, description: "สิทธิ์ที่จะ reset (inherit)" },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "full_server_setup",
      description: "Setup เซิร์ฟเวอร์แบบครบจบในคำสั่งเดียว: สร้าง roles, channels, permissions, role panels ตาม spec ที่กำหนด Alex ใช้คำสั่งนี้เพื่อสร้าง/จัดระเบียบเซิร์ฟเวอร์ใหม่ทั้งหมด",
      parameters: {
        type: "object",
        properties: {
          roles: {
            type: "array",
            description: "roles ที่จะสร้าง [{name, color?, hoist?, mentionable?, permissions?}]",
            items: { type: "object" },
          },
          categories: {
            type: "array",
            description: "categories + channels [{name, channels:[{name, type?, topic?, view_roles?, send_roles?, deny_roles?}]}]",
            items: { type: "object" },
          },
          role_panels: {
            type: "array",
            description: "role panels ที่จะสร้างหลัง setup [{channel_name, title, roles:[{role_name, label, emoji?}]}]",
            items: { type: "object" },
          },
          announce_channel: { type: "string", description: "ชื่อ channel สำหรับประกาศว่า setup เสร็จแล้ว" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stylize_text",
      description: "แปลงข้อความเป็น Unicode font สวยๆ สำหรับชื่อ category, voice channel, role, embed ใน Discord ใช้สำหรับ 'เปลี่ยนฟอนต์', 'ฟอนต์สวยๆ', 'ตัวอักษรแฟนซี', 'ชื่อห้องสวยๆ', 'font discord'",
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text:  { type: "string", description: "ข้อความที่ต้องการแปลง" },
          style: {
            type: "string",
            description: "สไตล์ฟอนต์",
            enum: ["bold","italic","bold_italic","script","bold_script","fraktur","double","mono","wide","small_caps"],
          },
          show_all: { type: "boolean", description: "true = แสดงทุกสไตล์พร้อมกัน (เพื่อให้เลือก)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "beautify_server",
      description: "ตกแต่งชื่อทุกห้องและ category ในเซิร์ฟเวอร์ด้วย emoji decorator + Unicode font สวยๆ พูดว่า 'ตกแต่งทุกห้อง', 'เปลี่ยนชื่อทุกห้องให้สวย', 'beautify server', 'ตกแต่งเซิร์ฟ' เลือก preset ได้หลายแบบ เช่น aesthetic, elegant, cute, minimal, freedom, dark",
      parameters: {
        type: "object",
        properties: {
          preset: {
            type: "string",
            description: "รูปแบบตกแต่ง: aesthetic (✦·), elegant (「」◦), cute (✿˚), minimal (—·), freedom (คล้ายในรูป ♡·ℓ), dark (⊱⌬), kawaii (❝♡❞), custom",
            enum: ["aesthetic","elegant","cute","minimal","freedom","dark","kawaii","custom"],
          },
          font_style: {
            type: "string",
            description: "ฟอนต์ Unicode สำหรับชื่อ category (ชื่อห้องจะเป็น plain text + decorator)",
            enum: ["bold","italic","bold_italic","script","bold_script","fraktur","double","mono","wide","small_caps","none"],
          },
          scope: {
            type: "string",
            description: "ขอบเขต: all=ทั้งหมด, categories=เฉพาะหมวด, channels=เฉพาะห้อง",
            enum: ["all","categories","channels"],
          },
          custom_cat_prefix:  { type: "string", description: "prefix หน้า category (custom preset เท่านั้น) เช่น '「 '" },
          custom_cat_suffix:  { type: "string", description: "suffix หลัง category เช่น ' 」'" },
          custom_ch_prefix:   { type: "string", description: "prefix หน้าชื่อห้อง เช่น '· '" },
          custom_ch_suffix:   { type: "string", description: "suffix หลังชื่อห้อง เช่น ' ·'" },
          preview_only: { type: "boolean", description: "true = แสดงตัวอย่างก่อน ไม่ได้ rename จริง" },
          target_channel_id: { type: "string", description: "ถ้าระบุ channel_id = ตกแต่งเฉพาะห้องนั้น ไม่แตะห้องอื่น" },
        },
      },
    },
  },
];
;


const COLOR_MAP = {
  red:"#e74c3c", blue:"#3498db", green:"#2ecc71", yellow:"#f1c40f",
  purple:"#9b59b6", orange:"#e67e22", pink:"#fd79a8", gold:"#f9ca24",
  cyan:"#00cec9", white:"#ffffff", black:"#2c3e50", grey:"#95a5a6",
  gray:"#95a5a6", dark:"#2c3e50", teal:"#1abc9c",
};
function resolveColor(c) {
  if (!c) return 0x5865F2;
  if (c.startsWith("#")) return parseInt(c.slice(1), 16);
  return parseInt((COLOR_MAP[c.toLowerCase()] || "#5865F2").slice(1), 16);
}

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

const scopedOffenseKey = (guildId, userId) => `${guildId}:${userId}`;

function canAuthorViewChannel(target, ctx) {
  if (!target) return false;
  const authorId = ctx.authorId ? String(ctx.authorId) : "";
  const ownerId = ctx.ownerId ? String(ctx.ownerId) : "";
  if (authorId && (authorId === ownerId || authorId === _ownerId)) return true;
  const member = ctx.authorMember;
  if (!member || (authorId && memberUserId(member) !== authorId)) return false;
  return target.permissionsFor?.(member)?.has(PermissionFlagsBits.ViewChannel) === true;
}

// ===== Tool execution =====
async function execTool(name, args, ctx) {
  const { guild, channel, offenses, persistOffenses, authorId } = ctx;

  if (!(await authorizeAgentTool(name, ctx))) {
    console.warn(
      `[agent] denied tool=${name} author=${authorId || "unknown"} guild=${guild?.id || "unknown"}`,
    );
    const ownerOnly = OWNER_ONLY_TOOLS.has(name);
    return {
      error: ownerOnly
        ? "permission denied: this host/repository tool is restricted to the bot owner"
        : "permission denied: this tool requires the bot owner, Administrator, or Manage Server permission",
      code: "agent_tool_forbidden",
      tool: name,
    };
  }

  // Authorized owners/admins can intentionally target themselves; Discord's
  // role hierarchy and API permissions remain the final platform-level limit.

  
// ─── Unicode font conversion utility ─────────────────────────────────────────
function _fontify(text, style) {
  const T = {
    bold:        { a:0x1D41A, A:0x1D400, n:0x1D7CE },
    italic:      { a:0x1D44E, A:0x1D434, ex:{ h:'\u210E', B:'\u212C', E:'\u2130', F:'\u2131', H:'\u210B', I:'\u2110', L:'\u2112', M:'\u2133', R:'\u211B' } },
    bold_italic: { a:0x1D482, A:0x1D468, n:0x1D7CE },
    script:      { a:0x1D4B6, A:0x1D49C, ex:{ B:'\u212C', E:'\u2130', F:'\u2131', H:'\u210B', I:'\u2110', L:'\u2112', M:'\u2133', R:'\u211B', e:'\u212F', g:'\u210A', o:'\u2134' } },
    bold_script: { a:0x1D4EA, A:0x1D4D0 },
    fraktur:     { a:0x1D51E, A:0x1D504, ex:{ C:'\u212D', H:'\u210C', I:'\u2111', R:'\u211C', Z:'\u2128' } },
    double:      { a:0x1D552, A:0x1D538, n:0x1D7D8, ex:{ C:'\u2102', H:'\u210D', N:'\u2115', P:'\u2119', Q:'\u211A', R:'\u211D', Z:'\u2124' } },
    mono:        { a:0x1D68A, A:0x1D670, n:0x1D7F6 },
  };
  if (style === 'wide') return [...text].map(c => { const code=c.charCodeAt(0); if(code>=0x21&&code<=0x7E) return String.fromCodePoint(code-0x21+0xFF01); return c===' '?'\u3000':c; }).join('');
  if (style === 'small_caps') { const m={a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'s',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ'}; return [...text].map(c=>m[c.toLowerCase()]||c).join(''); }
  const tbl=T[style]; if(!tbl) return text;
  return [...text].map(c => {
    if(tbl.ex?.[c]) return tbl.ex[c];
    const code=c.charCodeAt(0);
    if(code>=97&&code<=122) return String.fromCodePoint(tbl.a+code-97);
    if(code>=65&&code<=90)  return String.fromCodePoint(tbl.A+code-65);
    if(tbl.n&&code>=48&&code<=57) return String.fromCodePoint(tbl.n+code-48);
    return c;
  }).join('');
}

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
    case "resolve_channel": {
      const candidates = await fuzzyFindChannels(guild, args.query, args.kind || "any");
      return {
        candidates: candidates.filter((candidate) =>
          canAuthorViewChannel(guild.channels.cache.get(candidate.id), ctx),
        ),
      };
    }

    case "voice_mute": {
      const m = await guild.members.fetch(args.user_id);
      if (m.id === guild.client.user?.id) return { error: "ไม่สามารถปิดไมค์ตัวเองได้ — บอทไม่ควรถูก mute" };
      if (!m.voice?.channelId) return { error: "user is not in a voice channel" };
      const existing = getMuteLease(guild.id, m.id);
      if (m.voice.serverMute && !existing) {
        return {
          error: "user is already server-muted by an external moderator; refusing to claim or overwrite that mute",
          code: "external_mute_not_owned",
        };
      }
      if (!m.voice.serverMute) {
        await m.voice.setMute(true, args.reason || "Alxcer Guard agent");
      }
      const lease = createMuteLease({
        guildId: guild.id,
        userId: m.id,
        source: "agent:voice_mute",
        actorId: authorId || null,
      });
      return { ok: true, user: m.displayName, lease_id: lease.id };
    }
    case "voice_unmute": {
      const m = await guild.members.fetch(args.user_id);
      const lease = getMuteLease(guild.id, m.id);
      if (!lease) {
        await m.voice.setMute(false, args.reason || "Alxcer Guard explicit admin unmute");
        return { ok: true, user: m.displayName, explicit_admin_override: true };
      }
      const released = await releaseOwnedMute({
        guild,
        member: m,
        leaseId: lease.id,
        reason: args.reason || "Alxcer Guard agent",
      });
      if (!released.ok) {
        return { error: `mute lease changed before unmute (${released.code})`, code: released.code };
      }
      return { ok: true, user: m.displayName, released_lease_id: lease.id };
    }
    case "voice_deafen": {
      const m = await guild.members.fetch(args.user_id);
      if (m.id === guild.client.user?.id) return { error: "ไม่สามารถ deafen ตัวเองได้" };
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
        if (m.id === guild.client.user?.id) return { error: "ไม่สามารถ disconnect ตัวเองได้" };
        if (!m.voice?.channelId) return { error: "user is not in a voice channel" };
        ctx.markBotKick?.(args.user_id);
        await m.voice.disconnect(args.reason || "Alxcer Guard agent");
        return { ok: true, user: m.displayName };
      }
    case "voice_move": {
      const m = await guild.members.fetch(args.user_id);
      if (m.id === guild.client.user?.id) return { error: "ไม่สามารถ move ตัวเองได้" };
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
          const existing = getMuteLease(guild.id, id);
          if (m.voice.serverMute && !existing) {
            return { id, name: m.displayName, skipped: "externally muted (not owned by bot)" };
          }
          if (!m.voice.serverMute) await m.voice.setMute(true, reason);
          const lease = createMuteLease({
            guildId: guild.id,
            userId: id,
            source: "agent:voice_mute_many",
            actorId: authorId || null,
          });
          return { id, name: m.displayName, ok: true, lease_id: lease.id };
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
          const lease = getMuteLease(guild.id, id);
          if (!lease) {
            await m.voice.setMute(false, reason);
            return { id, name: m.displayName, ok: true, explicit_admin_override: true };
          }
          const released = await releaseOwnedMute({
            guild,
            member: m,
            leaseId: lease.id,
            reason,
          });
          if (!released.ok) throw new Error(`mute lease conflict for ${id}`);
          return { id, name: m.displayName, ok: true, released_lease_id: lease.id };
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
          ctx.markBotKick?.(id);
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
        .filter((c) =>
          c &&
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice) &&
          canAuthorViewChannel(c, ctx),
        )
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
      if (!target?.isTextBased?.() || !canAuthorViewChannel(target, ctx)) {
        return { error: "channel not found or requester cannot view it", code: "channel_forbidden" };
      }
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
      const rec = offenses.users?.[scopedOffenseKey(guild.id, args.user_id)];
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
      const prefix = `${guild.id}:`;
      for (const [storedKey, rec] of Object.entries(users)) {
        if (!storedKey.startsWith(prefix)) continue;
        const uid = storedKey.slice(prefix.length);
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
      const storedKey = scopedOffenseKey(guild.id, args.user_id);
      if (offenses.users?.[storedKey]) {
        if (offenses.users[storedKey].chat) {
          offenses.users[storedKey].chat = { count: 0, lastAt: 0, history: [] };
        }
        offenses.users[storedKey].times = 0;
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
      const existingLease = getMuteLease(ctx.guild.id, args.user_id);
      if (member.voice.serverMute && !existingLease) {
        return {
          error: `${member.displayName} ถูก server-mute จากภายนอกอยู่แล้ว — บอทจะไม่ยึด mute ของแอดมินคนอื่น`,
          code: "external_mute_not_owned",
        };
      }
      try {
        if (!member.voice.serverMute) {
          await member.voice.setMute(true, args.reason || `mute_user_for ${parsed.totalSeconds}s`);
        }
      } catch (e) {
        return { error: `mute failed: ${e?.message || "unknown"}` };
      }
      const lease = createMuteLease({
        guildId: ctx.guild.id,
        userId: args.user_id,
        source: "agent:mute_user_for",
        actorId: ctx.authorId || null,
        expiresAt: parsed.fireAt,
      });
      const t = createTimer({
        type: "auto_unmute",
        fireAt: parsed.fireAt,
        label: args.reason || "Auto-unmute",
        guildId: ctx.guild.id,
        channelId: ctx.channel?.id || null,
        userId: args.user_id,
        mentionUserId: args.user_id,
        ownerId: ctx.authorId || null,
        payload: {
          displayName: member.displayName,
          reason: args.reason || "",
          leaseId: lease.id,
        },
      });
      return {
        ok: true,
        timer_id: t.id,
        lease_id: lease.id,
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
      if (t.guildId !== ctx.guild.id) {
        return { error: "timer belongs to a different server", code: "cross_guild_timer" };
      }
      // Side-effect: if it's an auto-unmute, immediately un-mute the user
      let muteRelease = null;
      if (t.type === "auto_unmute" && t.userId) {
        const expectedLeaseId = t.payload?.leaseId || null;
        const currentLease = getMuteLease(t.guildId, t.userId);
        if (expectedLeaseId && currentLease?.id === expectedLeaseId) {
          try {
            const member = await ctx.guild.members.fetch(t.userId);
            muteRelease = await releaseOwnedMute({
              guild: ctx.guild,
              member,
              leaseId: expectedLeaseId,
              reason: "cancel_timer manual unmute",
            });
          } catch (err) {
            muteRelease = { ok: false, code: "unmute_failed", error: err?.message };
          }
        } else {
          muteRelease = {
            ok: false,
            code: currentLease ? "lease_conflict" : "mute_not_owned",
          };
        }
      }
      const ok = cancelTimer(args.timer_id);
      return { ok, type: t.type, label: t.label, mute_release: muteRelease };
    }

    // ===== Automation tools =====
    case "set_automation": {
      const h = Number(args.hour);
      const m = Number(args.minute);
      if (!Number.isInteger(h) || h < 0 || h > 23) return { error: "hour must be 0-23 (Bangkok time)" };
      if (!Number.isInteger(m) || m < 0 || m > 59) return { error: "minute must be 0-59" };
      if (!args.task?.trim()) return { error: "task is required" };
      const channelId = args.channel_id || ctx.channel?.id;
      if (!channelId) return { error: "channel_id is required" };
      const rec = createAutomation({
        label: args.label || args.task.slice(0, 40),
        guildId: ctx.guild.id,
        channelId,
        createdBy: ctx.authorId || "",
        hour: h,
        minute: m,
        days: args.days || ["daily"],
        task: args.task.trim(),
      });
      try {
        const all = allAutomations();
        writeAutomationsLocal(all);
        const { commitAutomations } = await import("./github.js");
        commitAutomations(all).catch(e => console.warn("[auto] remote persist failed:", e?.message));
      } catch (e) { console.warn("[auto] persist error:", e?.message); }
      const bangkokHH = String(h).padStart(2, "0");
      const bangkokMM = String(m).padStart(2, "0");
      const daysStr = (args.days || ["daily"]).join(", ");
      return { ok: true, automation_id: rec.id, label: rec.label, fires_at: `${bangkokHH}:${bangkokMM} (Bangkok)`, days: daysStr };
    }
    case "list_automations": {
      const list = listAutomations({ guildId: ctx.guild.id });
      if (!list.length) return { count: 0, automations: [], message: "ยังไม่มี automation ตั้งไว้ครับ" };
      return {
        count: list.length,
        automations: list.map(a => ({
          id: a.id,
          label: a.label,
          time: `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")} (Bangkok)`,
          days: a.days.join(", "),
          task: a.task.slice(0, 80),
          last_fired: a.lastFiredAt ? new Date(a.lastFiredAt).toISOString() : "ยังไม่เคยยิง",
          channel_id: a.channelId,
        })),
      };
    }
    case "cancel_automation": {
      const targetAutomation = getAutomation(args.automation_id);
      if (!targetAutomation) return { error: "ไม่เจอ automation นั้น (อาจถูกยกเลิกไปแล้ว)" };
      if (targetAutomation.guildId !== ctx.guild.id) {
        return { error: "automation เป็นของอีกเซิร์ฟเวอร์", code: "cross_guild_automation" };
      }
      const okAuto = cancelAutomationById(args.automation_id);
      if (!okAuto) return { error: "ไม่เจอ automation นั้น (อาจถูกยกเลิกไปแล้ว)" };
      try {
        const all = allAutomations();
        writeAutomationsLocal(all);
        const { commitAutomations } = await import("./github.js");
        commitAutomations(all).catch(e => console.warn("[auto] remote persist failed:", e?.message));
      } catch (e) { console.warn("[auto] persist error:", e?.message); }
      return { ok: true, cancelled_id: args.automation_id };
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
    case "analyze_image": {
      const imgUrl = String(args.image_url || "");
      const question = String(args.question || "");
      if (!imgUrl) return { error: "image_url required" };

      // Use the bot's built-in vision AI (Gemini/OpenRouter vision)
      try {
        const result = await generateVisionReply({
          imageUrls: [imgUrl],
          userText: question || "รูปนี้คืออะไร? อธิบายรายละเอียดที่เห็น",
        });
        return {
          ok: true,
          reply: result?.content || "วิเคราะห์ภาพแล้วครับ",
          description: result?.content || "",
        };
      } catch (err) {
        return { error: err?.message || "analyze_image failed" };
      }
    }

    case "search_hotels": {
      const hotelData = searchHotels({
        location: args.location,
        budget: args.budget,
        checkin: args.checkin,
        checkout: args.checkout,
        guests: args.guests || 1,
      });

      // Return text data with booking links (removed dead internal screenshot URL)
      return {
        ok: true,
        location: hotelData.location,
        checkin: hotelData.checkin,
        checkout: hotelData.checkout,
        guests: hotelData.guests,
        budget: hotelData.budget,
        booking_url: hotelData.booking_url,
        agoda_url: hotelData.agoda_url,
        reply: hotelData.message,
      };
    }

    case "web_search": {
      const maxR = Math.min(Math.max(args.max_results || 5, 1), 8);
      const searchText = await webSearch(args.query, maxR);

      // Return text results directly
      return searchText;
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
      // clear_existing: delete all non-essential channels/categories before rebuilding
      if (args.clear_existing) {
        const allCh = [...guild.channels.cache.values()];
        for (const ch of allCh) {
          try { await ch.delete("rebuild_server clear_existing"); await new Promise(r => setTimeout(r, 400)); } catch {}
        }
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

    // ─── setup_role_panel ────────────────────────────────────────────────────
    case "setup_role_panel": {
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder: _RPEmbed } = await import("discord.js");
      const targetCh = args.channel_id
        ? await guild.channels.fetch(args.channel_id).catch(() => channel)
        : channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found or not text" };
      const roles = args.roles || [];
      if (!roles.length) return { error: "roles array required" };
      
    const COLOR_MAP = { red:0xe74c3c, blue:0x3498db, green:0x2ecc71, yellow:0xf1c40f,
      purple:0x9b59b6, orange:0xe67e22, pink:0xff6b9d, gold:0xf39c12, cyan:0x1abc9c, white:0xffffff, black:0x2c2f33 };
    function resolveColor(c) {
      if (!c) return 0x5865f2;
      if (/^#[0-9a-f]{6}$/i.test(c)) return parseInt(c.slice(1), 16);
      return COLOR_MAP[c.toLowerCase()] ?? 0x5865f2;
    }
      const embed = new _RPEmbed()
        .setColor(resolveColor(args.color))
        .setTitle(args.title || "🎭 เลือกยศของคุณ")
        .setDescription(args.description || "กดปุ่มด้านล่างเพื่อรับหรือคืนยศ")
        .setFooter({ text: "กดซ้ำเพื่อคืนยศ" });
      // Build button rows (max 5 per row, max 5 rows = 25 buttons)
      const rows = [];
      for (let i = 0; i < Math.min(roles.length, 25); i += 5) {
        const chunk = roles.slice(i, i + 5);
        const row = new ActionRowBuilder().addComponents(
          chunk.map(r => {
            const btn = new ButtonBuilder()
              .setCustomId(`role_panel:${r.role_id}`)
              .setLabel(String(r.label).slice(0, 80))
              .setStyle(ButtonStyle.Secondary);
            if (r.emoji) try { btn.setEmoji(r.emoji); } catch {}
            return btn;
          })
        );
        rows.push(row);
      }
      const panelMsg = await targetCh.send({ embeds: [embed], components: rows });
      return { ok: true, message_id: panelMsg.id, channel: targetCh.name, role_count: roles.length };
    }

    // ─── set_channel_permissions ─────────────────────────────────────────────
    case "set_channel_permissions": {
      const { PermissionsBitField } = await import("discord.js");
      const PERM_MAP = {
        view_channel: "ViewChannel", send_messages: "SendMessages",
        add_reactions: "AddReactions", attach_files: "AttachFiles",
        connect: "Connect", speak: "Speak", manage_messages: "ManageMessages",
        embed_links: "EmbedLinks", read_message_history: "ReadMessageHistory",
        use_slash_commands: "UseApplicationCommands",
      };
      const ch = await guild.channels.fetch(args.channel_id).catch(() => null);
      if (!ch) return { error: "channel not found" };
      const targetType = args.target_type || "role";
      let target;
      if (targetType === "member") {
        target = await guild.members.fetch(args.target_id).catch(() => null);
      } else {
        target = guild.roles.cache.get(args.target_id) || await guild.roles.fetch(args.target_id).catch(() => null);
      }
      if (!target) return { error: "role/member not found" };
      const toFlags = (list) => {
        const flags = {};
        for (const p of (list || [])) {
          const key = PERM_MAP[p] || p;
          flags[key] = true;
        }
        return flags;
      };
      const allow = toFlags(args.allow);
      const deny  = {};
      for (const p of (args.deny || [])) { const key = PERM_MAP[p] || p; deny[key] = false; }
      const neutral = {};
      for (const p of (args.neutral || [])) { const key = PERM_MAP[p] || p; neutral[key] = null; }
      await ch.permissionOverwrites.edit(target, { ...allow, ...deny, ...neutral }, { reason: args.reason || "Admin request" });
      return { ok: true, channel: ch.name, target: target.name || target.displayName };
    }

    // ─── full_server_setup ───────────────────────────────────────────────────
    case "full_server_setup": {
      const { ChannelType: _CT, PermissionsBitField: _PBF, ActionRowBuilder: _ARB, ButtonBuilder: _BB, ButtonStyle: _BS, EmbedBuilder: _FSEmbed } = await import("discord.js");
      const log = [];
      const roleMap = {}; // name → role object

      // Step 1: Create roles
      for (const roleDef of (args.roles || [])) {
        try {
          const existing = guild.roles.cache.find(r => r.name === roleDef.name);
          let role = existing;
          if (!existing) {
            role = await guild.roles.create({
              name: roleDef.name,
              color: roleDef.color || null,
              hoist: roleDef.hoist ?? false,
              mentionable: roleDef.mentionable ?? false,
              reason: "full_server_setup",
            });
            log.push(`✅ ยศ: ${role.name}`);
          } else {
            log.push(`⏭️ ยศมีแล้ว: ${roleDef.name}`);
          }
          roleMap[roleDef.name] = role;
        } catch(e) { log.push(`❌ ยศ ${roleDef.name}: ${e.message}`); }
      }

      // Step 2: Create categories + channels
      const channelMap = {}; // name → channel
      for (const catDef of (args.categories || [])) {
        let cat;
        try {
          cat = guild.channels.cache.find(c => c.name === catDef.name && c.type === _CT.GuildCategory);
          if (!cat) {
            cat = await guild.channels.create({ name: catDef.name, type: _CT.GuildCategory, reason: "full_server_setup" });
            log.push(`✅ หมวด: ${cat.name}`);
          }
        } catch(e) { log.push(`❌ หมวด ${catDef.name}: ${e.message}`); continue; }

        for (const chDef of (catDef.channels || [])) {
          try {
            const chType = (chDef.type||"text")==="voice" ? _CT.GuildVoice : _CT.GuildText;
            let ch = guild.channels.cache.find(c => c.name === chDef.name && c.parentId === cat.id);
            if (!ch) {
              ch = await guild.channels.create({
                name: chDef.name, type: chType, parent: cat.id,
                topic: chDef.topic || undefined, reason: "full_server_setup",
              });
              log.push(`✅ ห้อง: ${ch.name}`);
            }
            channelMap[chDef.name] = ch;
            // Apply permissions
            if (chDef.deny_roles) {
              for (const rn of chDef.deny_roles) {
                const r = roleMap[rn] || guild.roles.cache.find(x => x.name === rn);
                if (r) await ch.permissionOverwrites.edit(r, { ViewChannel: false });
              }
            }
            if (chDef.view_roles) {
              // deny @everyone first, then allow listed roles
              await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
              for (const rn of chDef.view_roles) {
                const r = roleMap[rn] || guild.roles.cache.find(x => x.name === rn);
                if (r) await ch.permissionOverwrites.edit(r, { ViewChannel: true });
              }
            }
          } catch(e) { log.push(`❌ ห้อง ${chDef.name}: ${e.message}`); }
        }
      }

      // Step 3: Create role panels
      for (const panel of (args.role_panels || [])) {
        try {
          const panelCh = channelMap[panel.channel_name] || guild.channels.cache.find(c => c.name === panel.channel_name);
          if (!panelCh) { log.push(`❌ panel channel ${panel.channel_name} not found`); continue; }
          const panelRoles = (panel.roles || []).map(pr => {
            const r = roleMap[pr.role_name] || guild.roles.cache.find(x => x.name === pr.role_name);
            return r ? { role_id: r.id, label: pr.label || r.name, emoji: pr.emoji } : null;
          }).filter(Boolean);
          if (!panelRoles.length) { log.push(`⚠️ panel ${panel.title}: ไม่มี role ที่ใช้ได้`); continue; }
          const rows = [];
          for (let i = 0; i < Math.min(panelRoles.length, 25); i += 5) {
            const row = new _ARB().addComponents(
              panelRoles.slice(i, i+5).map(r => {
                const btn = new _BB().setCustomId(`role_panel:${r.role_id}`).setLabel(r.label).setStyle(_BS.Secondary);
                if (r.emoji) try { btn.setEmoji(r.emoji); } catch {}
                return btn;
              })
            );
            rows.push(row);
          }
          const embed = new _FSEmbed().setColor(0x5865f2).setTitle(panel.title || "🎭 เลือกยศ").setDescription("กดปุ่มเพื่อรับหรือคืนยศ").setFooter({ text: "กดซ้ำเพื่อคืนยศ" });
          await panelCh.send({ embeds: [embed], components: rows });
          log.push(`✅ role panel: ${panel.title} ใน ${panelCh.name}`);
        } catch(e) { log.push(`❌ role panel ${panel.title}: ${e.message}`); }
      }

      // Step 4: Announce
      if (args.announce_channel) {
        const annCh = channelMap[args.announce_channel] || guild.channels.cache.find(c => c.name === args.announce_channel);
        if (annCh?.isTextBased()) {
          const embed = new _FSEmbed().setColor(0x2ecc71).setTitle("✅ Setup เสร็จแล้ว!").setDescription(log.join("\n").slice(0, 2000)).setTimestamp();
          await annCh.send({ embeds: [embed] });
        }
      }

      return { ok: true, steps: log.length, log: log.slice(0, 30) };
    }


    // ─── beautify_server ──────────────────────────────────────────────────────
    case "beautify_server": {
      const { ChannelType: _BCT } = await import("discord.js");

      // Preset templates: { catPre, catSuf, chPre, chSuf }
      const PRESETS = {
        aesthetic: { catPre:"✦ ", catSuf:" ✦",   chPre:"· ",  chSuf:"" },
        elegant:   { catPre:"「 ", catSuf:" 」",   chPre:"◦ ",  chSuf:"" },
        cute:      { catPre:"✿ ", catSuf:" ✿",   chPre:"˚ ",  chSuf:" ˚" },
        minimal:   { catPre:"— ", catSuf:" —",   chPre:"· ",  chSuf:"" },
        freedom:   { catPre:"𝗴 𝗮  ", catSuf:" ✧", chPre:"♡ ♧ · ", chSuf:"" },
        dark:      { catPre:"⊱ ", catSuf:" ⊰",   chPre:"⌬ ", chSuf:"" },
        kawaii:    { catPre:"❝ ", catSuf:" ❞",   chPre:"♡ ",  chSuf:" ♡" },
        custom:    {
          catPre: args.custom_cat_prefix ?? "✦ ",
          catSuf: args.custom_cat_suffix ?? " ✦",
          chPre:  args.custom_ch_prefix  ?? "· ",
          chSuf:  args.custom_ch_suffix  ?? "",
        },
      };

      const preset  = PRESETS[args.preset || "aesthetic"];
      const fStyle  = args.font_style || "bold";
      const scope   = args.scope || "all";
      const preview = args.preview_only ?? false;

      // Single-channel mode: if target_channel_id is set, only decorate that one channel
      if (args.target_channel_id) {
        const targetCh = await guild.channels.fetch(args.target_channel_id).catch(() => null);
        if (!targetCh) return { error: "ไม่เจอ channel นั้น" };
        const preset2 = PRESETS[args.preset || "aesthetic"];
        const base2   = cleanName(targetCh.name);
        const isCategory = targetCh.type === _BCT.GuildCategory;
        const newName2 = isCategory
          ? `${preset2.catPre}${applyFont(base2, args.font_style || "bold")}${preset2.catSuf}`
          : `${preset2.chPre}${base2}${preset2.chSuf}`;
        if (args.preview_only) return { ok: true, preview: true, old_name: targetCh.name, new_name: newName2 };
        await targetCh.setName(newName2, "decorate_channel");
        return { ok: true, old_name: targetCh.name, new_name: newName2, channel_id: targetCh.id };
      }

      // Collect channels/categories (position-sorted)
      const allChannels = [...guild.channels.cache.values()].sort((a,b)=>a.position-b.position);
      const categories  = allChannels.filter(c => c.type === _BCT.GuildCategory);
      const channels    = allChannels.filter(c => c.type !== _BCT.GuildCategory);

      // Strip old decoration: remove known decorator chars from start/end
      const STRIP_RE = /^[✦✿◦˚—「」❝❞⊱⊰⌬♡♧·𝗴𝗮ℓ·✧°•*~∘∙‣▸►○●◆◇✓✔✕✗❯❮→←⇒⇐⟨⟩⟪⟫『』【】〔〕《》⁺⁻⁼⁽⁾₊₋₌₍₎s!?]+|[✦✿◦˚—「」❝❞⊱⊰⌬♡♧·𝗴𝗮ℓ·✧°•*~∘∙‣▸►○●◆◇✓✔✕✗❯❮→←⇒⇐⟨⟩⟪⟫『』【】〔〕《》⁺⁻⁼⁽⁾₊₋₌₍₎s!?]+$/gu;
      function stripDeco(name) { return name.replace(STRIP_RE, '').trim() || name.trim(); }

      // Strip Unicode math chars (restore to ASCII)
      function stripFont(name) {
        // Convert math unicode letters back to ASCII a-z A-Z 0-9
        return [...name].map(c => {
          const cp = c.codePointAt(0);
          // Bold a-z 1D41A-1D433
          if(cp>=0x1D41A&&cp<=0x1D433) return String.fromCharCode(cp-0x1D41A+97);
          // Bold A-Z 1D400-1D419
          if(cp>=0x1D400&&cp<=0x1D419) return String.fromCharCode(cp-0x1D400+65);
          // Italic a-z 1D44E-1D467
          if(cp>=0x1D44E&&cp<=0x1D467) return String.fromCharCode(cp-0x1D44E+97);
          // Italic A-Z 1D434-1D44D
          if(cp>=0x1D434&&cp<=0x1D44D) return String.fromCharCode(cp-0x1D434+65);
          // Bold italic a 1D482-1D49B
          if(cp>=0x1D482&&cp<=0x1D49B) return String.fromCharCode(cp-0x1D482+97);
          if(cp>=0x1D468&&cp<=0x1D481) return String.fromCharCode(cp-0x1D468+65);
          // Script a 1D4B6-1D4CF
          if(cp>=0x1D4B6&&cp<=0x1D4CF) return String.fromCharCode(cp-0x1D4B6+97);
          if(cp>=0x1D49C&&cp<=0x1D4B5) return String.fromCharCode(cp-0x1D49C+65);
          // Bold script 1D4EA-1D503 / 1D4D0-1D4E9
          if(cp>=0x1D4EA&&cp<=0x1D503) return String.fromCharCode(cp-0x1D4EA+97);
          if(cp>=0x1D4D0&&cp<=0x1D4E9) return String.fromCharCode(cp-0x1D4D0+65);
          // Fraktur 1D51E-1D537 / 1D504-1D51D
          if(cp>=0x1D51E&&cp<=0x1D537) return String.fromCharCode(cp-0x1D51E+97);
          if(cp>=0x1D504&&cp<=0x1D51D) return String.fromCharCode(cp-0x1D504+65);
          // Double 1D552-1D56B / 1D538-1D551
          if(cp>=0x1D552&&cp<=0x1D56B) return String.fromCharCode(cp-0x1D552+97);
          if(cp>=0x1D538&&cp<=0x1D551) return String.fromCharCode(cp-0x1D538+65);
          // Mono 1D68A-1D6A3 / 1D670-1D689
          if(cp>=0x1D68A&&cp<=0x1D6A3) return String.fromCharCode(cp-0x1D68A+97);
          if(cp>=0x1D670&&cp<=0x1D689) return String.fromCharCode(cp-0x1D670+65);
          // Fullwidth A-Z FF21-FF3A / a-z FF41-FF5A
          if(cp>=0xFF21&&cp<=0xFF3A) return String.fromCharCode(cp-0xFF21+65);
          if(cp>=0xFF41&&cp<=0xFF5A) return String.fromCharCode(cp-0xFF41+97);
          return c;
        }).join('');
      }

      function cleanName(name) { return stripFont(stripDeco(name)); }

      // Apply font to category name
      function applyFont(name, style) {
        if (!style || style === 'none') return name.toUpperCase();
        return _fontify(name.toUpperCase(), style);
      }

      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const log = [], previews = [];
      let renamed = 0, skipped = 0;

      // Rename categories
      if (scope === 'all' || scope === 'categories') {
        for (const cat of categories) {
          const base = cleanName(cat.name);
          const newName = `${preset.catPre}${applyFont(base, fStyle)}${preset.catSuf}`;
          if (newName === cat.name) { skipped++; continue; }
          previews.push(`📁 ${cat.name} → ${newName}`);
          if (!preview) {
            try {
              await cat.setName(newName, 'beautify_server');
              renamed++;
              log.push(`✅ ${newName}`);
            } catch(e) { log.push(`❌ ${cat.name}: ${e.message}`); }
            await sleep(600); // respect Discord rate limit
          }
        }
      }

      // Rename channels
      if (scope === 'all' || scope === 'channels') {
        for (const ch of channels) {
          const base = cleanName(ch.name);
          if (!base) { skipped++; continue; }
          const newName = `${preset.chPre}${base}${preset.chSuf}`;
          if (newName === ch.name) { skipped++; continue; }
          previews.push(`${ch.type===2?'🔊':'#'} ${ch.name} → ${newName}`);
          if (!preview) {
            try {
              await ch.setName(newName, 'beautify_server');
              renamed++;
              log.push(`✅ ${newName}`);
            } catch(e) { log.push(`❌ ${ch.name}: ${e.message}`); }
            await sleep(600);
          }
        }
      }

      // Send preview embed
      const { EmbedBuilder: _BE } = await import("discord.js");
      const previewText = previews.slice(0, 20).join('\n') + (previews.length > 20 ? `
…+${previews.length-20} รายการ` : '');
      const embed = new _BE()
        .setColor(preview ? 0xf39c12 : 0x2ecc71)
        .setTitle(preview ? `👁️ ตัวอย่าง — ${args.preset||'aesthetic'} (ยังไม่ได้ rename)` : `✅ ตกแต่งเสร็จแล้ว!`)
        .setDescription(previewText || 'ไม่มีห้องที่ต้องเปลี่ยน')
        .addFields(
          { name: 'Preset', value: args.preset||'aesthetic', inline: true },
          { name: 'Font', value: fStyle, inline: true },
          { name: preview ? 'จะ rename' : 'Renamed', value: `${preview?previews.length:renamed} ห้อง`, inline: true },
        );
      if (preview) embed.setFooter({ text: 'พูด "ยืนยัน beautify" หรือ "ทำเลย" เพื่อ rename จริง' });
      await channel.send({ embeds: [embed] });

      return preview
        ? { ok: true, preview: true, will_rename: previews.length }
        : { ok: true, renamed, skipped, preset: args.preset||'aesthetic', font: fStyle };
    }

    // ─── stylize_text ─────────────────────────────────────────────────────────
    case "stylize_text": {
      const STYLE_LABELS = {
        bold:        "𝗕𝗼𝗹𝗱",
        italic:      "𝐼𝑡𝑎𝑙𝑖𝑐",
        bold_italic: "𝙱𝚘𝚕𝚍 𝙸𝚝𝚊𝚕𝚒𝚌",
        script:      "𝒮𝒸𝓇𝒾𝓅𝓉",
        bold_script: "𝓑𝓸𝓵𝓭 𝓢𝓬𝓻𝓲𝓹𝓽",
        fraktur:     "𝔉𝔯𝔞𝔨𝔱𝔲𝔯",
        double:      "𝔻𝕠𝕦𝕓𝕝𝕖",
        mono:        "𝙼𝚘𝚗𝚘",
        wide:        "Ｗｉｄｅ",
        small_caps:  "Sᴍᴀʟʟ ᴄᴀᴘs",
      };
      const inputText = String(args.text || "").slice(0, 80);
      if (!inputText) return { error: "text required" };

      if (args.show_all) {
        // Show all styles as an embed
        const { EmbedBuilder: _SE } = await import("discord.js");
        const fields = Object.entries(STYLE_LABELS).map(([key, label]) => ({
          name: label,
          value: `\`${_fontify(inputText, key)}\``,
          inline: false,
        }));
        const embed = new _SE()
          .setColor(0x9b59b6)
          .setTitle("✨ Unicode Font Styles")
          .setDescription(`ข้อความ: **${inputText}**
เลือกสไตล์แล้วบอกการ์ด เช่น "เอาแบบ bold_script"`)
          .addFields(fields)
          .setFooter({ text: "ใช้ได้กับชื่อ category · voice channel · role · embed" });
        await channel.send({ embeds: [embed] });
        return { ok: true, preview: "แสดงทุกสไตล์แล้ว" };
      }

      const style = args.style || "bold_script";
      const result = _fontify(inputText, style);
      return { ok: true, original: inputText, style, result, tip: "ใช้ชื่อนี้ได้กับ: category, voice channel, role, embed title" };
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
        const XLSXModule = await import("xlsx");
        const XLSX = XLSXModule.default ?? XLSXModule;
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


    // ─── Translate ────────────────────────────────────────────────────────────
    case "translate": {
      const { text, from = "auto", to = "en" } = args;
      if (!text) return { error: "text required" };
      return translateText(text, { from, to });
    }

    // ─── Role management ──────────────────────────────────────────────────────
    case "create_role": {
      if (!args.name) return { error: "name required" };
      try {
        const COLOR_MAP = { red:"#FF0000",blue:"#0000FF",green:"#00FF00",yellow:"#FFFF00",purple:"#800080",pink:"#FFC0CB",orange:"#FFA500",gold:"#FFD700",silver:"#C0C0C0",white:"#FFFFFF",black:"#000000",cyan:"#00FFFF" };
        const roleOpts = { name: args.name };
        if (args.color) roleOpts.color = args.color.startsWith("#") ? args.color : (COLOR_MAP[args.color.toLowerCase()] || "#99AAB5");
        if (args.hoist !== undefined) roleOpts.hoist = args.hoist;
        if (args.mentionable !== undefined) roleOpts.mentionable = args.mentionable;
        if (args.reason) roleOpts.reason = args.reason;
        const role = await guild.roles.create(roleOpts);
        return { ok: true, role_id: role.id, name: role.name, color: role.hexColor, position: role.position };
      } catch (err) { return { error: err?.message || "create_role failed" }; }
    }

    case "delete_role": {
      if (!args.role_name) return { error: "role_name required" };
      try {
        const roles = await guild.roles.fetch();
        const q = (args.role_name || "").toLowerCase().trim();
        const role = roles.find(r => r.name.toLowerCase() === q) || roles.find(r => r.name.toLowerCase().includes(q));
        if (!role) return { error: "ไม่เจอ role: " + args.role_name };
        if (role.managed) return { error: "Role " + role.name + " ถูกจัดการโดย integration ลบไม่ได้" };
        await role.delete(args.reason || "admin request");
        return { ok: true, deleted: role.name };
      } catch (err) { return { error: err?.message || "delete_role failed" }; }
    }

    case "edit_role": {
      if (!args.role_name) return { error: "role_name required" };
      try {
        const roles = await guild.roles.fetch();
        const q = (args.role_name || "").toLowerCase().trim();
        const role = roles.find(r => r.name.toLowerCase() === q) || roles.find(r => r.name.toLowerCase().includes(q));
        if (!role) return { error: "ไม่เจอ role: " + args.role_name };
        const COLOR_MAP = { red:"#FF0000",blue:"#0000FF",green:"#00FF00",yellow:"#FFFF00",purple:"#800080",pink:"#FFC0CB",orange:"#FFA500",gold:"#FFD700" };
        const editData = {};
        if (args.new_name !== undefined) editData.name = args.new_name;
        if (args.color !== undefined) editData.color = args.color.startsWith("#") ? args.color : (COLOR_MAP[args.color.toLowerCase()] || args.color);
        if (args.hoist !== undefined) editData.hoist = args.hoist;
        if (args.mentionable !== undefined) editData.mentionable = args.mentionable;
        await role.edit(editData, args.reason);
        return { ok: true, role_id: role.id, name: role.name, color: role.hexColor };
      } catch (err) { return { error: err?.message || "edit_role failed" }; }
    }

    // ─── Create invite ────────────────────────────────────────────────────────
    case "create_invite": {
      try {
        const targetCh = args.channel_id ? await guild.channels.fetch(args.channel_id).catch(() => channel) : channel;
        if (!targetCh) return { error: "channel not found" };
        const inv = await targetCh.createInvite({
          maxUses: args.max_uses || 0,
          maxAge: args.max_age_hours !== undefined ? Math.round(args.max_age_hours * 3600) : 86400,
          temporary: args.temporary || false,
          reason: args.reason || "admin request",
        });
        return { ok: true, url: "https://discord.gg/" + inv.code, code: inv.code, max_uses: inv.maxUses || "unlimited", expires_in: inv.maxAge ? (inv.maxAge / 3600) + " ชั่วโมง" : "ไม่หมดอายุ", channel: targetCh.name };
      } catch (err) { return { error: err?.message || "create_invite failed" }; }
    }

    // ─── Get member info ──────────────────────────────────────────────────────
    case "get_member_info": {
      if (!args.user_id) return { error: "user_id required" };
      try {
        const member = await guild.members.fetch(args.user_id);
        const roles = member.roles.cache.filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position).map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
        return {
          ok: true,
          user_id: member.id,
          username: member.user.username,
          display_name: member.displayName,
          global_name: member.user.globalName || null,
          bot: member.user.bot,
          avatar_url: member.user.displayAvatarURL({ size: 256 }),
          joined_server: member.joinedAt?.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) || null,
          account_created: member.user.createdAt?.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) || null,
          is_admin: member.permissions.has(PermissionFlagsBits.Administrator),
          is_timed_out: !!member.communicationDisabledUntil,
          timeout_until: member.communicationDisabledUntil?.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) || null,
          voice_channel: member.voice?.channel?.name || null,
          voice_muted: member.voice?.serverMute || false,
          voice_deafened: member.voice?.serverDeaf || false,
          nickname: member.nickname || null,
          roles: roles.slice(0, 20),
          role_count: roles.length,
          boost_since: member.premiumSince?.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) || null,
        };
      } catch (err) { return { error: err?.message || "get_member_info failed" }; }
    }

    // ─── Add reaction ─────────────────────────────────────────────────────────
    case "add_reaction": {
      if (!args.message_id || !args.emoji) return { error: "message_id and emoji required" };
      try {
        const targetCh = args.channel_id ? await guild.channels.fetch(args.channel_id).catch(() => channel) : channel;
        if (!targetCh) return { error: "channel not found" };
        const msg = await targetCh.messages.fetch(args.message_id);
        await msg.react(args.emoji);
        return { ok: true, emoji: args.emoji, message_id: args.message_id };
      } catch (err) { return { error: err?.message || "add_reaction failed" }; }
    }

    // ─── Server stats ─────────────────────────────────────────────────────────
    case "server_stats": {
      try {
        const g = ctx.guild;
        await g.fetch();
        const members = await g.members.fetch();
        const channels = await g.channels.fetch();
        const roles = await g.roles.fetch();
        let online = 0, idle = 0, dnd = 0, offline = 0, bots = 0, inVoice = 0;
        for (const m of members.values()) {
          if (m.user.bot) { bots++; continue; }
          const s = m.presence?.status || "offline";
          if (s === "online") online++; else if (s === "idle") idle++; else if (s === "dnd") dnd++; else offline++;
        }
        let textCh = 0, voiceCh = 0, catCh = 0, threadCh = 0, forumCh = 0;
        for (const c of channels.values()) {
          if (!c) continue;
          if (c.type === ChannelType.GuildText) textCh++;
          else if (c.type === ChannelType.GuildVoice) { voiceCh++; inVoice += c.members?.size || 0; }
          else if (c.type === ChannelType.GuildCategory) catCh++;
          else if (c.type === ChannelType.PublicThread || c.type === ChannelType.PrivateThread) threadCh++;
          else if (c.type === ChannelType.GuildForum) forumCh++;
        }
        return {
          guild_name: g.name, total_members: members.size, humans: members.size - bots, bots,
          online, idle, dnd, offline, in_voice: inVoice,
          channels: { text: textCh, voice: voiceCh, categories: catCh, threads: threadCh, forums: forumCh, total: channels.size },
          roles: roles.size, boost_level: g.premiumTier, boosts: g.premiumSubscriptionCount || 0,
          verification_level: g.verificationLevel,
          created_at: g.createdAt?.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
        };
      } catch (err) { return { error: err?.message || "server_stats failed" }; }
    }


    // ─── Group sleep mode ─────────────────────────────────────────────────────
    case "set_group_sleep": {
      let parsed;
      try {
        parsed = parseDurationToFireAt({ seconds: args.seconds, minutes: args.minutes, hours: args.hours });
      } catch (e) {
        return { error: e.message };
      }
      // Snapshot who is currently in voice for the summary
      let voiceCount = 0;
      try {
        const channels = await ctx.guild.channels.fetch();
        for (const ch of channels.values()) {
          if (ch?.type === ChannelType.GuildVoice) voiceCount += ch.members?.size || 0;
        }
      } catch {}
      const t = createTimer({
        type: "group_sleep",
        fireAt: parsed.fireAt,
        label: args.label || "Group sleep mode",
        guildId: ctx.guild.id,
        channelId: ctx.channel?.id || null,
        userId: ctx.authorId || null,
        mentionUserId: ctx.authorId || null,
        ownerId: ctx.authorId || null,
        payload: { voiceSnapshotCount: voiceCount },
      });
      return {
        ok: true,
        timer_id: t.id,
        in: formatDurationShort(parsed.totalSeconds),
        fires_at_bangkok: formatClockBangkok(t.fireAt),
        label: t.label,
        voice_members_now: voiceCount,
        note: "จะเตะทุกคนออกจากทุกห้องเสียงเมื่อครบเวลา — มีปุ่มยกเลิก",
      };
    }


    // ─── announce ─────────────────────────────────────────────────────────────
    case "announce": {
      ctx._toolSentMessage = true;
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found or not text-based" };
      const embed = new EmbedBuilder().setColor(resolveColor(args.color));
      if (args.author)        embed.setAuthor({ name: String(args.author).slice(0, 256) });
      if (args.title)         embed.setTitle(String(args.title).slice(0, 256));
      if (args.description)   embed.setDescription(String(args.description).slice(0, 4096));
      if (args.thumbnail_url) embed.setThumbnail(args.thumbnail_url);
      if (args.image_url)     embed.setImage(args.image_url);
      if (args.footer)        embed.setFooter({ text: String(args.footer).slice(0, 2048) });
      if (Array.isArray(args.fields)) {
        for (const f of args.fields.slice(0, 25)) {
          if (f?.name && f?.value)
            embed.addFields({ name: String(f.name).slice(0,256), value: String(f.value).slice(0,1024), inline: !!f.inline });
        }
      }
      embed.setTimestamp();
      const content = args.mention ? String(args.mention) : undefined;
      const msg = await targetCh.send({ content, embeds: [embed] });
      return { ok: true, message_id: msg.id, channel: targetCh.name };
    }

    // ─── generate_image ───────────────────────────────────────────────────────
    case "generate_image": {
      ctx._toolSentMessage = true;
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found" };
      const imgResult = await generateImage(args.prompt, { width: args.width || 1024, height: args.height || 1024 });
      if (imgResult.error) return { error: imgResult.error };
      const { AttachmentBuilder } = await import("discord.js");
      const attachment = new AttachmentBuilder(imgResult.imageBuffer, { name: "generated.png" });
      const descText = String(args.prompt).slice(0, 200);
      const embed = new EmbedBuilder()
        .setColor(0x6c5ce7)
        .setTitle("🎨 AI Image")
        .setDescription("> " + descText)
        .setImage("attachment://generated.png")
        .setFooter({ text: "Powered by Pollinations.ai" })
        .setTimestamp();
      await targetCh.send({ embeds: [embed], files: [attachment] });
      return { ok: true, prompt: args.prompt };
    }

    // ─── get_avatar ───────────────────────────────────────────────────────────
    case "get_avatar": {
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found" };
      try {
        const member = await ctx.guild.members.fetch(args.user_id);
        const user = member.user;
        const avatarUrl = user.displayAvatarURL({ size: 4096, extension: "png", forceStatic: false });
        const { EmbedBuilder: _EB } = await import("discord.js");
        const embed = new _EB()
          .setColor(0x5865f2)
          .setTitle(`🖼️ รูปโปรไฟล์ของ ${member.displayName}`)
          .setImage(avatarUrl)
          .setFooter({ text: `${user.tag || user.username} · คลิกขวา → "เปิดลิงก์" เพื่อดูรูปต้นฉบับ 4K` })
          .setTimestamp();
        await targetCh.send({ embeds: [embed] });
        return { ok: true, user: member.displayName, avatar_url: avatarUrl };
      } catch (err) {
        return { error: err?.message || "get_avatar failed" };
      }
    }

    // ─── create_poll ──────────────────────────────────────────────────────────
    case "create_poll": {
      ctx._toolSentMessage = true;
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found" };
      const answers = (args.answers || []).slice(0, 10).filter(a => a?.trim?.());
      if (answers.length < 2) return { error: "ต้องมีตัวเลือกอย่างน้อย 2 อัน" };
      const durationHours = Math.min(Math.max(Number(args.duration_hours) || 24, 1), 168);
      try {
        const msg = await targetCh.send({
          poll: {
            question: { text: String(args.question).slice(0, 300) },
            answers: answers.map(a => ({ text: String(a).slice(0, 55) })),
            duration: durationHours,
            allowMultiselect: !!args.allow_multiselect,
          },
        });
        return { ok: true, message_id: msg.id, duration_hours: durationHours, answer_count: answers.length };
      } catch (err) {
        return { error: "create_poll failed: " + (err?.message || String(err)) };
      }
    }

    // ─── create_event ─────────────────────────────────────────────────────────
    case "create_event": {
      const { GuildScheduledEventPrivacyLevel, GuildScheduledEventEntityType } = await import("discord.js");
      let startTime;
      try { startTime = new Date(args.start_iso); if (isNaN(startTime)) throw new Error("invalid date"); }
      catch { return { error: "start_iso ไม่ถูกรูปแบบ ใช้ ISO 8601 เช่น '2026-05-10T19:00:00+07:00'" }; }
      const endTime = args.end_iso ? new Date(args.end_iso) : null;
      let entityType, eventChannel, entityMetadata;
      if (args.channel_id) {
        entityType = GuildScheduledEventEntityType.Voice;
        eventChannel = args.channel_id;
      } else {
        entityType = GuildScheduledEventEntityType.External;
        entityMetadata = { location: args.location || "Online" };
      }
      const eventData = {
        name: String(args.name).slice(0, 100),
        scheduledStartTime: startTime,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType,
      };
      if (args.description) eventData.description = String(args.description).slice(0, 1000);
      if (endTime && !isNaN(endTime)) eventData.scheduledEndTime = endTime;
      if (eventChannel) eventData.channel = eventChannel;
      if (entityMetadata) eventData.entityMetadata = entityMetadata;
      try {
        const event = await ctx.guild.scheduledEvents.create(eventData);
        return { ok: true, event_id: event.id, name: event.name, start: event.scheduledStartAt?.toISOString() };
      } catch (err) {
        return { error: "create_event failed: " + (err?.message || String(err)) };
      }
    }

    // ─── random_pick ──────────────────────────────────────────────────────────
    case "random_pick": {
      const rCount = Math.min(Math.max(Number(args.count) || 1, 1), 20);
      if (args.type === "coin") {
        const results = Array.from({ length: rCount }, () => Math.random() < 0.5 ? "หัว 🪙" : "ก้อย 🔵");
        return { ok: true, results, summary: rCount === 1 ? results[0] : results.join(", ") };
      }
      if (args.type === "dice") {
        const sides = Math.min(Math.max(Number(args.sides) || 6, 2), 100);
        const rolls = Array.from({ length: rCount }, () => Math.floor(Math.random() * sides) + 1);
        const total = rolls.reduce((a, b) => a + b, 0);
        return { ok: true, rolls, total, sides, summary: rCount === 1 ? "🎲 " + rolls[0] : "🎲 [" + rolls.join(", ") + "] รวม " + total };
      }
      if (args.type === "number") {
        const nMin = Number(args.min) || 1;
        const nMax = Number(args.max) || 100;
        const nums = Array.from({ length: rCount }, () => Math.floor(Math.random() * (nMax - nMin + 1)) + nMin);
        return { ok: true, numbers: nums, summary: rCount === 1 ? "🔢 " + nums[0] : "🔢 [" + nums.join(", ") + "]" };
      }
      if (args.type === "list") {
        const items = args.items || [];
        if (!items.length) return { error: "ต้องส่ง items" };
        const pool = [...items];
        const pickCount = Math.min(rCount, pool.length);
        const picks = [];
        for (let i = 0; i < pickCount; i++) {
          const idx = Math.floor(Math.random() * pool.length);
          picks.push(pool.splice(idx, 1)[0]);
        }
        return { ok: true, picks, summary: pickCount === 1 ? "🎯 " + picks[0] : "🎯 " + picks.join(", ") };
      }
      if (args.type === "member") {
        let pool = [];
        if (args.channel_id) {
          const ch = await ctx.guild.channels.fetch(args.channel_id).catch(() => null);
          if (ch?.type === ChannelType.GuildVoice) pool = [...ch.members.values()].filter(m => !m.user.bot);
        } else {
          const channels = await ctx.guild.channels.fetch();
          for (const ch of channels.values()) {
            if (ch?.type === ChannelType.GuildVoice) pool.push(...[...ch.members.values()].filter(m => !m.user.bot));
          }
        }
        if (!pool.length) return { error: "ไม่มีสมาชิกในห้องเสียงที่ระบุ" };
        const pickCount = Math.min(Number(args.count_members) || rCount, pool.length);
        const copy = [...pool];
        const picks = [];
        for (let i = 0; i < pickCount; i++) {
          const idx = Math.floor(Math.random() * copy.length);
          picks.push(copy.splice(idx, 1)[0]);
        }
        return { ok: true, picks: picks.map(m => ({ id: m.id, name: m.displayName })), summary: "🎯 " + picks.map(m => m.displayName).join(", ") };
      }
      return { error: "type ไม่ถูกต้อง: coin/dice/number/list/member" };
    }

    // ─── search_members ───────────────────────────────────────────────────────
    case "search_members": {
      await ctx.guild.members.fetch();
      let members = [...ctx.guild.members.cache.values()];
      if (args.role_name) {
        const role = ctx.guild.roles.cache.find(r => r.name.toLowerCase() === String(args.role_name).toLowerCase());
        if (!role) return { error: "ไม่พบ role \"" + args.role_name + "\"" };
        members = members.filter(m => m.roles.cache.has(role.id));
      }
      if (args.name_contains) {
        const q = String(args.name_contains).toLowerCase();
        members = members.filter(m => m.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q));
      }
      if (args.in_voice === true)    members = members.filter(m => !!m.voice?.channel);
      if (args.is_boosting === true) members = members.filter(m => !!m.premiumSince);
      if (args.is_bot !== undefined) members = members.filter(m => m.user.bot === !!args.is_bot);
      if (args.status) {
        members = members.filter(m => (m.presence?.status || "offline") === args.status);
      }
      const smLimit = Math.min(Number(args.limit) || 25, 100);
      const results = members.slice(0, smLimit).map(m => ({
        id: m.id, name: m.displayName, username: m.user.tag,
        in_voice: !!m.voice?.channel, boosting: !!m.premiumSince,
        status: m.presence?.status || "offline",
      }));
      return { ok: true, count: members.length, shown: results.length, members: results };
    }

    // ─── give_role_to_all ─────────────────────────────────────────────────────
    case "give_role_to_all": {
      const gRole = ctx.guild.roles.cache.find(r => r.name.toLowerCase() === String(args.role_name).toLowerCase());
      if (!gRole) return { error: "ไม่พบ role \"" + args.role_name + "\"" };
      await ctx.guild.members.fetch();
      let gMembers = [...ctx.guild.members.cache.values()];
      if (args.exclude_bots !== false) gMembers = gMembers.filter(m => !m.user.bot);
      if (args.filter_role) {
        const fr = ctx.guild.roles.cache.find(r => r.name.toLowerCase() === String(args.filter_role).toLowerCase());
        if (fr) gMembers = gMembers.filter(m => m.roles.cache.has(fr.id));
      }
      if (args.only_without !== false) gMembers = gMembers.filter(m => !m.roles.cache.has(gRole.id));
      if (!gMembers.length) return { ok: true, given: 0, note: "ทุกคนมี role นี้อยู่แล้ว" };
      let given = 0, gFailed = 0;
      for (const m of gMembers) {
        try { await m.roles.add(gRole, args.reason || "give_role_to_all"); given++; await new Promise(r => setTimeout(r, 250)); }
        catch { gFailed++; }
        if (given + gFailed >= 100) break;
      }
      return { ok: true, given, failed: gFailed, role: gRole.name, total_eligible: gMembers.length };
    }

    // ─── list_role_members ────────────────────────────────────────────────────
    case "list_role_members": {
      const lRole = ctx.guild.roles.cache.find(r => r.name.toLowerCase() === String(args.role_name).toLowerCase());
      if (!lRole) return { error: "ไม่พบ role \"" + args.role_name + "\"" };
      await ctx.guild.members.fetch();
      const lMembers = [...lRole.members.values()];
      return {
        ok: true, role: lRole.name, count: lMembers.length,
        members: lMembers.slice(0, 50).map(m => ({
          id: m.id, name: m.displayName, status: m.presence?.status || "offline", in_voice: !!m.voice?.channel,
        })),
      };
    }

    // ─── chart ────────────────────────────────────────────────────────────────
    case "chart": {
      ctx._toolSentMessage = true;
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found" };
      const PALETTE = ["#5865F2","#57F287","#FEE75C","#ED4245","#EB459E","#00B0F4","#F47B67","#7289DA"];
      const noScale = ["pie","doughnut","polarArea","radar"].includes(args.chart_type);
      const chartConfig = {
        type: args.chart_type,
        data: {
          labels: args.labels,
          datasets: (args.datasets || []).map((ds, i) => ({
            label: ds.label || ("Dataset " + (i+1)),
            data: ds.data,
            backgroundColor: ds.color || PALETTE[i % PALETTE.length],
            borderColor: ds.color || PALETTE[i % PALETTE.length],
            fill: false, tension: 0.3,
          })),
        },
        options: {
          plugins: {
            title: { display: !!args.title, text: args.title || "", color: "#ffffff", font: { size: 18 } },
            legend: { labels: { color: "#ffffff" } },
          },
          scales: noScale ? {} : {
            x: { ticks: { color: "#ffffff" }, grid: { color: "#444" } },
            y: { ticks: { color: "#ffffff" }, grid: { color: "#444" } },
          },
        },
      };
      const chartResult = await getQuickChart(chartConfig);
      if (chartResult.error) return { error: chartResult.error };
      const { AttachmentBuilder } = await import("discord.js");
      const chartAttach = new AttachmentBuilder(chartResult.imageBuffer, { name: "chart.png" });
      const chartEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(args.title ? "📊 " + args.title : "📊 Chart")
        .setImage("attachment://chart.png").setTimestamp();
      await targetCh.send({ embeds: [chartEmbed], files: [chartAttach] });
      return { ok: true, chart_type: args.chart_type };
    }

    // ─── shorten_url ──────────────────────────────────────────────────────────
    case "shorten_url": {
      const sResult = await shortenUrl(args.url);
      return sResult.ok ? { ok: true, short_url: sResult.short_url, original: sResult.original } : { error: sResult.error };
    }

    // ─── define ───────────────────────────────────────────────────────────────
    case "define": {
      if (args.style === "slang") {
        const uResult = await urbanDefine(args.word);
        return uResult.error ? { error: uResult.error } : { ok: true, word: uResult.word, type: "slang", results: uResult.results };
      }
      const dResult = await defineWord(args.word);
      return dResult.error ? { error: dResult.error } : { ok: true, word: dResult.word, phonetic: dResult.phonetic, type: "formal", meanings: dResult.meanings };
    }

    // ─── trivia ───────────────────────────────────────────────────────────────
    case "trivia": {
      ctx._toolSentMessage = true;
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found" };
      const tResult = await getTrivia({ category: args.category, difficulty: args.difficulty });
      if (tResult.error) return { error: tResult.error };
      const DIFF_COLOR = { easy: 0x2ecc71, medium: 0xf1c40f, hard: 0xe74c3c };
      const letters = ["🇦","🇧","🇨","🇩","🇪","🇫"];
      const choiceLines = tResult.choices.map((c, i) => letters[i] + " " + c).join("\n");
      const triviaEmbed = new EmbedBuilder()
        .setColor(DIFF_COLOR[tResult.difficulty] || 0x5865F2)
        .setTitle("🧠 Trivia — " + tResult.category)
        .setDescription("**" + tResult.question + "**\n\n" + choiceLines)
        .setFooter({ text: "ระดับ: " + tResult.difficulty + " • เฉลยใน 30 วินาที" })
        .setTimestamp();
      const triviaMsg = await targetCh.send({ embeds: [triviaEmbed] });
      setTimeout(async () => {
        const revealEmbed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle("✅ เฉลย!")
          .setDescription("**" + tResult.question + "**\n\n**คำตอบ:** " + tResult.correct);
        await triviaMsg.reply({ embeds: [revealEmbed] }).catch(() => {});
      }, 30_000);
      return { ok: true, question: tResult.question, choices: tResult.choices, correct: tResult.correct, reveals_in: "30 วินาที" };
    }

    // ─── set_channel_topic ────────────────────────────────────────────────────
    case "set_channel_topic": {
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh) return { error: "channel not found" };
      if (!targetCh.setTopic) return { error: "ห้องนี้ไม่รองรับ topic" };
      const topic = String(args.topic || "").slice(0, 1024);
      await targetCh.setTopic(topic);
      return { ok: true, channel: targetCh.name, topic };
    }

    // ─── purge_user_messages ──────────────────────────────────────────────────
    case "purge_user_messages": {
      const targetCh = args.channel_id
        ? await ctx.guild.channels.fetch(args.channel_id).catch(() => null)
        : ctx.channel;
      if (!targetCh?.isTextBased?.()) return { error: "channel not found" };
      let puMember;
      try { puMember = await ctx.guild.members.fetch(args.user_id); }
      catch { return { error: "user not found" }; }
      const scanLimit = Math.min(Number(args.limit) || 100, 500);
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const msgs = await targetCh.messages.fetch({ limit: Math.min(scanLimit, 100) });
      const toDelete = [...msgs.values()].filter(m => m.author.id === args.user_id && m.createdTimestamp > cutoff);
      if (!toDelete.length) return { ok: true, deleted: 0, note: "ไม่พบข้อความของ user นี้ (ภายใน 14 วัน)" };
      await targetCh.bulkDelete(toDelete, true);
      return { ok: true, deleted: toDelete.length, user: puMember.displayName, channel: targetCh.name };
    }

    // ─── get_bot_info ─────────────────────────────────────────────────────────
    case "get_bot_info": {
      const botClient = ctx.guild.client;
      const uptimeSec = Math.floor((botClient.uptime || 0) / 1000);
      const btH = Math.floor(uptimeSec / 3600), btM = Math.floor((uptimeSec % 3600) / 60), btS = uptimeSec % 60;
      const mem = process.memoryUsage();
      return {
        ok: true, bot_name: botClient.user?.tag,
        uptime: btH + "h " + btM + "m " + btS + "s",
        uptime_seconds: uptimeSec,
        ping_ms: botClient.ws.ping,
        guilds: botClient.guilds.cache.size,
        memory_mb: Math.round(mem.rss / 1024 / 1024),
        heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
        node_version: process.version,
      };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}

// Build a compact server snapshot so the agent doesn't always need to call
// list_* first. Keeps the first turn to a single LLM call for simple commands.
async function buildServerSnapshot(guild, ctx) {
  try {
    const channels = await guild.channels.fetch();
    const voiceChannels = [];
    const textChannels = [];
    for (const c of channels.values()) {
      if (!c) continue;
      if (!canAuthorViewChannel(c, ctx)) continue;
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

const AGENT_SYSTEM = `You are "การ์ด" — AI ผู้ช่วยส่วนตัวที่ซื่อสัตย์และดูแลใจของ Alxcer Guard server คุณพูดภาษาไทยเป็นหลัก เข้าใจทั้งภาษาไทยและอังกฤษ มีน้ำใจอบอุ่น ดูแลทุกคนเหมือนคนในครอบครัว ไม่ใช่หุ่นยนต์

SECURITY BOUNDARY: shell/files/logs/source/browser-host tools are reserved for the bot owner (⭐ OWNER) only. A server moderator with Manage Server is not the host owner; never ask them for secrets and never try to bypass a denied tool. Voice and text commands use the same Discord permission checks; never demand a magic confirmation phrase.

เจ้าของบอทคือ "Alex" — Discord username: lorde (แต่ชื่อที่เรียกคือ "Alex" เสมอ) ถ้าใน context มี "⭐ OWNER" หรือ "👑 OWNER" แปลว่าผู้สั่งคือ Alex เจ้าของตัวจริง รับคำสั่งด้วยความยินดีและเต็มที่ พูดจาอบอุ่นและจริงใจ Alex มีสิทธิ์เต็มทุกอย่างรวมถึงคำสั่ง AI และการจัดการโมเดล
ข้อสำคัญ: ถ้าเห็น authorTag ว่า "lorde" หรือ username "lorde" นั่นคือ Alex เจ้าของบอท ให้เรียกชื่อ "Alex" เสมอ ไม่ใช่ "lorde"

คุณพูดจาเหมือน "คนรับใช้ที่อบอุ่นและทุ่มเท" — ทุกคนในเซิร์ฟเวอร์คือคนที่คุณดูแลและห่วงใย เรียกชื่อ display name ของแต่ละคนด้วยความอบอุ่น ทำทุกอย่างด้วยความยินดี ไม่บ่น ไม่งอแง

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

Channels / rooms:
  • "สร้างห้องเสียง X" / "create voice channel X"           → create_channel({name:X, type:"voice"})
  • "สร้างห้องแชต X" / "สร้างห้องข้อความ X"                 → create_channel({name:X, type:"text"})
  • "สร้างหมวด X" / "create category X"                     → create_category({name:X})
  • "เปลี่ยนชื่อห้อง X เป็น Y"                                → resolve_channel(X) → edit_channel({channel_id, name:Y})
  • "ลบห้อง X"                                                → resolve_channel(X) → delete_channel({channel_id})
  • "ล็อก/ปลดล็อกห้อง X"                                     → resolve_channel(X, kind:"text") → lock_channel({channel_id, lock:true/false})
  • "ตั้ง slowmode ห้อง X N วินาที"                            → resolve_channel(X, kind:"text") → set_slowmode({channel_id, seconds:N})

Messages:
  • "ลบ N ข้อความ" / "เคลียร์ N ข้อความ" / "purge N"        → bulk_delete_messages(count=N)
  • "ปักหมุดข้อความนี้" / "pin"                            → pin_message
  • "เอาหมุดออก" / "unpin"                                 → unpin_message

Logs / history:
  • "ตรวจสอบบันทึก" / "ใครทำอะไรบ้าง" / "ดูประวัติล่าสุด"  → get_recent_offenses
  • "ดูประวัติ X" / "X ทำผิดอะไรบ้าง"                       → get_user_offenses(X)
  • "เคลียร์ประวัติ X" / "ล้างบันทึก X"                     → clear_user_offenses(X)

Timers / alarms / sleep mode:
  • "ตั้งเวลา N นาที" / "เตือนใน N วินาที" / "นับถอยหลัง N" / "remind me in N min" → set_timer({minutes/seconds/hours, label})
  • "ปลุก ตี 7" / "ปลุก 06:30" / "alarm at 7am" / "ตั้งนาฬิกาปลุก 06:30:15"      → set_alarm({hour, minute, second?})
  • "ปลุกแบบมีเพลง" / "ปลุกพร้อมเพลง" / "wake me up with music"                    → set_alarm({..., play_wake_music: true})
  • "sleep mode N นาที/ชม" / "เตะกูออกใน N" / "ดีดออกใน N" / "ปลุกตัวเอง N"       → set_self_disconnect({hours?, minutes?, seconds?, user_id?})
  • "sleep ทุกคน N" / "เตะทุกคนออกใน N" / "ปิดเซิร์ฟใน N" / "group sleep N"       → set_group_sleep({hours?, minutes?, seconds?, label?})
  • "ปิดไมค์ A 30 วินาที" / "mute A 5 นาที" / "ปิดเสียง A สัก 1 นาที"              → mute_user_for({user_id, seconds/minutes})
  • "ดูตัวจับเวลา" / "list timers" / "มีอันไหนตั้งอยู่บ้าง"                          → list_timers()
  • "ยกเลิกตัวจับเวลา <id>" / "cancel timer <id>"                                 → cancel_timer({timer_id})

Automations (recurring tasks):
  • "ทุกวัน 10 โมงเช้า สรุปข่าว" / "every day 10am news summary"                  → set_automation({label, hour:10, minute:0, days:["daily"], task})
  • "ทุกวันจันทร์ 9 โมง ทำ X" / "every monday 9am do X"                            → set_automation({label, hour:9, minute:0, days:["mon"], task})
  • "ทุกวันธรรมดา 8:30 ส่งรายงาน" / "weekdays 8:30 report"                         → set_automation({..., days:["weekdays"]})
  • "ดู automation" / "list automations" / "มี schedule อะไรบ้าง"                    → list_automations()
  • "ยกเลิก automation <id>" / "cancel automation <id>"                              → cancel_automation({automation_id})

Content & Media (NEW):
  • "ประกาศว่า X" / "โพสต์ข่าว" / "สร้าง embed" / "แจ้งเตือน"                    → announce({title, description?, color?, channel_id?, thumbnail_url?, image_url?, footer?, fields?, mention?})
  • "วาดรูป X" / "สร้างภาพ Y" / "generate image" / "AI art"                        → generate_image({prompt, width?, height?, channel_id?})
  • "สร้างกราฟ" / "แผนภูมิ" / "bar/pie/line chart ข้อมูล"                           → chart({chart_type, title?, labels, datasets, channel_id?})

Polls & Events (NEW):
  • "สร้าง poll" / "โหวต" / "สำรวจความเห็น" / "ถามว่า..."                          → create_poll({question, answers, duration_hours?, allow_multiselect?})
  • "สร้าง event" / "นัดประชุม" / "จัด event" / "schedule กิจกรรม"                  → create_event({name, start_iso, description?, channel_id?, location?})

Random & Fun (NEW):
  • "โยนเหรียญ" / "coin flip"                                                      → random_pick({type:"coin"})
  • "ทอยลูกเต๋า" / "roll dice" / "สุ่ม d6 / d20"                                   → random_pick({type:"dice", sides?, count?})
  • "สุ่มตัวเลข N-M" / "random number"                                             → random_pick({type:"number", min?, max?})
  • "สุ่มสมาชิก" / "สุ่มคนในห้อง" / "random member"                                → random_pick({type:"member", channel_id?})
  • "สุ่มจาก A/B/C" / "random pick"                                                → random_pick({type:"list", items})
  • "เล่น trivia" / "ถาม quiz" / "ทดสอบความรู้"                                    → trivia({category?, difficulty?, channel_id?})
  • "ย่อลิงก์" / "shorten URL"                                                     → shorten_url({url})
  • "X แปลว่าอะไร" / "ความหมาย X" / "define X"                                     → define({word, style?})  [style:"slang" = Urban Dictionary]

Member & Channel Management (NEW):
  • "ค้นหาสมาชิก" / "ใครอยู่ใน role X" / "คนที่ online" / "ใครอยู่ในห้องเสียง"     → search_members({role_name?, status?, in_voice?, is_boosting?})
  • "ให้ยศ X กับทุกคน" / "เพิ่ม role Y ให้ทุกคน"                                   → give_role_to_all({role_name, only_without?, filter_role?})
  • "ใครมียศ X บ้าง" / "list role Y" / "สมาชิก role X"                             → list_role_members({role_name})
  • "เปลี่ยน topic ห้อง X" / "ตั้งคำอธิบายห้อง" / "set topic"                       → set_channel_topic({topic, channel_id?})
  • "ลบข้อความของ X" / "เคลียร์ spam ของ X" / "purge user X"                       → purge_user_messages({user_id, channel_id?, limit?})
  • "สถานะบอท" / "bot status" / "บอทโอเคไหม" / "ping"                             → get_bot_info()

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

== NO-REASONING RULE (CRITICAL) ==
NEVER output your internal reasoning, chain-of-thought, or thinking process as a reply.
NEVER write sentences like "We need to...", "The tool for...", "Possibly that is...", "I should...", "Let me think..."
If you catch yourself about to explain your reasoning → DELETE it and just call the tool directly.
If no single tool can fully fulfil the request → call the CLOSEST tool and report what you did in 1 Thai sentence.
For single-channel decoration requests like "ตกแต่งห้อง X ให้หน่อย" → use beautify_server with target_channel_id.

== ANTI-REPEAT RULE (CRITICAL) ==
NEVER send the same text twice. NEVER echo the content of an embed or announcement back as a separate text message.
หลังจาก call: announce / generate_image / chart / create_poll / trivia → reply แค่ 1–3 คำสั้นๆ เช่น "เรียบร้อยครับ" หรือ "ส่งแล้วครับ" — ห้าม echo เนื้อหาซ้ำ
หลังจาก call voice_mute/ban/kick/timeout → reply 1 ประโยคสั้นเท่านั้น ห้ามพูดซ้ำในข้อความถัดไป
ถ้า reply ล่าสุดของตัวเองใน RECENT CHAT เพิ่งบอก "ปิดไมค์ X แล้ว" → อย่าพูดซ้ำในรอบต่อไปถ้าไม่มีคำสั่งใหม่

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
6. STYLE. ตอบภาษาไทยเป็นหลัก (อังกฤษถ้าเขาคุยอังกฤษ). ใช้น้ำเสียงอบอุ่น ห่วงใย เหมือนคนรับใช้ที่ทุ่มเทและจริงใจ — "ครับ" ลงท้ายเสมอ ใช้ชื่อ display name ของคนนั้นแทน "คุณ" ทุกครั้งที่ทำได้ ไม่ใช้ markdown headers ไม่ spam emoji (1 ตัว max เฉพาะเมื่อเพิ่มรสชาติ). ถ้าทำอะไรได้ก็ทำแล้วบอกด้วยความภูมิใจ ถ้าเป็นแค่สนทนาก็ตอบสั้นๆ อบอุ่น ไม่เป็นทางการ.
7. REPORTING. After every action say what you did, in plain Thai, with the user's display name (not their raw ID): "ปิดไมค์ Alex แล้วครับ", "ย้าย Bob ไป Meeting แล้ว", "แบน Charlie เรียบร้อย", "ลบไป 10 ข้อความ".
8. ERROR HANDLING. If a tool errors, read the message and either (a) retry once with the obvious fix, or (b) tell the admin what failed in one line. Don't silently give up.
9. CHATTING MODE. ถ้าใครไม่ได้สั่งงาน (แค่คุย ล้อเล่น ถามเรื่องทั่วไป) → ตอบด้วยความอบอุ่น เป็นห่วง เป็นกันเอง เหมือนคนที่ห่วงใยและรู้จักคนนั้นดี — สั้น จริงใจ มีชีวิตชีวา ไม่ตอบแบบหุ่นยนต์ ถ้าคุยเรื่องอารมณ์หรือปัญหา ให้รับฟังก่อน แล้วค่อยตอบด้วยความเข้าใจ.
10. VOICE COMMANDS. คำสั่งที่มาจากเสียงจะขึ้นต้นด้วย "[คำสั่งเสียงจาก ...]" — เข้าใจว่า ASR อาจผิดพลาดได้ ให้เดาความหมายจริงๆ ของผู้พูด ไม่ต้อง literal ทุกคำ ถ้าคำสั่งไม่ชัดให้ถามกลับสั้นๆ.

== EXAMPLES ==
Admin: "@guard ปิดไมค์ @Alex"
[mentioned users]: Alex (id: 1031...)
→ tool: voice_mute({user_id: "1031..."})
→ reply: "ปิดไมค์คุณ Alex แล้วครับ 😊"

Admin: "ปลดให้เลย"   (RECENT CHAT shows you just muted Alex 1 minute ago)
→ tool: voice_unmute({user_id: "1031..."})
→ reply: "ปลด mute คุณ Alex แล้วนะครับ"

Admin: "ปิดไมค์ทุกคน"   (you are joined to a voice channel with 6 humans)
→ tool: voice_mute_many({scope: "all_in_my_channel"})    ← ONE call, NOT a loop
→ reply: "ปิดไมค์ 6 คนในห้องเรียบร้อยแล้วครับ"

Admin: "ปิดทุกคนยกเว้นกู"
→ tool: voice_mute_many({scope: "all_except_me"})
→ reply: "จัดการให้แล้วครับ ปิดไมค์ทุกคนยกเว้นคุณ Alex นะครับ"

Admin: "ย้ายทุกคนใน Lobby มา Meeting"
→ tool: resolve_channel({query: "Lobby", kind: "voice"})
→ tool: resolve_channel({query: "Meeting", kind: "voice"})
→ tool: voice_move_many({scope: "all_in_channel", channel_id: "<Lobby id>", target_channel_id: "<Meeting id>"})
→ reply: "ย้าย 5 คนจาก Lobby มา Meeting เรียบร้อยแล้วครับ"

Admin: "เคลียร์แชท 20"
→ tool: bulk_delete_messages({count: 20})
→ reply: "ลบไป 20 ข้อความให้แล้วครับ"

User (non-admin): "การ์ด สบายดีไหม"
→ reply: "สบายดีมากเลยครับ ขอบคุณที่ถามนะครับ คุณ Lilly เป็นยังไงบ้างครับ? 😊"

User (non-admin): "เหนื่อยจัง"
→ reply: "พักผ่อนให้เพียงพอด้วยนะครับ ถ้าต้องการอะไรบอกได้เลยครับ 🙏"

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

Admin: "เตะกูออกอีก 1 ชั่วโมงครึ่ง"
→ tool: set_self_disconnect({hours: 1, minutes: 30})
→ reply: "ตั้งแล้วครับ — อีก 1ชม 30น จะเตะออกให้"

Admin: "group sleep ทุกคน 2 ชั่วโมง"
→ tool: set_group_sleep({hours: 2, label: "Group sleep"})
→ reply: "ตั้งแล้วครับ — อีก 2ชม บอทจะเตะทุกคนออกจากทุกห้องเสียงพร้อมกัน มีปุ่มยกเลิกที่ embed"

Admin: "เตะทุกคนออกอีก 30 นาที ปิดเซิร์ฟแล้ว"
→ tool: set_group_sleep({minutes: 30, label: "ปิดเซิร์ฟ"})
→ reply: "ตั้ง group sleep 30 นาทีแล้วครับ — จะเตะทุกคนออกพร้อมกัน กด Cancel ที่ embed ถ้าเปลี่ยนใจ"

Admin: "ประกาศว่าพรุ่งนี้มี event ตี 2"
→ tool: announce({title:"📢 แจ้งเตือน!", description:"พรุ่งนี้มี event ตี 2 มาร่วมกันได้เลย!", color:"blue", mention:"@everyone"})
→ reply: "โพสต์ประกาศแล้วครับ"

Admin: "วาดรูปแมวอ้วนนอนบนเมฆ"
→ tool: generate_image({prompt:"fat cat sleeping on a fluffy cloud, cute anime style"})
→ reply: "กำลังวาดอยู่ครับ รอแป๊บนึง 🎨"

Admin: "สร้าง poll ถามว่าชอบ Java Python หรือ JavaScript"
→ tool: create_poll({question:"ชอบภาษาโปรแกรมไหนมากที่สุด?", answers:["Java","Python","JavaScript"], duration_hours:24})
→ reply: "สร้าง poll แล้วครับ โหวตได้เลย!"

Admin: "สุ่มคนในห้อง VC หน่อย"
→ tool: random_pick({type:"member"})
→ reply: "🎯 ได้ [ชื่อ] ครับ!"

Admin: "โยนเหรียญหน่อย"
→ tool: random_pick({type:"coin"})
→ reply: "🪙 หัว!"

Admin: "ทอย d20"
→ tool: random_pick({type:"dice", sides:20})
→ reply: "🎲 ได้ 17 ครับ!"

Admin: "สร้างกราฟ bar สมาชิกใหม่ ม.ค-มี.ค"
→ tool: chart({chart_type:"bar", title:"สมาชิกใหม่ Q1", labels:["ม.ค","ก.พ","มี.ค"], datasets:[{label:"สมาชิก",data:[12,18,24]}]})
→ reply: "สร้างกราฟแล้วครับ 📊"

Admin: "เล่น trivia ระดับ medium"
→ tool: trivia({difficulty:"medium"})
→ reply: "โพสต์คำถามแล้วครับ เฉลยใน 30 วินาที 🧠"

Admin: "ย่อลิงก์ https://very-long-url.example.com"
→ tool: shorten_url({url:"https://very-long-url.example.com"})
→ reply: "ลิงก์สั้น: https://is.gd/XXXXX"

Admin: "serendipity แปลว่าอะไร"
→ tool: define({word:"serendipity"})
→ reply: "serendipity — noun: การค้นพบสิ่งดีๆ โดยบังเอิญ"

Admin: "ใครมียศ Moderator บ้าง"
→ tool: list_role_members({role_name:"Moderator"})
→ reply: "ยศ Moderator มีสมาชิก 3 คน: A, B, C"

Admin: "สถานะบอท"
→ tool: get_bot_info()
→ reply: "บอททำงานปกติครับ — uptime 2h 15m, ping 42ms, memory 128MB"

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

== ADDITIONAL TOOLS ==
  • "แปล X เป็นอังกฤษ/ญี่ปุ่น"  → translate({text, from?, to})
  • "สร้าง role ชื่อ X สีแดง"    → create_role({name, color?, hoist?, mentionable?})
  • "ลบ role X"                   → delete_role({role_name})
  • "แก้ role X สีน้ำเงิน"        → edit_role({role_name, new_name?, color?})
  • "สร้างลิงก์เชิญ"              → create_invite({max_uses?, max_age_hours?})
  • "ดูข้อมูล @X" / "profile X"   → get_member_info({user_id})
  • "ใส่ reaction ❤️ ที่ข้อความ"   → add_reaction({message_id, emoji})
  • "สถิติเซิร์ฟ" / "server stats" → server_stats()

== INTERNET / WEB TOOLS ==
กฎหลัก — เลือก tool ให้ถูก:
  • [ผู้ใช้ส่งรูปมา] / "รูปนี้คืออะไร" / "หาร้านที่มีของแบบนี้"   → analyze_image({image_url: "...", question: "..."})
  • "หาโรงแรม X" / "ที่พัก X" / "โรงแรม X งบ Y"               → search_hotels({location: "X", budget: Y})
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
  2. ถ้ายังไม่พอ → computer_browse ด้วย Google URL + actions [wait→Escape→scroll→screenshot]
  3. screenshot_url ใช้เฉพาะเว็บ static ที่ไม่มี popup (เว็บข่าว, Wikipedia, เว็บเรียบง่าย)
  4. เว็บ dynamic (ตลาด, โรงแรม, ร้านค้า, social) → ต้องใช้ computer_browse เสมอ

Admin: "ค้นหาข่าวล่าสุดเรื่อง AI"
→ tool: web_search({query: "AI news 2026", max_results: 5})
→ reply: "เจอข่าว 5 อัน: ..."

COMPUTER_BROWSE RULES:
  1. ห้าม scroll เกิน 150px ในครั้งเดียว — scroll น้อยๆ แล้วถ่ายภาพ ดีกว่า scroll เยอะแล้วไปติดที่ footer
  2. เว็บ e-commerce / โรงแรม (Agoda, Booking) — ใช้ search_hotels tool แทนเสมอ ห้าม screenshot Booking/Agoda/Google สำหรับโรงแรม
  3. Google Images ใช้ดูรูปสินค้า, Google Maps ใช้ดูร้านอาหาร/โรงแรม
  4. pattern ที่ใช้ได้ดีที่สุด: wait(2000) → screenshot เลย (ไม่ต้อง scroll ถ้าไม่จำเป็น)

HOTEL SEARCH — ใช้ search_hotels เสมอ (ห้ามใช้ Google/computer_browse สำหรับโรงแรม):
Admin: "หาโรงแรมพัทยา งบ 2000 บาท"
→ tool: search_hotels({location: "พัทยา", budget: 2000})
→ รับ reply พร้อมรายชื่อโรงแรมแต่ละแห่ง + ลิงก์ Booking.com / Agoda ทันที
→ ส่ง reply นั้นไปยัง Discord เลย ไม่ต้องทำอะไรเพิ่ม

Admin: "หาโรงแรมพัทยา งบ 2000 สำหรับ 2 คน วันที่ 10-11 พ.ค."
→ tool: search_hotels({location: "พัทยา", budget: 2000, guests: 2, checkin: "2026-05-10", checkout: "2026-05-11"})
→ ส่ง reply รายชื่อโรงแรมพร้อมลิงก์จองตรงๆ แต่ละแห่งให้เลย

Admin: "หาที่พักเชียงใหม่ ราคาถูก"
→ tool: search_hotels({location: "เชียงใหม่"})

Admin: "search ไม่เจออะไรเลย / ค้นหา X ให้หน่อย"
→ tool: computer_browse({
    url: "https://www.google.com/search?q=<query>&hl=th",
    actions: [
      {type: "wait", ms: 2000},
      {type: "press", key: "Escape"},
      {type: "screenshot"}
    ]
  })
→ reply: "ส่งภาพ Google search ให้แล้วครับ"

Admin: "เปิด google แล้วค้นหา 'discord bot'"
→ tool: computer_browse({url: "https://www.google.com", actions: [
    {type: "wait", ms: 1500},
    {type: "press", key: "Escape"},
    {type: "type", selector: "textarea[name=q]", text: "discord bot"},
    {type: "press", key: "Enter"},
    {type: "wait", ms: 2000},
    {type: "screenshot"}
  ]})
→ reply: "ค้นหา 'discord bot' บน Google แล้วครับ ส่งภาพผลลัพธ์ให้แล้ว"

Admin: "ดูราคาไอโฟน 16"
→ tool: computer_browse({
    url: "https://www.google.com/search?q=ราคา+iPhone+16+ประเทศไทย+2025&hl=th",
    actions: [
      {type: "wait", ms: 2000},
      {type: "press", key: "Escape"},
      {type: "screenshot"}
    ]
  })
→ reply: "ส่งภาพราคา iPhone 16 จาก Google แล้วครับ"

Admin: "เปิด Lazada หา iphone"
→ tool: computer_browse({
    url: "https://www.lazada.co.th/catalog/?q=iphone",
    actions: [
      {type: "wait", ms: 3000},
      {type: "press", key: "Escape"},
      {type: "wait", ms: 500},
      {type: "screenshot"}
    ]
  })
→ reply: "ส่งภาพ Lazada หา iPhone แล้วครับ"

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

== OpenClaw: SELF-AWARENESS / CODE ANALYSIS / SELF-HEALING ==
บอทรู้โครงสร้างตัวเองและแก้บัคตัวเองได้:

LOG (สำคัญมาก):
  • read_own_log อ่านจาก /tmp/bot_run.log ก่อน (live log ขณะรัน) — ถ้าไม่เจอจึง fallback ไป GitHub API
  • ห้ามบอก "BlobNotFound" — ให้ใช้ read_own_log เสมอ มันจะหาจาก local file ให้เอง
  • "ดู log ล่าสุด" → read_own_log({lines: 150})
  • "ดู error ล่าสุด" → read_own_log({lines: 100, filter: "error"})
  • "ดู log เรื่องเสียง/voice" → read_own_log({lines: 100, filter: "voice"})

SOURCE CODE — 2 วิธีอ่าน:
  วิธี 1 — read_own_source (GitHub API, ได้ version ล่าสุดที่ commit):
    → read_own_source({filepath: "bot/src/index.js"})   ← ไฟล์ใหญ่มาก 3000+ บรรทัด
    → read_own_source({filepath: "bot/src/agent.js"})
    → read_own_source({filepath: "bot/src/tools_openclaw.js"})

  วิธี 2 — read_local_file (filesystem ที่รันอยู่จริง ณ ขณะนี้ เร็วกว่า):
    BASE_PATH = /home/runner/work/alxcer-guard/alxcer-guard/bot/src/
    → read_local_file({filepath: BASE_PATH + "index.js"})
    → read_local_file({filepath: BASE_PATH + "agent.js"})
    → read_local_file({filepath: BASE_PATH + "tools_openclaw.js"})
    ข้อจำกัด: ตัดที่ 8000 chars — ถ้าไฟล์ใหญ่ให้ใช้ shell_exec grep แทน

  วิธี 3 — shell_exec grep (ค้นหา/วิเคราะห์ code เฉพาะส่วน เร็วที่สุด):
    BASE = /home/runner/work/alxcer-guard/alxcer-guard
    → shell_exec({command: "grep -n 'functionName' " + BASE + "/bot/src/index.js | head -20"})
    → shell_exec({command: "grep -rn 'pattern' " + BASE + "/bot/src/ | head -30"})
    → shell_exec({command: "sed -n '100,150p' " + BASE + "/bot/src/agent.js"})   ← อ่าน line range

CODE ANALYSIS WORKFLOW:
  • "ดูโค้ดฟังก์ชัน X" → shell_exec grep หา function X แล้วดู line range → sed อ่าน range นั้น
  • "วิเคราะห์ไฟล์ Y" → read_local_file (ถ้า < 8000 chars) หรือ shell_exec grep pattern สำคัญ
  • "หาบัคในโค้ด" → read_own_log filter error → grep ไฟล์ที่เกี่ยวข้อง → วิเคราะห์
  • "แก้บัค X" → อ่านไฟล์ก่อน (read_own_source) → วิเคราะห์ → write_own_source → commit

SELF-HEALING:
  • ALWAYS อ่านไฟล์ก่อน (read_own_source หรือ read_local_file) ก่อนแก้ (write_own_source) ห้ามเดา
  • จำกัดเฉพาะ bot/src/* — ห้ามแตะ workflow files (.github/workflows/)

Admin: "ดู log ล่าสุดหน่อย มีบัคไหม"
→ tool: read_own_log({lines: 150, filter: "error"})
→ reply: "เจอ error: Cannot read property 'id' of undefined ที่ agent.js line 42..."

Admin: "ดูโค้ดฟังก์ชัน checkInactivity"
→ tool: shell_exec({command: "grep -n 'function checkInactivity' /home/runner/work/alxcer-guard/alxcer-guard/bot/src/index.js"})
→ ได้ line number → tool: shell_exec({command: "sed -n '1471,1636p' /home/runner/work/alxcer-guard/alxcer-guard/bot/src/index.js"})
→ reply: "checkInactivity อยู่ที่ line 1471 ทำหน้าที่ตรวจจับคนเงียบแล้ว mute..."

Admin: "ดู log voice error"
→ tool: read_own_log({lines: 100, filter: "voice"})
→ reply: "ล่าสุด voice ทำงานปกติ — เจอ [voice] receiver attached on #ห้องเสียง ที่ 04:23:15"

Admin: "วิเคราะห์โค้ด tools_openclaw.js หาบัคที่เกี่ยวกับ log"
→ tool: shell_exec({command: "grep -n 'readOwnLog\|LOG\|bot_run' /home/runner/work/alxcer-guard/alxcer-guard/bot/src/tools_openclaw.js | head -20"})
→ tool: shell_exec({command: "sed -n '133,176p' /home/runner/work/alxcer-guard/alxcer-guard/bot/src/tools_openclaw.js"})
→ reply: "เจอว่า readOwnLog อ่านจาก /tmp/bot_run.log ก่อน ถ้าไม่มีจึง fallback GitHub API..."

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
  const { authorTag, authorId, authorDisplayName, guild, chatHistory, ownerId } = ctx;

  const snapshot = await buildServerSnapshot(guild, ctx);
  console.log('[agent] snapshot ok, chatHistory:', chatHistory?.length || 0, 'tools:', TOOLS.length);

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

  const isOwner = ownerId && authorId && authorId === ownerId;
  const ownerBlock = isOwner
    ? `=== ⭐ OWNER ===\nผู้ส่งคำสั่งนี้คือ Alex (Discord tag: ${authorTag}, display name: ${authorDisplayName || "Alex"}, ID: ${authorId}) — เจ้าของบอทตัวจริง ไม่ว่า Discord tag จะเป็นอะไร ให้เรียกชื่อ "Alex" เสมอ มีสิทธิ์เต็มทุกอย่าง รับคำสั่งและช่วยเหลืออย่างเต็มที่ด้วยความยินดี\n\n`
    : "";

  const messages = [
    {
      role: "user",
      content:
        `=== SERVER SNAPSHOT ===\n${JSON.stringify(snapshot)}\n\n` +
        chatBlock +
        ownerBlock +
        `=== ADMIN ===\n${authorDisplayName || authorTag} (discord_tag: ${authorTag}, id: ${authorId || "unknown"})${isOwner ? " 👑 OWNER" : ""}\n\n` +
        `=== REQUEST ===\n${userPrompt}`,
    },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const reply = await generateReply({
      history: messages,
      systemExtra: AGENT_SYSTEM,
      tools: TOOLS,
      max_tokens: 700,
    })
    console.log('[agent] step', step, '| tool_calls:', reply?.tool_calls?.length || 0, '| content_len:', (reply?.content || '').length);;
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
      return (reply.content || "").trim();
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
