import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { requireOwner } from '../utils.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('warnings')
  .setDescription("List a member's warnings")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('member').setDescription('Member whose warnings to show').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  const rows = db.getWarnings(interaction.guild.id, member.id);
  if (!rows.length) {
    await interaction.reply({ content: `**${member.user.tag}** has no warnings.`, ephemeral: true });
    return;
  }
  const lines = rows.slice(0, 15)
    .map((r) => `\`#${r.id}\` <t:${r.created_at}:R> — ${r.reason || 'No reason'}`);
  const embed = new EmbedBuilder()
    .setTitle(`Warnings for ${member.user.tag} (${rows.length})`)
    .setDescription(lines.join('\n'))
    .setColor(0xF0B232);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
