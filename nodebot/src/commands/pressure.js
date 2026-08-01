// /pressure — owner-only visibility into (and toggle for) proactive speech.
// Ported from the pressure_cmd in bot/cogs/proactive.py.
import { SlashCommandBuilder } from 'discord.js';
import { requireOwner } from '../utils.js';
import { engineFor } from '../proactive.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('pressure')
  .setDescription('Show or toggle the proactive pressure system')
  .addBooleanOption((option) => option
    .setName('enabled')
    .setDescription('Turn proactive speech on or off'));

export async function execute(interaction) {
  if (!await requireOwner(interaction)) return;

  const enabled = interaction.options.getBoolean('enabled');
  if (enabled !== null) {
    db.setSetting(interaction.guild.id, 'pressure_enabled', enabled);
    await interaction.reply({
      content: `Proactive pressure ${enabled ? 'enabled' : 'disabled'}.`,
      ephemeral: true,
    });
    return;
  }

  const snap = engineFor(interaction.guild.id).snapshot(Date.now() / 1000);
  const pressures = Object.entries(snap.pressures)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ') || 'none';
  const signals = snap.activeSignals.slice(0, 10)
    .map((s) => `- ${s.source}(${s.topic}) ${s.strength.toFixed(2)}: ${(s.evidence || '').slice(0, 60)}`)
    .join('\n') || '(none)';
  const cooldowns = Object.entries(snap.cooldowns)
    .map(([k, v]) => `${k} ${Math.round(v)}s`).join(', ') || 'none';
  const on = db.getSetting(interaction.guild.id, 'pressure_enabled');

  await interaction.reply({
    content: `**Proactive pressure** (${on ? 'on' : 'off'})\n`
      + `Pressures: ${pressures}\nEnergy: ${Number(snap.energy ?? 0).toFixed(2)}\n`
      + `Cooldowns: ${cooldowns}\nActive signals:\n${signals}`.slice(0, 1990),
    ephemeral: true,
  });
}
