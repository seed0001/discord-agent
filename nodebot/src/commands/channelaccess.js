import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('channelaccess')
  .setDescription('Show or hide a channel for a role (View Channel permission)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addBooleanOption((o) => o.setName('visible').setDescription('Can this role see the channel?').setRequired(true))
  .addRoleOption((o) => o.setName('role').setDescription('Role to change (defaults to @everyone)'))
  .addChannelOption((o) => o.setName('channel').setDescription('Channel to change (defaults to this channel)'));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const visible = interaction.options.getBoolean('visible', true);
  const role = interaction.options.getRole('role') || interaction.guild.roles.everyone;
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  await channel.permissionOverwrites.edit(role, { ViewChannel: visible });
  await logAction(interaction.guild, 'channel_access', interaction.user, `#${channel.name}`,
    `${role.name} -> ${visible ? 'visible' : 'hidden'}`);
  await interaction.reply({
    content: `**#${channel.name}** is now ${visible ? 'visible' : 'hidden'} for **${role.name}**.`,
    ephemeral: true,
  });
}
