import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Unban a user by their ID')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption((o) => o.setName('user_id').setDescription('ID of the user to unban').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the unban'));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const userId = interaction.options.getString('user_id', true);
  const reason = interaction.options.getString('reason');
  if (!/^\d+$/.test(userId)) {
    await interaction.reply({ content: "That's not a valid user ID.", ephemeral: true });
    return;
  }
  await interaction.guild.bans.remove(userId, reason || undefined);
  await logAction(interaction.guild, 'unban', interaction.user, userId, reason);
  await interaction.reply({ content: `Unbanned user \`${userId}\`.`, ephemeral: true });
}
