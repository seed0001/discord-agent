import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('clearwarnings')
  .setDescription('Clear all warnings for a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('member').setDescription('Member whose warnings to clear').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  const count = db.clearWarnings(interaction.guild.id, member.id);
  await logAction(interaction.guild, 'clear_warnings', interaction.user, member, `${count} removed`);
  await interaction.reply({ content: `Cleared ${count} warning(s) for **${member.user.tag}**.`, ephemeral: true });
}
