import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { DISCORD_TOKEN, DATABASE_PATH, SECRET_KEY } from './config.js';
import { reportPreflight } from './preflight.js';
import { loadCommands } from './load-commands.js';
import { handleMessage } from './textChat.js';
import * as voice from './voice.js';
import * as automod from './automod.js';
import * as antispam from './antispam.js';
import * as welcome from './welcome.js';
import * as memory from './memory.js';
import * as proactive from './proactive.js';
import * as calendar from './calendar.js';
import * as companionSession from './companion/session.js';
import * as companionScheduler from './companion/scheduler.js';
import * as companionAutonomous from './companion/autonomous.js';
import * as logbuffer from './logbuffer.js';
import { startDashboard, applyPresence } from './web/server.js';
import * as backendCatalog from './backends/catalog.js';
import * as backendSwitching from './backends/switching.js';
import * as db from './db.js';

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required (see .env.example)');
  process.exit(1);
}

// Tee console output into the ring buffer the dashboard reads. Installed
// before anything else logs so startup lines are captured too.
logbuffer.install();

// Says where the database actually is, and shouts if it is somewhere that
// will not survive a deploy. Runs after logbuffer.install() so the warnings
// show up in the dashboard's Logs tab too, not just Railway's.
reportPreflight({ databasePath: DATABASE_PATH, secretKey: SECRET_KEY });

try {
  db.initDb(DATABASE_PATH);
} catch (err) {
  // Refusing to start is deliberate. The alternative — coming up against the
  // wrong database and mangling ids as it goes — is far harder to notice and
  // far harder to undo than a crash with instructions in it.
  console.error(err.message);
  process.exit(1);
}
process.on('exit', () => db.closeDb());

// Replay anything said but never folded into memory before the last
// shutdown — a redeploy landing mid-conversation would otherwise lose it.
memory.restorePendingTurns();

// GuildMembers is a privileged intent — must also be enabled in the
// Discord Developer Portal (Bot tab → Privileged Gateway Intents), same
// as the Python bot requires.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    // Not privileged (unlike the three above) — no Developer Portal change
    // needed. Without this the gateway never delivers a DM MessageCreate at
    // all, which both the invite DM and companion/session.js's
    // handleDirectMessage (reciprocity detection) depend on.
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});
client.commands = await loadCommands();

// Discord.js's guild member cache only ever holds who it has incidentally
// seen (message authors, join/leave events) unless something explicitly
// asks for the rest — GUILD_CREATE does NOT include the full member list.
// A long-running bot slowly fills this in through ordinary activity, which
// masks the gap; a freshly (re)joined guild starts with essentially just
// the bot itself cached, which silently emptied the dashboard's member
// list (and with it, e.g. the Companion tab's Primary Companion User
// dropdown). GuildMembers is already a granted privileged intent, so this
// is just actually using it.
async function primeMemberCache(guild) {
  try {
    await guild.members.fetch();
  } catch (err) {
    console.warn(`[members] full fetch failed for guild ${guild.id}:`, err.message);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id}) — ${c.guilds.cache.size} guild(s)`);
  for (const guild of c.guilds.cache.values()) primeMemberCache(guild);
  voice.init(c);
  // Pressure decay/flow runs on its own clock, independent of message traffic.
  proactive.startTicker(c);
  // Calendar/reminder scheduler — polls for due events and posts them.
  calendar.startTicker(c);
  // Private Companion relationship system — no-op for every guild that
  // hasn't turned on Companion Mode (see db.DEFAULTS.companion_enabled).
  companionScheduler.startTicker(c);
  companionAutonomous.startTicker(c);
  applyPresence(c);
  startDashboard(c);
  // Keep the list of available OpenRouter models fresh, so there is something
  // to reroute to the moment a backend starts refusing rather than an hour
  // after. Fetches once now if the cache is empty; hourly after that. Each
  // refresh is followed by a check that the models she is actually pointed at
  // are still ones that can answer — a rotation made before the catalog knew
  // better could have left her on something that only ever returns 502.
  backendCatalog.startRefreshing({ afterRefresh: () => backendSwitching.evictUnusable() });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`command ${interaction.commandName} failed:`, err);
    const reply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

client.on(Events.MessageCreate, async (message) => {
  // Both run independently for every message, same as the Python bot's
  // separate AutoMod/AI cogs both getting on_message — automod deleting
  // the message doesn't stop the AI side from having already seen it.
  try {
    await automod.checkMessage(message);
  } catch (err) {
    console.error('automod check failed:', err);
  }
  try {
    await antispam.checkMessage(message);
  } catch (err) {
    console.error('antispam check failed:', err);
  }
  try {
    await handleMessage(client, message);
  } catch (err) {
    console.error('message handling failed:', err);
  }
  // Observation and signal classification for proactive speech. Runs for
  // every message including Max's own (which are observed but never charge
  // pressure), independently of whether the AI replied.
  try {
    await proactive.handleMessage(client, message);
  } catch (err) {
    console.error('proactive observation failed:', err);
  }
  // Companion reciprocity signal only — DMs aren't otherwise processed at
  // all (handleMessage above bails on !message.guild), and this stays that
  // way: it detects that the primary companion user replied/started a DM,
  // it does not hold a text conversation over DM.
  if (!message.guild) {
    try {
      companionSession.handleDirectMessage(client, message);
    } catch (err) {
      console.error('companion DM detection failed:', err);
    }
  }
});

// Fires when the bot is added (or re-added) to a guild while already
// running — the ClientReady sweep above only covers guilds it was already
// in at startup. Same member-cache gap, same fix.
client.on(Events.GuildCreate, (guild) => primeMemberCache(guild));

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await welcome.handleMemberAdd(member);
  } catch (err) {
    console.error('welcome (member add) failed:', err);
  }
  // Separate try: a join is the clearest raid tell there is, and the sentinel
  // must still see it even if the welcome message failed to send.
  try {
    await automod.checkMemberJoin(member);
  } catch (err) {
    console.error('sentinel (member add) failed:', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await welcome.handleMemberRemove(member);
  } catch (err) {
    console.error('welcome (member remove) failed:', err);
  }
});

// Companion's listener MUST run before voice.js's own: on a leave, it needs
// to call voice.beginGraceHold synchronously before voice.js's rebalance
// (triggered by this same event) gets a chance to tear the connection down.
// rebalance() has no await before its empty-channel leaveGuild() call, so
// whichever listener runs first wins the race outright — this isn't a
// preference, it's the only ordering that works. Harmless for every other
// guild/event: this listener guard-clauses out immediately unless it's the
// primary companion user leaving the configured room.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Separate listener, own try/catch: detects the primary companion user
  // joining/leaving the configured Private Companion Room. No-op for every
  // guild without Companion Mode on (session.js checks first).
  try {
    companionSession.handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('companion voice state handling failed:', err);
  }
});
client.on(Events.VoiceStateUpdate, voice.handleVoiceStateUpdate);

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

client.login(DISCORD_TOKEN);
