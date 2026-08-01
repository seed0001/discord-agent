import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('takerole')
  .setDescription('Remove a role from a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addUserOption((o) => o.setName('member').setDescription('Member to remove the role from').setRequired(true))
  .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  const role = interaction.options.getRole('role', true);
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  await member.roles.remove(role);
  await logAction(interaction.guild, 'role_remove', interaction.user, member.user.tag, role.name);
  await interaction.reply({ content: `Removed **${role.name}** from **${member.user.tag}**.`, ephemeral: true });
}
