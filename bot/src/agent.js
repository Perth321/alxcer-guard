// Admin agent: gives the LLM Discord tools so an admin can drive the bot in
// natural language. Triggered when an admin @mentions / says "guard" with
// command-like phrasing.

import { PermissionFlagsBits, ChannelType } from "discord.js";
import { generateReply, aiAvailable } from "./ai.js";

export function isAdmin(member) {
  if (!member) return false;
  return member.permissions?.has?.(PermissionFlagsBits.Administrator) === true;
}

// ===== TOOL DEFINITIONS (OpenAI-compatible JSON schema) =====
const TOOLS = [
  {
    type: "function",
    function: {
      name: "delete_message",
      description: "Delete a message in the current channel by message ID.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Discord message ID" },
          reason: { type: "string", description: "audit log reason" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "timeout_user",
      description: "Server-timeout a user (cannot send messages or talk in voice). Max 1 day.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          seconds: { type: "number", description: "1-86400" },
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
      name: "send_message",
      description: "Send a text message to a channel by ID. Use the current channel if no ID is given.",
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
      name: "list_channels",
      description: "List text/voice channels in the guild.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_members",
      description: "List members in the guild (id, displayName, isAdmin).",
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
      description: "Look up the chat-offense history of a user.",
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
      description: "Reset the chat-offense counter for a user.",
      parameters: {
        type: "object",
        properties: { user_id: { type: "string" } },
        required: ["user_id"],
      },
    },
  },
];

async function execTool(name, args, ctx) {
  const { guild, channel, offenses, persistOffenses } = ctx;
  switch (name) {
    case "delete_message": {
      const msg = await channel.messages.fetch(args.message_id);
      await msg.delete();
      return { ok: true };
    }
    case "timeout_user": {
      const member = await guild.members.fetch(args.user_id);
      const ms = Math.max(1000, Math.min(86400, Number(args.seconds || 60))) * 1000;
      await member.timeout(ms, args.reason || "Alxcer Guard agent");
      return { ok: true, applied_seconds: ms / 1000 };
    }
    case "untimeout_user": {
      const member = await guild.members.fetch(args.user_id);
      await member.timeout(null, args.reason || "Alxcer Guard agent");
      return { ok: true };
    }
    case "kick_user": {
      const member = await guild.members.fetch(args.user_id);
      await member.kick(args.reason || "Alxcer Guard agent");
      return { ok: true };
    }
    case "send_message": {
      const target = args.channel_id
        ? await guild.channels.fetch(args.channel_id)
        : channel;
      const sent = await target.send(args.content.slice(0, 2000));
      return { ok: true, message_id: sent.id, channel_id: target.id };
    }
    case "list_channels": {
      const chans = (await guild.channels.fetch())
        .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice))
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type === ChannelType.GuildVoice ? "voice" : "text",
        }));
      return { channels: chans.slice(0, 50) };
    }
    case "list_members": {
      const members = await guild.members.fetch();
      const list = members
        .filter((m) => !m.user.bot)
        .map((m) => ({
          id: m.id,
          name: m.displayName,
          isAdmin: m.permissions.has(PermissionFlagsBits.Administrator),
        }))
        .slice(0, 80);
      return { members: list };
    }
    case "get_recent_messages": {
      const target = await guild.channels.fetch(args.channel_id);
      const limit = Math.max(1, Math.min(50, Number(args.limit || 20)));
      const msgs = await target.messages.fetch({ limit });
      return {
        messages: msgs
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

// Run the agent loop. Returns final assistant text.
export async function runAgent({ userPrompt, ctx, maxSteps = 5 }) {
  if (!aiAvailable()) return "AI ยังไม่พร้อม (OPENROUTER_API_KEY ไม่ได้ตั้ง)";
  const { authorTag } = ctx;
  const messages = [
    {
      role: "user",
      content:
        `Admin "${authorTag}" sent: ${userPrompt}\n\nIf they want you to DO something on Discord, use the tools. If they just want to chat, just reply. Be concise.`,
    },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const reply = await generateReply({
      history: messages,
      systemExtra:
        "You have admin tools for managing this Discord server. Only use them when the admin clearly asks. Confirm destructive actions briefly. Reply in Thai unless the admin writes in English.",
      tools: TOOLS,
      max_tokens: 600,
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
      } catch (err) {
        result = { error: err?.message || String(err) };
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
