import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('deletechannel')
  .setDescription('Delete a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addChannelOption((o) => o.setName('channel').setDescription('Channel to delete').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const channel = interaction.options.getChannel('channel', true);
  const name = channel.name;
  await channel.delete();
  await logAction(interaction.guild, 'channel_delete', interaction.user, name, null);
  await interaction.reply({ content: `Deleted channel **${name}**.`, ephemeral: true });
}
