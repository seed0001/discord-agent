import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { DISCORD_TOKEN, DATABASE_PATH, SECRET_KEY } from './config.js';
import { reportPreflight } from './preflight.js';
import { loadCommands } from './load-commands.js';
import { handleMessage } from './textChat.js';
import * as voice from './voice.js';
import * as automod from './automod.js';
import * as antispam from './antispam.js';
import * as welcome from './welcome.js';
import * as gatekeeping from './gatekeeping.js';
import * as memory from './memory.js';
import * as proactive from './proactive.js';
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
  ],
  partials: [Partials.Channel],
});
client.commands = await loadCommands();

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id}) — ${c.guilds.cache.size} guild(s)`);
  voice.init(c);
  // Pressure decay/flow runs on its own clock, independent of message traffic.
  proactive.startTicker(c);
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
  if (interaction.isButton()) {
    try {
      await gatekeeping.handleVettingButton(interaction);
    } catch (err) {
      console.error('vetting button failed:', err);
    }
    return;
  }
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
  try {
    await gatekeeping.handleLobbyText(client, message);
  } catch (err) {
    console.error('gatekeeping (lobby text) failed:', err);
  }
  // Observation and signal classification for proactive speech. Runs for
  // every message including Max's own (which are observed but never charge
  // pressure), independently of whether the AI replied.
  try {
    await proactive.handleMessage(client, message);
  } catch (err) {
    console.error('proactive observation failed:', err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await welcome.handleMemberAdd(member);
  } catch (err) {
    console.error('welcome (member add) failed:', err);
  }
  try {
    await gatekeeping.handleMemberAdd(member);
  } catch (err) {
    console.error('gatekeeping (member add) failed:', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await welcome.handleMemberRemove(member);
  } catch (err) {
    console.error('welcome (member remove) failed:', err);
  }
});

client.on(Events.VoiceStateUpdate, voice.handleVoiceStateUpdate);
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    gatekeeping.handleVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('gatekeeping (voice state) failed:', err);
  }
});

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

client.login(DISCORD_TOKEN);
