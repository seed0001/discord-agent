import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('giverole')
  .setDescription('Give a role to a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addUserOption((o) => o.setName('member').setDescription('Member to give the role to').setRequired(true))
  .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const member = interaction.options.getMember('member');
  const role = interaction.options.getRole('role', true);
  if (!member) {
    await interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
    return;
  }
  await member.roles.add(role);
  await logAction(interaction.guild, 'role_add', interaction.user, member.user.tag, role.name);
  await interaction.reply({ content: `Gave **${role.name}** to **${member.user.tag}**.`, ephemeral: true });
}
