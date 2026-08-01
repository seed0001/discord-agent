import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { requireOwner, formatTemplate } from '../utils.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('testwelcome')
  .setDescription('Preview the welcome message using yourself')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const template = db.getSetting(interaction.guild.id, 'welcome_message');
  await interaction.reply({ content: formatTemplate(template, interaction.member), ephemeral: true });
}
