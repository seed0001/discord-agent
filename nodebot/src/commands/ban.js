import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a member from the server')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption((o) => o.setName('member').setDescription('Member to ban').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban'))
  .addIntegerOption((o) => o.setName('delete_days').setDescription('Days of their messages to delete (0-7)')
    .setMinValue(0).setMaxValue(7));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  const reason = interaction.options.getString('reason');
  const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  await member.ban({ reason: reason || undefined, deleteMessageSeconds: deleteDays * 86400 });
  await logAction(interaction.guild, 'ban', interaction.user, member, reason);
  await interaction.reply({ content: `Banned **${member.user.tag}**.`, ephemeral: true });
}
