import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { requireOwner, logAction } from '../utils.js';

const KIND_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  forum: ChannelType.GuildForum,
};

export const data = new SlashCommandBuilder()
  .setName('createchannel')
  .setDescription('Create a channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((o) => o.setName('name').setDescription('Channel name').setRequired(true))
  .addStringOption((o) => o.setName('kind').setDescription('Channel type').addChoices(
    { name: 'Text', value: 'text' },
    { name: 'Voice', value: 'voice' },
    { name: 'Category', value: 'category' },
    { name: 'Forum', value: 'forum' },
  ));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const name = interaction.options.getString('name', true);
  const kind = interaction.options.getString('kind') || 'text';
  const channel = await interaction.guild.channels.create({ name, type: KIND_TYPES[kind] });
  await logAction(interaction.guild, 'channel_create', interaction.user, channel.name, kind);
  await interaction.reply({ content: `Created ${kind} channel **${channel.name}**.`, ephemeral: true });
}
