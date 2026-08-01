import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('member').setDescription('Member to warn').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  const reason = interaction.options.getString('reason', true);
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  db.addWarning(interaction.guild.id, member.id, interaction.user.id, reason);
  await logAction(interaction.guild, 'warn', interaction.user, member, reason);
  const count = db.getWarnings(interaction.guild.id, member.id).length;
  try {
    await member.send(`You were warned in **${interaction.guild.name}**: ${reason}`);
  } catch { /* DMs closed — moderation still recorded */ }
  await interaction.reply({ content: `Warned **${member.user.tag}** (warning #${count}).`, ephemeral: true });
}
