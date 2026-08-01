// Automatic message moderation: banned words, invite links, mention spam.
// Ported from bot/cogs/automod.py.
import { PermissionFlagsBits } from 'discord.js';
import { logAction } from './utils.js';
import * as db from './db.js';

const INVITE_RE = /(discord\.gg\/|discord(?:app)?\.com\/invite\/)/i;

/** Returns a violation description string, or null if the message is clean. */
export function findViolation(guild, member, content, mentionCount) {
  if (!db.getSetting(guild.id, 'automod_enabled')) return null;

  const lower = content.toLowerCase();
  const bannedWords = db.getSetting(guild.id, 'banned_words') || [];
  for (const word of bannedWords) {
    if (word && lower.includes(word.toLowerCase())) return `banned word: ${word}`;
  }

  if (db.getSetting(guild.id, 'block_invites') && INVITE_RE.test(content)) return 'invite link';

  const maxMentions = Number(db.getSetting(guild.id, 'max_mentions')) || 0;
  if (maxMentions && mentionCount > maxMentions) return `mention spam (${mentionCount} mentions)`;

  return null;
}

export async function checkMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const violation = findViolation(
    message.guild, message.member, message.content, message.mentions.users.size,
  );
  if (!violation) return;

  try {
    await message.delete();
  } catch (err) {
    console.warn('[automod] delete failed:', err.message);
    return;
  }
  await logAction(message.guild, 'automod', 'AutoMod', message.author, violation);
  try {
    const warning = await message.channel.send(
      `${message.author}, your message was removed (${violation}).`,
    );
    setTimeout(() => warning.delete().catch(() => {}), 6000).unref();
  } catch (err) {
    console.warn('[automod] warning post failed:', err.message);
  }
}
