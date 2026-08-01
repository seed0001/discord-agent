// Welcome/goodbye messages and autorole — ported from bot/cogs/welcome.py.
import { formatTemplate } from './utils.js';
import * as db from './db.js';

export async function handleMemberAdd(member) {
  const guild = member.guild;
  const roleId = db.getSetting(guild.id, 'autorole');
  if (roleId) {
    const role = guild.roles.cache.get(String(roleId));
    if (role) {
      try {
        await member.roles.add(role, 'Autorole');
      } catch (err) {
        console.warn('[welcome] autorole failed:', err.message);
      }
    }
  }
  const channelId = db.getSetting(guild.id, 'welcome_channel');
  const template = db.getSetting(guild.id, 'welcome_message');
  if (channelId && template) {
    const channel = guild.channels.cache.get(String(channelId));
    if (channel) {
      try {
        await channel.send(formatTemplate(template, member));
      } catch (err) {
        console.warn('[welcome] welcome message failed:', err.message);
      }
    }
  }
}

export async function handleMemberRemove(member) {
  const guild = member.guild;
  const channelId = db.getSetting(guild.id, 'welcome_channel');
  const template = db.getSetting(guild.id, 'goodbye_message');
  if (channelId && template) {
    const channel = guild.channels.cache.get(String(channelId));
    if (channel) {
      try {
        await channel.send(formatTemplate(template, member));
      } catch (err) {
        console.warn('[welcome] goodbye message failed:', err.message);
      }
    }
  }
}
