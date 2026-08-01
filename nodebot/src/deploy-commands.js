/** Registers slash commands with Discord. Run after adding/changing a
 * command: `npm run deploy-commands`.
 *
 * Uses DEV_GUILD_ID if set (shows up instantly — handy while iterating),
 * otherwise registers globally (Max's real command list, up to ~1hr to
 * propagate). */
import { REST, Routes } from 'discord.js';
import { CLIENT_ID, DEV_GUILD_ID, DISCORD_TOKEN } from './config.js';
import { loadCommands } from './load-commands.js';

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and CLIENT_ID are required (see .env.example)');
  process.exit(1);
}

const commands = await loadCommands();
const body = [...commands.values()].map((c) => c.data.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);
const route = DEV_GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

const result = await rest.put(route, { body });
console.log(
  `Registered ${result.length} command(s) ${DEV_GUILD_ID ? `to guild ${DEV_GUILD_ID}` : 'globally'}: `
  + body.map((c) => c.name).join(', ')
);
