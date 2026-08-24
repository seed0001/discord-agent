import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { requireOwner } from '../utils.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('gatekeeping')
  .setDescription('Configure the new-member lobby vetting flow')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s
    .setName('status')
    .setDescription('Show the current gatekeeping configuration'))
  .addSubcommand((s) => s
    .setName('enable')
    .setDescription('Turn gatekeeping on for this server'))
  .addSubcommand((s) => s
    .setName('disable')
    .setDescription('Turn gatekeeping off for this server'))
  .addSubcommand((s) => s
    .setName('setup')
    .setDescription('Set the lobby channels and roles gatekeeping uses')
    .addChannelOption((o) => o
      .setName('lobby_voice')
      .setDescription('Voice channel where new members get interviewed')
      .addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption((o) => o
      .setName('lobby_text')
      .setDescription('Text channel: waiting room + text-only interviews')
      .addChannelTypes(ChannelType.GuildText))
    .addChannelOption((o) => o
      .setName('mod_channel')
      .setDescription('Where vetting recommendations get posted for approval')
      .addChannelTypes(ChannelType.GuildText))
    .addRoleOption((o) => o
      .setName('unverified_role')
      .setDescription('Role new members get before they are vetted'))
    .addRoleOption((o) => o
      .setName('verified_role')
      .setDescription('Role granted on approval (optional — otherwise just removes unverified)')));

export async function execute(interaction) {
  if (!(await requireOwner(interaction))) return;
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const s = {
      enabled: db.getSetting(guild.id, 'gatekeeping_enabled'),
      lobbyVoice: db.getSetting(guild.id, 'gatekeeping_lobby_voice_channel'),
      lobbyText: db.getSetting(guild.id, 'gatekeeping_lobby_text_channel'),
      modChannel: db.getSetting(guild.id, 'gatekeeping_mod_channel'),
      unverifiedRole: db.getSetting(guild.id, 'gatekeeping_unverified_role'),
      verifiedRole: db.getSetting(guild.id, 'gatekeeping_verified_role'),
    };
    await interaction.reply({
      content: [
        `Enabled: **${s.enabled ? 'yes' : 'no'}**`,
        `Lobby voice channel: ${s.lobbyVoice ? `<#${s.lobbyVoice}>` : '—'}`,
        `Lobby text channel: ${s.lobbyText ? `<#${s.lobbyText}>` : '—'}`,
        `Mod approval channel: ${s.modChannel ? `<#${s.modChannel}>` : '—'}`,
        `Unverified role: ${s.unverifiedRole ? `<@&${s.unverifiedRole}>` : '—'}`,
        `Verified role: ${s.verifiedRole ? `<@&${s.verifiedRole}>` : '—'}`,
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const enabling = sub === 'enable';
    if (enabling) {
      const missing = [];
      if (!db.getSetting(guild.id, 'gatekeeping_lobby_voice_channel')
        && !db.getSetting(guild.id, 'gatekeeping_lobby_text_channel')) missing.push('a lobby voice or text channel');
      if (!db.getSetting(guild.id, 'gatekeeping_unverified_role')) missing.push('an unverified role');
      if (!db.getSetting(guild.id, 'gatekeeping_mod_channel')) missing.push('a mod approval channel');
      if (missing.length) {
        await interaction.reply({
          content: `Run \`/gatekeeping setup\` first — missing: ${missing.join(', ')}.`,
          ephemeral: true,
        });
        return;
      }
    }
    db.setSetting(guild.id, 'gatekeeping_enabled', enabling);
    await interaction.reply({ content: `Gatekeeping is now **${enabling ? 'on' : 'off'}**.`, ephemeral: true });
    return;
  }

  // setup
  const lobbyVoice = interaction.options.getChannel('lobby_voice');
  const lobbyText = interaction.options.getChannel('lobby_text');
  const modChannel = interaction.options.getChannel('mod_channel');
  const unverifiedRole = interaction.options.getRole('unverified_role');
  const verifiedRole = interaction.options.getRole('verified_role');
  if (lobbyVoice) db.setSetting(guild.id, 'gatekeeping_lobby_voice_channel', lobbyVoice.id);
  if (lobbyText) db.setSetting(guild.id, 'gatekeeping_lobby_text_channel', lobbyText.id);
  if (modChannel) db.setSetting(guild.id, 'gatekeeping_mod_channel', modChannel.id);
  if (unverifiedRole) db.setSetting(guild.id, 'gatekeeping_unverified_role', unverifiedRole.id);
  if (verifiedRole) db.setSetting(guild.id, 'gatekeeping_verified_role', verifiedRole.id);
  if (!lobbyVoice && !lobbyText && !modChannel && !unverifiedRole && !verifiedRole) {
    await interaction.reply({ content: 'Nothing to set — pass at least one option.', ephemeral: true });
    return;
  }
  await interaction.reply({
    content: 'Updated. Run `/gatekeeping status` to review, then `/gatekeeping enable` when ready.',
    ephemeral: true,
  });
}
