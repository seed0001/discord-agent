import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('slowmode')
  .setDescription('Set slowmode for this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addIntegerOption((o) => o.setName('seconds').setDescription('Seconds between messages (0 to disable, max 21600)')
    .setRequired(true).setMinValue(0).setMaxValue(21600));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const seconds = interaction.options.getInteger('seconds', true);
  await interaction.channel.setRateLimitPerUser(seconds);
  await interaction.reply({
    content: seconds ? `Slowmode set to ${seconds}s.` : 'Slowmode disabled.',
    ephemeral: true,
  });
}
