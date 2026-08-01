import { SlashCommandBuilder } from 'discord.js';
import { isOwner } from '../utils.js';
import { joinRequestedChannel } from '../voice.js';
import { available } from '../transcription.js';

export const data = new SlashCommandBuilder()
  .setName('voicejoin')
  .setDescription('Make the bot join your voice channel and listen');

export async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'Owner-only command.', ephemeral: true });
    return;
  }
  if (!available()) {
    await interaction.reply({
      content: "Voice monitoring isn't available (TRANSCRIPTION_API_KEY not set).",
      ephemeral: true,
    });
    return;
  }
  const state = interaction.member?.voice;
  if (!state?.channel) {
    await interaction.reply({ content: "You're not in a voice channel.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await joinRequestedChannel(state.channel);
  await interaction.editReply(`Listening in **${state.channel.name}**.`);
}
