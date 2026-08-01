import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { requireOwner } from '../utils.js';

export const data = new SlashCommandBuilder()
  .setName('settopic')
  .setDescription('Set the topic of a text channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((o) => o.setName('topic').setDescription('New topic').setRequired(true))
  .addChannelOption((o) => o.setName('channel').setDescription('Channel to edit (defaults to current)')
    .addChannelTypes(ChannelType.GuildText));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const topic = interaction.options.getString('topic', true);
  const target = interaction.options.getChannel('channel') || interaction.channel;
  await target.setTopic(topic);
  await interaction.reply({ content: `Updated topic for ${target}.`, ephemeral: true });
}
