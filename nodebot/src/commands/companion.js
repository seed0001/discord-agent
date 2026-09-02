// /companion — owner-only debug/observability for the Private Companion
// relationship system. Same shape as /pressure: status + a small log view +
// a way to force a decision cycle for local testing, nothing that exposes
// this to a normal member.
import { SlashCommandBuilder } from 'discord.js';
import { requireOwner } from '../utils.js';
import * as db from '../db.js';
import * as stateMod from '../companion/state.js';
import * as events from '../companion/events.js';
import * as threadsMod from '../companion/threads.js';
import * as session from '../companion/session.js';
import * as scheduler from '../companion/scheduler.js';

export const data = new SlashCommandBuilder()
  .setName('companion')
  .setDescription('Private Companion system status and debug tools (owner only)')
  .addSubcommand((s) => s.setName('status').setDescription('Current relationship state and session status'))
  .addSubcommand((s) => s.setName('log').setDescription('Recent companion event log')
    .addIntegerOption((o) => o.setName('count').setDescription('How many events (default 15)')))
  .addSubcommand((s) => s.setName('test-invite').setDescription('Force a decision cycle now, bypassing cooldown'));

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
    const drive = stateMod.computeReachOutDrive(state);
    const openThreads = threadsMod.openThreads(guild.id, primaryUserId, 5)
      .map((t) => `- ${t.title} (importance ${t.importance.toFixed(2)})`).join('\n') || '(none)';
    const s = session.get(guild.id);

    await interaction.reply({
      content: '**Companion status**\n'
        + `Pressures: ${pressures}\n`
        + `absence=${absence}\n`
        + `reach_out_drive=${drive.drive.toFixed(2)} (threshold ${stateMod.DRIVE.INITIATE_THRESHOLD})\n`
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
  }
}
