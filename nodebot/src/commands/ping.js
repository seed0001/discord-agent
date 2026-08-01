import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription("Check the bot's latency");

export async function execute(interaction) {
  await interaction.reply({
    content: `Pong! \`${Math.round(interaction.client.ws.ping)}ms\``,
    ephemeral: true,
  });
}
