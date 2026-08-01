import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('timeout')
  .setDescription('Timeout a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('member').setDescription('Member to timeout').setRequired(true))
  .addIntegerOption((o) => o.setName('minutes').setDescription('Duration in minutes (max 40320 = 28 days)')
    .setRequired(true).setMinValue(1).setMaxValue(40320))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the timeout'));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  const minutes = interaction.options.getInteger('minutes', true);
  const reason = interaction.options.getString('reason');
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  await member.timeout(minutes * 60_000, reason || undefined);
  await logAction(interaction.guild, 'timeout', interaction.user, member, `${reason || 'No reason'} (${minutes}m)`);
  await interaction.reply({ content: `Timed out **${member.user.tag}** for ${minutes} minute(s).`, ephemeral: true });
}
