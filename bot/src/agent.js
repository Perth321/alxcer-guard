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
Voice / room control:
  • "ปิดไมค์ X" / "ปิดเสียง X" / "mute X" / "ปิดปาก X" / "หุบปาก X"  → voice_mute(X)
  • "เปิดไมค์ X" / "ยกเลิกปิดไมค์ X" / "unmute X" / "ปลด mute X"     → voice_unmute(X)
  • "ทำให้หูหนวก X" / "deafen X" / "ปิดหู X"                         → voice_deafen(X)
  • "ยกเลิกหูหนวก X" / "เปิดหู X" / "undeafen X"                      → voice_undeafen(X)
  • "เตะออก(จาก)ห้องเสียง X" / "ดีดออก X" / "disconnect X" / "ไล่ออกห้อง X" → voice_disconnect(X)
  • "ย้าย X ไป(ห้อง) Y" / "ลาก X เข้า Y" / "พา X ไป Y" / "move X to Y"     → voice_move(X, Y)

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
   - "พวกที่ AFK ในห้อง General เตะออกหน่อย" → list_voice_members → voice_disconnect anyone with self_mute or no recent activity.
   - "ย้ายทุกคนใน Lobby มา Meeting" → list_voice_members(Lobby) → voice_move each.
   - "ใครพูดหยาบในชั่วโมงที่ผ่านมา?" → get_recent_offenses(limit=20) and summarize.
   - "ปิดทุกคนยกเว้นกู" → list_voice_members(my channel) → voice_mute every member except authorId.
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

Admin: "ย้ายทุกคนใน Lobby มา Meeting"
→ tool: list_voice_members({channel: "Lobby"})
→ tool (per member): voice_move({user_id, channel: "Meeting"})
→ reply: "ย้าย 5 คนจาก Lobby มา Meeting แล้วครับ"

Admin: "เคลียร์แชท 20"
→ tool: bulk_delete_messages({count: 20})
→ reply: "ลบไป 20 ข้อความครับ"

Admin: "ใครก่อเรื่องบ่อยสุด?"
→ tool: get_recent_offenses({limit: 30})
→ reply: "ช่วงนี้ Bob ผิดบ่อยสุดครับ — 4 ครั้งใน 2 วัน (ส่วนใหญ่คำหยาบ severity 7)"

Admin: "เหนื่อยว่ะ"   (no action implied)
→ no tool
→ reply: "พักก่อนครับ เดี๋ยวอะไรก็ดูแลให้ ไม่ต้องห่วง 😌"`;

export async function runAgent({ userPrompt, ctx, maxSteps = 8 }) {
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
