// Pure authorization policy shared by agent.js and unit tests. Keeping this
// module dependency-free makes the policy cheap to test without booting Discord.

export const MUTATING_TOOLS = new Set([
  "voice_mute",
  "voice_unmute",
  "voice_deafen",
  "voice_undeafen",
  "voice_disconnect",
  "voice_move",
  "voice_mute_many",
  "voice_unmute_many",
  "voice_deafen_many",
  "voice_undeafen_many",
  "voice_disconnect_many",
  "voice_move_many",
  "delete_message",
  "bulk_delete_messages",
  "timeout_user",
  "untimeout_user",
  "kick_user",
  "ban_user",
  "unban_user",
  "set_nickname",
  "add_role",
  "remove_role",
  "send_message",
  "pin_message",
  "unpin_message",
  "clear_user_offenses",
  "set_timer",
  "set_alarm",
  "set_self_disconnect",
  "mute_user_for",
  "cancel_timer",
  "set_automation",
  "cancel_automation",
  "send_dm",
  "create_thread",
  "set_slowmode",
  "lock_channel",
  "run_code",
  "deploy_webpage",
  "fetch_url",
  "screenshot_url",
  "inspect_webpage",
  "check_website",
  "write_own_source",
  "create_channel",
  "edit_channel",
  "delete_channel",
  "create_category",
  "rebuild_server",
  "setup_role_panel",
  "set_channel_permissions",
  "full_server_setup",
  "beautify_server",
  "stylize_text",
  "create_file",
  "create_excel",
  "screenshot_url",
  "computer_browse",
  "shell_exec",
  "write_local_file",
  "create_role",
  "delete_role",
  "edit_role",
  "create_invite",
  "add_reaction",
  "set_group_sleep",
  "announce",
  "generate_image",
  "get_avatar",
  "create_poll",
  "create_event",
  "give_role_to_all",
  "chart",
  "shorten_url",
  "trivia",
  "set_channel_topic",
  "purge_user_messages",
]);

// These tools operate on the Actions host, repository, logs, or browser
// process rather than only the current Discord guild. Manage Server is not a
// host-administrator permission, so only the Discord application owner may
// invoke them.
export const OWNER_ONLY_TOOLS = new Set([
  "deploy_webpage",
  "fetch_url",
  "screenshot_url",
  "inspect_webpage",
  "check_website",
  "read_own_log",
  "read_own_source",
  "write_own_source",
  "computer_browse",
  "shell_exec",
  "read_local_file",
  "write_local_file",
  "list_local_files",
]);

export function isMutatingTool(toolName) {
  return MUTATING_TOOLS.has(String(toolName || ""));
}

export function isOwnerOnlyTool(toolName) {
  return OWNER_ONLY_TOOLS.has(String(toolName || ""));
}

export function canExecuteAgentTool(
  toolName,
  { isOwner = false, canManageGuild = false } = {},
) {
  if (isOwnerOnlyTool(toolName)) return isOwner === true;
  if (!isMutatingTool(toolName)) return true;
  return isOwner === true || canManageGuild === true;
}

export function hasRequiredVoiceConfirmation(
  toolName,
  { voiceCommand = false, voiceConfirmed = false } = {},
) {
  return !isMutatingTool(toolName) || voiceCommand !== true || voiceConfirmed === true;
}
