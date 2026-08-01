import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('deleterole')
  .setDescription('Delete a role')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addRoleOption((o) => o.setName('role').setDescription('Role to delete').setRequired(true));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const role = interaction.options.getRole('role', true);
  const name = role.name;
  await role.delete();
  await logAction(interaction.guild, 'role_delete', interaction.user, name, null);
  await interaction.reply({ content: `Deleted role **${name}**.`, ephemeral: true });
}
