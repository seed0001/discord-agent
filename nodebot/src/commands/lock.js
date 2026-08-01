import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('lock')
  .setDescription('Lock this channel (prevent @everyone from sending messages)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
  await logAction(interaction.guild, 'lock', interaction.user, `#${interaction.channel.name}`, null);
  await interaction.reply({ content: 'Channel locked.', ephemeral: true });
}
