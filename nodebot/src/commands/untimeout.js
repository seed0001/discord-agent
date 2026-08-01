import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('untimeout')
  .setDescription("Remove a member's timeout")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('member').setDescription('Member to remove the timeout from').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  await member.timeout(null);
  await logAction(interaction.guild, 'untimeout', interaction.user, member, null);
  await interaction.reply({ content: `Removed timeout for **${member.user.tag}**.`, ephemeral: true });
}
