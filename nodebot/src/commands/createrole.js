import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('createrole')
  .setDescription('Create a new role')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addStringOption((o) => o.setName('name').setDescription('Name for the new role').setRequired(true))
  .addStringOption((o) => o.setName('color').setDescription('Hex color, e.g. #5865F2'));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const name = interaction.options.getString('name', true);
  const colorInput = interaction.options.getString('color');
  let color;
  if (colorInput) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(colorInput)) {
      await interaction.reply({ content: 'Invalid hex color.', ephemeral: true });
      return;
    }
    color = parseInt(colorInput.replace('#', ''), 16);
  }
  const role = await interaction.guild.roles.create({ name, color });
  await logAction(interaction.guild, 'role_create', interaction.user, role.name, null);
  await interaction.reply({ content: `Created role **${role.name}**.`, ephemeral: true });
}
