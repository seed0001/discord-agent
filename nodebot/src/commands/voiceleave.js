import { SlashCommandBuilder } from 'discord.js';
import { isOwner } from '../utils.js';
import { leaveRequestedGuild } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('voiceleave')
  .setDescription('Make the bot leave voice');

export async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'Owner-only command.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  leaveRequestedGuild(interaction.guild);
  await interaction.editReply('Left voice.');
}
