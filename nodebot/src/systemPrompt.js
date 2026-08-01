// One place that assembles the system prompt, so text chat and voice cannot
// drift into describing two different bots. Ported from the Python bot's
// ai.py build_system_prompt.
//
// The order matters and matches Python's: who he is, then what server he is
// actually running and its real command list, then what he can do, then
// whether he is talking to the owner, then what he remembers.
//
// Lives here rather than in persona.js because it reads settings, and
// persona.js is imported BY db.js — putting it there would be a cycle.
import * as db from './db.js';
import { OWNER_NOTE, MEMBER_NOTE } from './persona.js';

/** The bot's real slash commands, straight from the table index.js loaded.
 *
 * Generated rather than written into the capability prompt on purpose: a
 * hardcoded list goes stale the moment a command is added or removed, and a
 * persona that lists commands which don't exist is exactly the failure the
 * capability prompt is supposed to prevent. */
export function commandList(client) {
  const commands = [...(client?.commands?.values?.() || [])]
    .map((c) => {
      try {
        return c?.data?.toJSON?.() || c?.data || null;
      } catch {
        return null;
      }
    })
    .filter((d) => d && d.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return commands.map((c) => `- /${c.name}: ${c.description || ''}`).join('\n');
}

/**
 * @param {object}  opts
 * @param {object}  opts.client   discord.js Client (for the bot name + commands)
 * @param {object}  opts.guild    the guild being served
 * @param {boolean} opts.owner    is the speaker the bot owner
 * @param {string}  opts.memory   memory block, already rendered (may be empty)
 */
export function buildSystemPrompt({ client, guild, owner = false, memory = '' }) {
  const persona = db.getSetting(guild.id, 'ai_system_prompt');
  const capabilities = db.getSetting(guild.id, 'ai_capability_prompt');
  const name = client?.user?.displayName || client?.user?.username || 'Max';
  const commands = commandList(client);

  const selfAwareness = `You are ${name}, the bot that manages the Discord server `
    + `"${guild.name}" (${guild.memberCount} members). You are not just a chatbot — `
    + 'you run this place. Server members interact with you by mentioning you or '
    + `using your slash commands:${commands ? `\n${commands}` : ''}`;

  return [
    persona,
    selfAwareness,
    capabilities,
    owner ? OWNER_NOTE : MEMBER_NOTE,
    memory ? `What you remember (maintained across restarts):\n${memory}` : '',
  ].filter(Boolean).join('\n\n');
}
