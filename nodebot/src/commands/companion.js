// /companion — owner-only debug/observability for the Private Companion
// relationship system. Same shape as /pressure: status + a small log view +
// a way to force a decision cycle for local testing, nothing that exposes
// this to a normal member.
import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { requireOwner } from '../utils.js';
import * as db from '../db.js';
import * as stateMod from '../companion/state.js';
import * as events from '../companion/events.js';
import * as threadsMod from '../companion/threads.js';
import * as session from '../companion/session.js';
import * as scheduler from '../companion/scheduler.js';
import * as drivesMod from '../companion/drives.js';

export const data = new SlashCommandBuilder()
  .setName('companion')
  .setDescription('Private Companion system status and debug tools (owner only)')
  .addSubcommand((s) => s.setName('status').setDescription('Current relationship state and session status'))
  .addSubcommand((s) => s.setName('log').setDescription('Recent companion event log')
    .addIntegerOption((o) => o.setName('count').setDescription('How many events (default 15)')))
  .addSubcommand((s) => s.setName('test-invite').setDescription('Force a decision cycle now, bypassing cooldown'))
  .addSubcommand((s) => s.setName('residence-mode').setDescription(
    'Toggle residence mode: trims GitHub/repo tools and their capability info (persona untouched)',
  )
    .addBooleanOption((o) => o.setName('enabled').setDescription('Turn residence mode on or off').setRequired(true)))
  .addSubcommand((s) => s.setName('drives').setDescription('Her current internal drives (energy/restlessness/boredom/social pull) and phase'))
  .addSubcommandGroup((g) => g.setName('cycle').setDescription('Residence drive-cycle debug tools')
    .addSubcommand((s) => s.setName('force').setDescription('Snap her straight to a phase, bypassing real thresholds (testing only)')
      .addStringOption((o) => o.setName('phase').setDescription('Phase to force').setRequired(true)
        .addChoices(
          { name: 'sleep', value: 'sleep' },
          { name: 'work', value: 'work' },
          { name: 'relax', value: 'relax' },
          { name: 'social', value: 'social' },
        ))))
  .addSubcommandGroup((g) => g.setName('room').setDescription('Residence rooms she moves between')
    .addSubcommand((s) => s.setName('add').setDescription('Register a room for a phase')
      .addStringOption((o) => o.setName('name').setDescription('Display name, e.g. "the beach"').setRequired(true))
      .addStringOption((o) => o.setName('phase').setDescription('Which phase this room is used for').setRequired(true)
        .addChoices(
          { name: 'work', value: 'work' },
          { name: 'relax', value: 'relax' },
          { name: 'social', value: 'social' },
        ))
      .addChannelOption((o) => o.setName('voice_channel').setDescription('Voice channel for this room').setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName('text_channel').setDescription('Text channel for arrival/journal lines (optional)')
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('list').setDescription('List her registered rooms'))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a room')
      .addIntegerOption((o) => o.setName('id').setDescription('Room id, from /companion room list').setRequired(true))));

export async function execute(interaction) {
  if (!await requireOwner(interaction)) return;
  const { guild } = interaction;
  const primaryUserId = db.getSetting(guild.id, 'companion_primary_user_id');
  const sub = interaction.options.getSubcommand();

  if (!db.getSetting(guild.id, 'companion_enabled') || !primaryUserId) {
    await interaction.reply({
      content: 'Companion Mode is not enabled/configured on this server (Settings -> Companion).',
      ephemeral: true,
    });
    return;
  }

  if (sub === 'status') {
    const state = stateMod.load(guild.id, primaryUserId);
    const pressures = Object.entries(state.pressures).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ');
    const absence = stateMod.derivedAbsence(state).toFixed(2);
    const residenceMode = db.getSetting(guild.id, 'companion_residence_mode');
    const socialPull = residenceMode ? drivesMod.load(guild.id).socialPull : 0;
    const drive = stateMod.computeReachOutDrive(state, undefined, { socialPull });
    const openThreads = threadsMod.openThreads(guild.id, primaryUserId, 5)
      .map((t) => `- ${t.title} (importance ${t.importance.toFixed(2)})`).join('\n') || '(none)';
    const s = session.get(guild.id);

    await interaction.reply({
      content: '**Companion status**\n'
        + `Pressures: ${pressures}\n`
        + `absence=${absence}\n`
        + `reach_out_drive=${drive.drive.toFixed(2)} (threshold ${stateMod.DRIVE.INITIATE_THRESHOLD})`
        + `${residenceMode ? ` [includes social_pull bonus ${drive.socialPullBonus.toFixed(2)}]` : ''}\n`
        + `sessionsToday=${state.sessionsToday} invitesToday=${state.invitesToday} `
        + `consecutiveIgnored=${state.consecutiveIgnored}\n`
        + `Session: ${s ? s.status : 'idle'}${s?.intent ? ` (intent=${s.intent.code})` : ''}\n`
        + `Open threads:\n${openThreads}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'log') {
    const count = interaction.options.getInteger('count') || 15;
    const rows = events.recent(guild.id, primaryUserId, count);
    const lines = rows.map((r) => `${new Date(r.created_at * 1000).toISOString()} ${r.type}`
      + `${r.data ? ` ${JSON.stringify(r.data)}` : ''}`);
    await interaction.reply({
      content: (lines.join('\n') || '(no events yet)').slice(0, 1990),
      ephemeral: true,
    });
    return;
  }

  if (sub === 'test-invite') {
    await interaction.deferReply({ ephemeral: true });
    await scheduler.forceEvaluate(interaction.client, guild);
    await interaction.editReply('Forced a decision cycle — check the console log and /companion status for the outcome.');
    return;
  }

  if (sub === 'residence-mode') {
    const enabled = interaction.options.getBoolean('enabled');
    db.setSetting(guild.id, 'companion_residence_mode', enabled);
    // Only ever touches this one flag. Her persona (ai_system_prompt) is
    // never written here — that stays entirely whatever you've configured on
    // the dashboard. The capability info block (ai_capability_prompt) is
    // also left alone if you've already saved your own copy; only the
    // computed DEFAULT shown when you haven't changes (see systemPrompt.js).
    await interaction.reply({
      content: `Residence mode ${enabled ? 'enabled' : 'disabled'} for this server.`
        + (enabled
          ? ' GitHub/repo tools are now hidden here, and the default capability info (unless '
            + "you've saved your own) no longer mentions them. Your system prompt is untouched."
          : ''),
      ephemeral: true,
    });
    return;
  }

  if (sub === 'drives') {
    const drives = drivesMod.load(guild.id);
    drivesMod.save(guild.id, drives); // persist the tick (and any threshold crossing) this read found
    await interaction.reply({
      content: '**Her drives**\n'
        + `phase=${drives.phase}${drives.phaseChanged ? ` (just switched from ${drives.previousPhase})` : ''}\n`
        + `energy=${drives.energy.toFixed(2)} restlessness=${drives.restlessness.toFixed(2)} `
        + `boredom=${drives.boredom.toFixed(2)} social_pull=${drives.socialPull.toFixed(2)}\n`
        + `thresholds: sleep<=${drivesMod.THRESHOLDS.ENERGY_SLEEP_FLOOR} `
        + `wake>=${drivesMod.THRESHOLDS.ENERGY_WAKE_CEILING} `
        + `interrupt>=${drivesMod.THRESHOLDS.DRIVE_INTERRUPT} `
        + `social_satisfied<=${drivesMod.THRESHOLDS.SOCIAL_SATISFIED_FLOOR}`,
      ephemeral: true,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);

  if (group === 'cycle' && sub === 'force') {
    const phase = interaction.options.getString('phase', true);
    const drives = drivesMod.forcePhase(guild.id, phase);
    await interaction.reply({
      content: `Forced phase to **${drives.phase}**. Check /companion drives, or watch console `
        + 'logs once cycle.js is wired up, to see the effect.',
      ephemeral: true,
    });
    return;
  }

  if (group === 'room' && sub === 'add') {
    const name = interaction.options.getString('name', true);
    const phase = interaction.options.getString('phase', true);
    const voiceChannel = interaction.options.getChannel('voice_channel', true);
    const textChannel = interaction.options.getChannel('text_channel', false);
    if (!voiceChannel.permissionsFor(guild.members.me)?.has(['ViewChannel', 'Connect', 'Speak'])) {
      await interaction.reply({
        content: `I don't have View/Connect/Speak permission in ${voiceChannel}. Fix that first, or `
          + 'she won\'t be able to actually join it.',
        ephemeral: true,
      });
      return;
    }
    const id = db.addCompanionRoom(guild.id, {
      name, voiceChannelId: voiceChannel.id, textChannelId: textChannel?.id ?? null, phaseType: phase,
    });
    await interaction.reply({
      content: `Added room #${id} "${name}" (${phase}) — voice: ${voiceChannel}`
        + `${textChannel ? `, text: ${textChannel}` : ''}.`,
      ephemeral: true,
    });
    return;
  }

  if (group === 'room' && sub === 'list') {
    const rooms = db.listCompanionRooms(guild.id);
    if (!rooms.length) {
      await interaction.reply({ content: 'No rooms registered yet — use /companion room add.', ephemeral: true });
      return;
    }
    const lines = rooms.map((r) => `#${r.id} "${r.name}" (${r.phase_type}) — `
      + `voice: <#${r.voice_channel_id}>${r.text_channel_id ? `, text: <#${r.text_channel_id}>` : ''}`);
    await interaction.reply({ content: lines.join('\n').slice(0, 1990), ephemeral: true });
    return;
  }

  if (group === 'room' && sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    const removed = db.removeCompanionRoom(guild.id, id);
    await interaction.reply({
      content: removed ? `Removed room #${id}.` : `No room #${id} found for this server.`,
      ephemeral: true,
    });
  }
}
