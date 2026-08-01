import { EmbedBuilder } from 'discord.js';
import { OWNER_ID } from './config.js';
import * as db from './db.js';

/** True if userId is the configured bot owner (OWNER_ID env var). ownerId is
 * an injectable override for testing — real call sites never pass it. */
export function isOwner(userId, ownerId = OWNER_ID) {
  return Boolean(ownerId) && String(userId) === String(ownerId);
}

/** Owner gate for a command's execute(): replies and returns false if the
 * caller isn't the owner, so a command body can `if (!(await requireOwner
 * (interaction))) return;` as its first line — same shape as the Python
 * bot's owner_only()/interaction_check, just inline instead of a decorator
 * (flat command files here, not a per-cog check). ownerId is an injectable
 * override for testing, same as isOwner's — real call sites never pass it. */
export async function requireOwner(interaction, ownerId = OWNER_ID) {
  if (isOwner(interaction.user.id, ownerId)) return true;
  await interaction.reply({ content: 'Owner-only command.', ephemeral: true });
  return false;
}

const ACTION_COLORS = {
  kick: 0xF0B232,
  ban: 0xDA373C,
  unban: 0x23A559,
  timeout: 0xF0B232,
  untimeout: 0x23A559,
  warn: 0xF0B232,
  purge: 0x5865F2,
};

/** Record a moderation action to the DB and, if a log channel is set, post
 * an embed there. Ported from bot/utils.py's log_action. */
export async function logAction(guild, action, actor, target = null, reason = null) {
  db.addLog(guild.id, action, String(actor), target !== null ? String(target) : null, reason);
  const channelId = db.getSetting(guild.id, 'log_channel');
  if (!channelId) return;
  const channel = guild.channels.cache.get(String(channelId));
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle(action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .setColor(ACTION_COLORS[action] ?? 0x5865F2)
    .setTimestamp()
    .addFields({ name: 'Actor', value: String(actor) });
  if (target !== null) embed.addFields({ name: 'Target', value: String(target) });
  if (reason) embed.addFields({ name: 'Reason', value: reason });
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn('[utils] logAction post failed:', err.message);
  }
}

/** Fill {user}, {server}, {membercount} placeholders in welcome/goodbye
 * templates. Ported from bot/utils.py's format_template. `member` needs a
 * mention-form toString() (real discord.js GuildMember/User both have
 * one — it delegates to `<@id>`), plus .guild.name/.guild.memberCount. */
export function formatTemplate(template, member) {
  return template
    .replaceAll('{user}', String(member))
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membercount}', String(member.guild.memberCount));
}
