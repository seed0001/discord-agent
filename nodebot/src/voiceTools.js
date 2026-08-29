// join_voice / leave_voice — letting anyone steer the bot's voice presence
// by asking, in text or by voice, instead of going to the dashboard.
//
// Open to everyone, like the calendar tools: pulling the bot in and out of a
// voice channel is low-stakes and easily undone, and the whole point is that
// it should not need an admin. voice_channel_allowlist still applies (the
// bot won't join a channel a server has ruled out), and voice monitoring has
// to be set up at all (a transcription key).
//
// Handlers take (client, message, args) with the same relaxed `message`
// contract the other tool modules use — .guild / .member are all that's
// touched — so voice.js's stand-in object works as well as a real Message.
import { available } from './transcription.js';

export class ToolError extends Error {}

// Indirection so tests don't have to smuggle a transcription key into the
// environment before config.js loads. Real call sites never touch it.
let availableFn = available;
export function _setAvailableForTests(fn) { availableFn = fn || available; }

function str(description) {
  return { type: 'string', description };
}

function schema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

/** Whether these tools should be offered at all — same gate as the rest of
 *  voice monitoring. */
export function enabled() {
  return availableFn();
}

// voice.js imports this file's siblings; reach for it lazily and swappably so
// there's no load-time cycle and tests can stand in a fake.
let voiceModule = null;
async function getVoice() {
  if (!voiceModule) voiceModule = await import('./voice.js');
  return voiceModule;
}
export function _setVoiceModuleForTests(mod) { voiceModule = mod; }

/** Find a voice channel by loose name ("General", "#gaming", "the music one"
 *  won't match — exact-ish only). Returns null when nothing clearly matches. */
function findVoiceChannel(guild, query) {
  const text = String(query || '').trim().replace(/^#/, '').toLowerCase();
  if (!text) return null;
  const voiceChannels = [...guild.channels.cache.values()]
    .filter((c) => c.type === 2 /* GuildVoice */ || c.type === 13 /* GuildStageVoice */);
  return voiceChannels.find((c) => c.name.toLowerCase() === text)
    || voiceChannels.filter((c) => c.name.toLowerCase().includes(text))[0]
    || null;
}

async function joinHandler(client, message, args) {
  if (!availableFn()) {
    throw new ToolError('voice monitoring is not set up on this server (no transcription key), '
      + 'so I can\'t join a voice channel.');
  }
  const { guild } = message;
  let target = null;
  if (args.channel) {
    target = findVoiceChannel(guild, args.channel);
    if (!target) throw new ToolError(`I couldn't find a voice channel called "${args.channel}".`);
  } else {
    target = message.member?.voice?.channel || null;
    if (!target) {
      throw new ToolError('hop into a voice channel first and I\'ll follow, or tell me which one to join.');
    }
  }
  const voice = await getVoice();
  const result = await voice.wakeGuild(guild, target);
  if (!result.joined) {
    if (result.reason === 'not-allowed') {
      throw new ToolError(`I'm not allowed to join **${target.name}** — it isn't on this server's `
        + 'list of allowed voice channels. An admin can change that on the dashboard.');
    }
    throw new ToolError(`I couldn't join **${target.name}** just now.`);
  }
  return `Joined **${result.channel}** — listening. Say a wake word to bring me into the conversation.`;
}

async function leaveHandler(client, message) {
  if (!availableFn()) return 'I\'m not in voice — voice monitoring isn\'t set up here.';
  const voice = await getVoice();
  const wasIn = Boolean(voice.currentVoiceChannel?.(message.guild));
  voice.sleepGuild(message.guild);
  return wasIn
    ? 'Left voice. I\'ll stay out until someone asks me back in ("join us in voice") or an admin '
      + 'brings me back from the dashboard.'
    : 'I wasn\'t in a voice channel, but noted — I\'ll stay out until asked back in.';
}

export const TOOLS = {
  join_voice: [schema('join_voice',
    'Join a voice channel and start listening. Use this whenever someone asks you (in text or by '
    + 'voice) to come into voice / hop in the call / join them. With no channel given you join the '
    + 'voice channel the asker is currently in. This also clears any earlier "stay out" state from '
    + 'a leave_voice or a "go to sleep".',
    { channel: str('Optional exact-ish name of the voice channel to join. Omit to join the channel the asker is in.') },
    []), joinHandler],
  leave_voice: [schema('leave_voice',
    'Leave the voice channel and stay out. Use this whenever someone asks you to leave voice / drop '
    + 'from the call / go quiet in voice. You will not auto-rejoin until someone asks you back in '
    + 'with join_voice (or an admin does it from the dashboard). This is NOT the same as ending a '
    + 'follow-up conversation — it disconnects you entirely.',
    {}, []), leaveHandler],
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(([s]) => s);

export function isVoiceTool(name) {
  return name in TOOLS;
}

/** Run one voice-control tool call and return its result string (never
 *  throws). */
export async function execute(client, message, name, args) {
  const entry = TOOLS[name];
  if (!entry) return `Error: unknown tool '${name}'.`;
  try {
    return await entry[1](client, message, args || {});
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    return `Error: ${name} failed (${err.message}).`;
  }
}
