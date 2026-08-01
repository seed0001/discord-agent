import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('unlock')
  .setDescription('Unlock this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
  await logAction(interaction.guild, 'unlock', interaction.user, `#${interaction.channel.name}`, null);
  await interaction.reply({ content: 'Channel unlocked.', ephemeral: true });
}
