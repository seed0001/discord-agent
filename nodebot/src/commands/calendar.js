// /calendar — reminders and scheduled tasks. list/add/cancel are open to
// everyone (calendar.execute enforces the owner-only bits — pinging other
// people, posting to another channel, editing someone else's reminder);
// `timezone` is owner-only because it changes how every reminder is read.
import { SlashCommandBuilder } from 'discord.js';
import { isOwner } from '../utils.js';
import * as calendar from '../calendar.js';
import * as db from '../db.js';

export const data = new SlashCommandBuilder()
  .setName('calendar')
  .setDescription('Reminders and scheduled tasks')
  .addSubcommand((s) => s
    .setName('list')
    .setDescription('Show upcoming reminders and scheduled tasks'))
  .addSubcommand((s) => s
    .setName('add')
    .setDescription('Schedule a reminder or recurring task')
    .addStringOption((o) => o.setName('title').setDescription('What to remind about').setRequired(true))
    .addStringOption((o) => o.setName('when')
      .setDescription('e.g. "+30m", "2h", "1d", or "2026-08-28 15:00"').setRequired(true))
    .addStringOption((o) => o.setName('recurrence').setDescription('How often it repeats')
      .addChoices(...calendar.RECURRENCES.map((r) => ({ name: r, value: r }))))
    .addStringOption((o) => o.setName('details').setDescription('Longer text posted with the reminder'))
    .addStringOption((o) => o.setName('notify')
      .setDescription('"me", or (owner only) a role / @everyone / @here'))
    .addChannelOption((o) => o.setName('channel')
      .setDescription('Channel to post in (owner only if not this one)')))
  .addSubcommand((s) => s
    .setName('cancel')
    .setDescription('Cancel a reminder by ID')
    .addIntegerOption((o) => o.setName('id').setDescription('Reminder ID (from /calendar list)').setRequired(true)))
  .addSubcommand((s) => s
    .setName('timezone')
    .setDescription('Show or set the timezone reminders are read in (owner only to set)')
    .addStringOption((o) => o.setName('tz')
      .setDescription('IANA name, e.g. America/Chicago, Europe/London')));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const owner = isOwner(interaction.user.id);
  const message = { guild: interaction.guild, channel: interaction.channel, author: interaction.user };

  if (sub === 'timezone') {
    const tz = interaction.options.getString('tz');
    if (!tz) {
      const current = db.getSetting(interaction.guild.id, 'calendar_timezone');
      await interaction.reply({ content: `Reminders are read in **${current}**.`, ephemeral: true });
      return;
    }
    if (!owner) {
      await interaction.reply({ content: 'Only the owner can change the timezone.', ephemeral: true });
      return;
    }
    if (!calendar.validTimezone(tz)) {
      await interaction.reply({
        content: `"${tz}" isn't a timezone I recognise. Use an IANA name like `
          + '`America/Chicago` or `Europe/London`.',
        ephemeral: true,
      });
      return;
    }
    db.setSetting(interaction.guild.id, 'calendar_timezone', tz);
    await interaction.reply({ content: `Timezone set to **${tz}**.`, ephemeral: true });
    return;
  }

  const nameBySub = { list: 'calendar_list', add: 'calendar_add', cancel: 'calendar_cancel' };
  const args = sub === 'add'
    ? {
      title: interaction.options.getString('title'),
      when: interaction.options.getString('when'),
      recurrence: interaction.options.getString('recurrence') || undefined,
      details: interaction.options.getString('details') || undefined,
      notify: interaction.options.getString('notify') || undefined,
      channel: interaction.options.getChannel('channel')?.id,
    }
    : sub === 'cancel'
      ? { id: interaction.options.getInteger('id') }
      : {};

  const result = await calendar.execute(message, nameBySub[sub], args, owner);
  await interaction.reply({ content: result.slice(0, 1990), ephemeral: true });
}
