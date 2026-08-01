import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Delete recent messages in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((o) => o.setName('amount').setDescription('Number of messages to delete (1-100)')
    .setRequired(true).setMinValue(1).setMaxValue(100));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const amount = interaction.options.getInteger('amount', true);
  await interaction.deferReply({ ephemeral: true });
  const deleted = await interaction.channel.bulkDelete(amount, true);
  await logAction(interaction.guild, 'purge', interaction.user, `#${interaction.channel.name}`, `${deleted.size} messages`);
  await interaction.editReply(`Deleted ${deleted.size} message(s).`);
}
