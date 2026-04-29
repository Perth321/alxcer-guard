// Admin agent: gives the LLM a full Discord toolbox so an admin can drive the
// bot in natural language. The admin can say things like "ปิดไมค์ A",
// "เตะ B ออกจากห้อง", "ลบ 10 ข้อความล่าสุด", "แบน C" — the agent will resolve
// names, choose the right tools, chain calls, and report back.

import { PermissionFlagsBits, ChannelType } from "discord.js";
import { generateReply, aiAvailable } from "./ai.js";

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
      name: "clear_user_offenses",
      description: "Reset the offense counters for a user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" } },
        required: ["user_id"],
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

// ===== Tool execution =====
async function execTool(name, args, ctx) {
  const { guild, channel, offenses, persistOffenses, authorId } = ctx;

  // Hard guardrail: never moderate the admin who's talking to us, and never
  // moderate fellow admins. Applies to any per-user moderation tool.
  const PROTECTED_TOOLS = new Set([
    "voice_mute", "voice_deafen", "voice_disconnect", "voice_move",
    "timeout_user", "kick_user", "ban_user", "set_nickname",
    "add_role", "remove_role", "clear_user_offenses",
  ]);
  if (PROTECTED_TOOLS.has(name) && args.user_id) {
    if (args.user_id === authorId) {
      return { error: "refused: cannot moderate the admin issuing this command" };
    }
    try {
      const target = await guild.members.fetch(args.user_id);
      if (target.permissions.has(PermissionFlagsBits.Administrator)) {
        return { error: "refused: target is also a server admin" };
      }
    } catch {
      // ignore — let the actual call fail naturally
    }
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
      return {
        user_id: args.user_id,
        voice_offenses: rec?.times || 0,
        last_voice_word: rec?.lastWord || null,
        chat_offense_count: rec?.chat?.count || 0,
        chat_history: (rec?.chat?.history || []).slice(-10),
      };
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

const AGENT_SYSTEM = `You are operating in ADMIN OPS MODE for the Alxcer Guard server. The user speaking to you is a verified server administrator. Set aside your normal sassy persona — be a competent, no-nonsense ops assistant.

CORE RULES
1. JUST DO IT. If the admin clearly asks for an action ("ปิดไมค์ A", "เตะ B", "ลบ 10 ข้อความ", "แบน C เลย"), execute it immediately with the right tool. Do NOT ask for confirmation. Do NOT pre-announce. Just act and report the result in one short sentence.
2. Names → IDs: when the admin uses a person's name, call resolve_user first. If exactly one strong match, proceed. If multiple, ask which one in one short line. If zero, say so.
3. Channel names → IDs: same pattern with resolve_channel.
4. The conversation includes a SERVER SNAPSHOT — use it as your default source of truth before calling list_* tools.
5. Chain tool calls when the request implies multiple steps. Example: "ปิดไมค์ทุกคนใน General" → list_voice_members → voice_mute on each non-admin.
6. SAFETY: Never moderate the admin talking to you, and never moderate other admins. The tool layer also blocks this — if you see an "admin" error, just explain politely.
7. Reply in Thai by default, English if the admin wrote English. Keep replies SHORT (1–2 sentences). No markdown headers, no preamble.
8. After actions, report briefly: "ปิดไมค์ A แล้ว", "ลบ 5 ข้อความ", "แบน C เรียบร้อย".
9. If a tool fails, retry with a sensible alternative once before giving up.
10. If the admin is just chatting (no command), reply naturally without tools.`;

export async function runAgent({ userPrompt, ctx, maxSteps = 8 }) {
  if (!aiAvailable()) return "AI ยังไม่พร้อม (OPENROUTER_API_KEY ไม่ได้ตั้ง)";
  const { authorTag, authorId, guild } = ctx;

  const snapshot = await buildServerSnapshot(guild);

  const messages = [
    {
      role: "user",
      content:
        `=== SERVER SNAPSHOT ===\n${JSON.stringify(snapshot)}\n\n` +
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
      let result;
      try {
        result = await execTool(call.function?.name, parsedArgs, ctx);
        console.log(
          `[agent] ${call.function?.name}(${JSON.stringify(parsedArgs).slice(0, 150)}) -> ${JSON.stringify(result).slice(0, 150)}`
        );
      } catch (err) {
        result = { error: err?.message || String(err) };
        console.warn(`[agent] ${call.function?.name} failed:`, err?.message);
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
