// Tools the AI agent can call to manage the server directly — ported from
// the Python bot's bot/agent_tools.py. Each tool pairs a function-calling
// schema with an async handler that performs the real Discord action.
//
// All tools are owner-only: textChat.js/voice.js only offer them when the
// triggering message's author is the bot owner, and execute() re-checks
// before running anything — same defense-in-depth as the Python bot.
//
// Handlers take (client, message, args) where `message` only needs
// .guild/.channel/.author — a real discord.js Message from text chat, or
// voice.js's plain object standing in for one (there's no real Message in
// a voice reply). Same shape the Python bot's voice.py already uses.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import * as db from './db.js';
import { isOwner, logAction } from './utils.js';

export class ToolError extends Error {}

function str(description) {
  return { type: 'string', description };
}

function int(description) {
  return { type: 'integer', description };
}

function schema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

// -- resolution helpers -------------------------------------------------------

async function resolveMember(guild, ref) {
  ref = String(ref).trim();
  const digits = ref.replace(/^<@!?/, '').replace(/>$/, '');
  if (/^\d+$/.test(digits)) {
    let member = guild.members.cache.get(digits);
    if (!member) {
      try {
        member = await guild.members.fetch(digits);
      } catch { /* not found */ }
    }
    if (member) return member;
  }
  const low = ref.toLowerCase();
  const found = guild.members.cache.find((m) => (
    m.user.username.toLowerCase() === low || m.displayName.toLowerCase() === low
    || m.user.tag.toLowerCase() === low
  ));
  if (found) return found;
  throw new ToolError(`No member found matching '${ref}'. Try search_members to find them.`);
}

function resolveRole(guild, ref) {
  ref = String(ref).trim();
  const digits = ref.replace(/^<@&/, '').replace(/>$/, '');
  if (/^\d+$/.test(digits)) {
    const role = guild.roles.cache.get(digits);
    if (role) return role;
  }
  const low = ref.toLowerCase();
  const found = guild.roles.cache.find((r) => r.name.toLowerCase() === low);
  if (found) return found;
  throw new ToolError(`No role found matching '${ref}'. Use list_roles to see them.`);
}

function resolveChannel(guild, ref) {
  ref = String(ref).trim();
  const digits = ref.replace(/^<#/, '').replace(/>$/, '');
  if (/^\d+$/.test(digits)) {
    const channel = guild.channels.cache.get(digits);
    if (channel) return channel;
  }
  const low = ref.replace(/^#/, '').toLowerCase();
  const found = guild.channels.cache.find((c) => c.name.toLowerCase() === low);
  if (found) return found;
  throw new ToolError(`No channel found matching '${ref}'. Use list_channels to see them.`);
}

/** The channel named in args, or the channel the request came from. */
function textChannel(message, args) {
  if (!args.channel) return message.channel;
  const channel = resolveChannel(message.guild, args.channel);
  if (channel.type !== ChannelType.GuildText) {
    throw new ToolError(`#${channel.name} is not a text channel.`);
  }
  return channel;
}

function checkTarget(message, member) {
  if (member.id === message.guild.members.me.id) {
    throw new ToolError("I won't take moderation actions against myself.");
  }
  if (isOwner(member.id)) {
    throw new ToolError("I won't take moderation actions against the bot owner.");
  }
}

function actor(message) {
  return `AI (for ${message.author.tag || message.author.username || message.author.id})`;
}

// -- info tools ---------------------------------------------------------------

async function serverInfo(client, message) {
  const g = message.guild;
  return `Server: ${g.name} (id ${g.id}) | Owner: ${(await g.fetchOwner()).user.tag} | `
    + `Members: ${g.memberCount} | Channels: ${g.channels.cache.size} | `
    + `Roles: ${g.roles.cache.size} | Boost tier: ${g.premiumTier}`;
}

async function listChannels(client, message) {
  const lines = message.guild.channels.cache.map((c) => `#${c.name} (id ${c.id}, ${ChannelType[c.type] || 'channel'})`);
  return lines.join('\n') || 'No channels.';
}

async function listRoles(client, message) {
  const lines = [...message.guild.roles.cache.values()]
    .filter((r) => r.id !== message.guild.id) // not @everyone
    .sort((a, b) => b.position - a.position)
    .map((r) => `${r.name} (id ${r.id}, ${r.members.size} members)`);
  return lines.join('\n') || 'No roles.';
}

async function memberInfo(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  const roles = m.roles.cache.filter((r) => r.id !== message.guild.id).map((r) => r.name).join(', ') || 'none';
  const joined = m.joinedTimestamp ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:D>` : '?';
  return `${m.user.tag} (id ${m.id}) | Display name: ${m.displayName} | Joined: ${joined} | `
    + `Roles: ${roles} | Timed out: ${m.isCommunicationDisabled() ? 'yes' : 'no'} | Bot: ${m.user.bot ? 'yes' : 'no'}`;
}

async function searchMembers(client, message, args) {
  const query = String(args.query).toLowerCase();
  const limit = Math.min(Number(args.limit) || 10, 25);
  const matches = message.guild.members.cache.filter((m) => (
    m.user.username.toLowerCase().includes(query) || m.displayName.toLowerCase().includes(query)
  ));
  if (!matches.size) return `No members matching '${args.query}'.`;
  return [...matches.values()].slice(0, limit)
    .map((m) => `${m.user.tag} (id ${m.id}, display name: ${m.displayName})`).join('\n');
}

async function getModLogs(client, message, args) {
  const limit = Math.min(Number(args.limit) || 15, 50);
  const rows = db.getLogs(message.guild.id, limit);
  if (!rows.length) return 'No moderation logs yet.';
  return rows.map((r) => (
    `[${r.action}] actor: ${r.actor}, target: ${r.target || '-'}, reason: ${r.reason || '-'}`
  )).join('\n');
}

// -- moderation tools -----------------------------------------------------------

async function kickMember(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  checkTarget(message, m);
  const reason = args.reason;
  await m.kick(reason);
  await logAction(message.guild, 'kick', actor(message), m.user.tag, reason);
  return `Kicked ${m.user.tag}.`;
}

async function banMember(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  checkTarget(message, m);
  const reason = args.reason;
  const deleteDays = Math.max(0, Math.min(Number(args.delete_days) || 0, 7));
  await m.ban({ reason, deleteMessageSeconds: deleteDays * 86400 });
  await logAction(message.guild, 'ban', actor(message), m.user.tag, reason);
  return `Banned ${m.user.tag}.`;
}

async function unbanUser(client, message, args) {
  const userId = String(args.user_id).replace(/^<@!?/, '').replace(/>$/, '');
  if (!/^\d+$/.test(userId)) throw new ToolError('user_id must be a numeric Discord user ID.');
  const reason = args.reason;
  await message.guild.bans.remove(userId, reason);
  await logAction(message.guild, 'unban', actor(message), userId, reason);
  return `Unbanned user ${userId}.`;
}

async function timeoutMember(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  checkTarget(message, m);
  const minutes = Math.max(1, Math.min(Number(args.minutes), 40320));
  const reason = args.reason;
  await m.timeout(minutes * 60_000, reason);
  await logAction(message.guild, 'timeout', actor(message), m.user.tag, `${reason || 'No reason'} (${minutes}m)`);
  return `Timed out ${m.user.tag} for ${minutes} minute(s).`;
}

async function untimeoutMember(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  await m.timeout(null);
  await logAction(message.guild, 'untimeout', actor(message), m.user.tag, null);
  return `Removed timeout for ${m.user.tag}.`;
}

async function warnMember(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  checkTarget(message, m);
  const reason = args.reason;
  db.addWarning(message.guild.id, m.id, message.author.id, reason);
  await logAction(message.guild, 'warn', actor(message), m.user.tag, reason);
  const count = db.getWarnings(message.guild.id, m.id).length;
  try {
    await m.send(`You were warned in **${message.guild.name}**: ${reason}`);
  } catch { /* DMs closed */ }
  return `Warned ${m.user.tag} (warning #${count}).`;
}

async function listWarnings(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  const rows = db.getWarnings(message.guild.id, m.id);
  if (!rows.length) return `${m.user.tag} has no warnings.`;
  return `${m.user.tag} has ${rows.length} warning(s):\n`
    + rows.slice(0, 15).map((r) => `#${r.id}: ${r.reason || 'No reason'}`).join('\n');
}

async function clearWarnings(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  const count = db.clearWarnings(message.guild.id, m.id);
  await logAction(message.guild, 'clear_warnings', actor(message), m.user.tag, `${count} removed`);
  return `Cleared ${count} warning(s) for ${m.user.tag}.`;
}

async function purgeMessages(client, message, args) {
  const channel = textChannel(message, args);
  const amount = Math.max(1, Math.min(Number(args.amount), 100));
  const deleted = await channel.bulkDelete(amount, true);
  await logAction(message.guild, 'purge', actor(message), `#${channel.name}`, `${deleted.size} messages`);
  return `Deleted ${deleted.size} message(s) in #${channel.name}.`;
}

async function setSlowmode(client, message, args) {
  const channel = textChannel(message, args);
  const seconds = Math.max(0, Math.min(Number(args.seconds), 21600));
  await channel.setRateLimitPerUser(seconds);
  return seconds ? `Slowmode set to ${seconds}s in #${channel.name}.` : `Slowmode disabled in #${channel.name}.`;
}

async function lockChannel(client, message, args) {
  const channel = textChannel(message, args);
  const locked = args.locked === undefined ? true : Boolean(args.locked);
  await channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: locked ? false : null,
  });
  await logAction(message.guild, locked ? 'lock' : 'unlock', actor(message), `#${channel.name}`, null);
  return `${locked ? 'Locked' : 'Unlocked'} #${channel.name}.`;
}

// -- channel tools --------------------------------------------------------------

const CHANNEL_KIND_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  forum: ChannelType.GuildForum,
};

async function createChannel(client, message, args) {
  const guild = message.guild;
  const kind = args.kind && CHANNEL_KIND_TYPES[args.kind] ? args.kind : 'text';
  let parent;
  if (args.category) {
    const target = resolveChannel(guild, args.category);
    if (target.type !== ChannelType.GuildCategory) throw new ToolError(`'${target.name}' is not a category.`);
    parent = target.id;
  }
  const channel = await guild.channels.create({
    name: args.name, type: CHANNEL_KIND_TYPES[kind], parent,
  });
  await logAction(guild, 'channel_create', actor(message), channel.name, kind);
  return `Created ${kind} channel #${channel.name} (id ${channel.id}).`;
}

async function deleteChannel(client, message, args) {
  const channel = resolveChannel(message.guild, args.channel);
  const name = channel.name;
  await channel.delete();
  await logAction(message.guild, 'channel_delete', actor(message), name, null);
  return `Deleted channel #${name}.`;
}

async function setChannelTopic(client, message, args) {
  const channel = textChannel(message, args);
  await channel.setTopic(args.topic);
  return `Updated topic for #${channel.name}.`;
}

async function sendMessage(client, message, args) {
  const channel = textChannel(message, args);
  await channel.send(String(args.content).slice(0, 2000));
  return `Sent the message to #${channel.name}.`;
}

// -- role tools -----------------------------------------------------------------

async function giveRole(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  const role = resolveRole(message.guild, args.role);
  await m.roles.add(role);
  await logAction(message.guild, 'role_add', actor(message), m.user.tag, role.name);
  return `Gave ${role.name} to ${m.user.tag}.`;
}

async function takeRole(client, message, args) {
  const m = await resolveMember(message.guild, args.user);
  const role = resolveRole(message.guild, args.role);
  await m.roles.remove(role);
  await logAction(message.guild, 'role_remove', actor(message), m.user.tag, role.name);
  return `Removed ${role.name} from ${m.user.tag}.`;
}

async function createRole(client, message, args) {
  let color;
  if (args.color) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(args.color)) throw new ToolError('Invalid hex color; use e.g. #5865F2.');
    color = parseInt(args.color.replace('#', ''), 16);
  }
  const role = await message.guild.roles.create({ name: args.name, color });
  await logAction(message.guild, 'role_create', actor(message), role.name, null);
  return `Created role ${role.name} (id ${role.id}).`;
}

async function deleteRole(client, message, args) {
  const role = resolveRole(message.guild, args.role);
  const name = role.name;
  await role.delete();
  await logAction(message.guild, 'role_delete', actor(message), name, null);
  return `Deleted role ${name}.`;
}

// -- registry ---------------------------------------------------------------

const USER = str('The member: a mention, user ID, username, or display name');
const CHANNEL_OPT = str('Channel name, mention, or ID (defaults to the current channel)');

export const TOOLS = {
  server_info: [schema('server_info', 'Get a summary of this server (name, owner, member/channel/role counts).'), serverInfo],
  list_channels: [schema('list_channels', 'List every channel in the server with its ID and type.'), listChannels],
  list_roles: [schema('list_roles', 'List every role in the server with its ID and member count.'), listRoles],
  member_info: [schema('member_info', 'Get details about one member (roles, join date, timeout status).',
    { user: USER }, ['user']), memberInfo],
  search_members: [schema('search_members', 'Search members by name or display name.',
    { query: str('Text to match against usernames and display names'), limit: int('Max results (default 10, max 25)') },
    ['query']), searchMembers],
  get_mod_logs: [schema('get_mod_logs', 'Show recent moderation log entries for this server.',
    { limit: int('How many entries (default 15, max 50)') }), getModLogs],
  kick_member: [schema('kick_member', 'Kick a member from the server.',
    { user: USER, reason: str('Reason for the kick') }, ['user']), kickMember],
  ban_member: [schema('ban_member', 'Ban a member from the server.',
    { user: USER, reason: str('Reason for the ban'), delete_days: int('Days of their messages to delete (0-7, default 0)') },
    ['user']), banMember],
  unban_user: [schema('unban_user', 'Unban a user by their numeric Discord ID.',
    { user_id: str('Numeric Discord user ID'), reason: str('Reason for the unban') }, ['user_id']), unbanUser],
  timeout_member: [schema('timeout_member', 'Timeout (mute) a member for a number of minutes.',
    { user: USER, minutes: int('Duration in minutes (1-40320)'), reason: str('Reason for the timeout') },
    ['user', 'minutes']), timeoutMember],
  untimeout_member: [schema('untimeout_member', "Remove a member's timeout.", { user: USER }, ['user']), untimeoutMember],
  warn_member: [schema('warn_member', 'Warn a member (recorded, and DMed to them).',
    { user: USER, reason: str('Reason for the warning') }, ['user', 'reason']), warnMember],
  list_warnings: [schema('list_warnings', "List a member's warnings.", { user: USER }, ['user']), listWarnings],
  clear_warnings: [schema('clear_warnings', 'Clear all warnings for a member.', { user: USER }, ['user']), clearWarnings],
  purge_messages: [schema('purge_messages', 'Delete recent messages in a channel.',
    { amount: int('Number of messages to delete (1-100)'), channel: CHANNEL_OPT }, ['amount']), purgeMessages],
  set_slowmode: [schema('set_slowmode', 'Set slowmode delay for a text channel (0 disables).',
    { seconds: int('Seconds between messages (0-21600)'), channel: CHANNEL_OPT }, ['seconds']), setSlowmode],
  lock_channel: [schema('lock_channel', 'Lock or unlock a text channel for @everyone.',
    { locked: { type: 'boolean', description: 'true to lock, false to unlock (default true)' }, channel: CHANNEL_OPT }),
    lockChannel],
  create_channel: [schema('create_channel', 'Create a text, voice, category, or forum channel.',
    {
      name: str('Name for the new channel'),
      kind: { type: 'string', enum: ['text', 'voice', 'category', 'forum'], description: 'Channel type (default text)' },
      category: str('Category to place the channel in (optional)'),
    }, ['name']), createChannel],
  delete_channel: [schema('delete_channel', 'Delete a channel.', { channel: str('Channel name, mention, or ID') },
    ['channel']), deleteChannel],
  set_channel_topic: [schema('set_channel_topic', 'Set the topic of a text channel.',
    { topic: str('New channel topic'), channel: CHANNEL_OPT }, ['topic']), setChannelTopic],
  send_message: [schema('send_message', 'Send a message as the bot to a channel.',
    { content: str('The message to send'), channel: CHANNEL_OPT }, ['content']), sendMessage],
  give_role: [schema('give_role', 'Give a role to a member.',
    { user: USER, role: str('Role name, mention, or ID') }, ['user', 'role']), giveRole],
  take_role: [schema('take_role', 'Remove a role from a member.',
    { user: USER, role: str('Role name, mention, or ID') }, ['user', 'role']), takeRole],
  create_role: [schema('create_role', 'Create a new role.',
    { name: str('Name for the new role'), color: str('Hex color, e.g. #5865F2 (optional)') }, ['name']), createRole],
  delete_role: [schema('delete_role', 'Delete a role.', { role: str('Role name, mention, or ID') }, ['role']), deleteRole],
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(([s]) => s);

/** Run one tool call and return its result string (never throws). ownerId
 * is an injectable override for testing (mirrors isOwner/requireOwner) —
 * real call sites never pass it. */
export async function execute(client, message, name, args, ownerId) {
  if (!isOwner(message.author.id, ownerId)) return 'Error: only the bot owner can use management tools.';
  const entry = TOOLS[name];
  if (!entry) return `Error: unknown tool '${name}'.`;
  try {
    return await entry[1](client, message, args || {});
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    if (err.code === 50013 || err.status === 403) {
      return "Error: I don't have permission to do that. Check my role position and permissions.";
    }
    if (err.name === 'DiscordAPIError') return `Error: Discord API error: ${err.message}`;
    return `Error: bad or missing tool arguments (${err.message}).`;
  }
}
