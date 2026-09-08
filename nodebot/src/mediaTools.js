// Image and video generation, exposed to the AI as tools. media.js generates
// images; videomaker.js generates video natively — script, per-scene images
// and narration, FFmpeg assembly, all in this same process, all billed to
// the one OPENROUTER_API_KEY this deployment already has. This file decides
// who is allowed to spend money, how much of it, and what the model is told
// once the file is in the channel.
//
// Unlike agentTools, the gate here is a per-guild setting rather than a
// hardcoded owner check. Drawing a picture isn't a moderation action — it
// can't kick anyone or delete a channel, and the worst a stranger can do
// with it is run up a bill. That's a budget question, and budget is the
// server owner's call: a big server that wants images as a toy sets
// media_access to 'everyone', a small one leaves it owner-only, and either
// can switch the whole thing off with media_enabled. Baking owner-only in
// would make that decision for them and there'd be no way to say otherwise.
//
// Video then gets its own breaker on top, because "who may spend" and "how
// much may be spent" are separate problems. Generating one takes several
// sequential OpenRouter/TTS/ffmpeg steps, so the model retrying a
// failed-looking call — or one person asking four times because nothing
// appeared yet — burns real time and real money fast. The hourly cap is per
// guild and the slot is claimed when the job STARTS, so a retry loop burns
// through the cap instead of the budget.
//
// Handlers take (client, message, args) with the same relaxed `message`
// contract agentTools uses: only .guild/.channel/.author are touched, so
// voice.js's plain stand-in object works as well as a real Message.
import { GuildPremiumTier } from 'discord.js';
import * as db from './db.js';
import * as media from './media.js';
import * as videomaker from './videomaker.js';
import { isOwner } from './utils.js';

export class ToolError extends Error {}

function str(description) {
  return { type: 'string', description };
}

function int(description) {
  return { type: 'integer', description };
}

function schema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

// -- upload limits ------------------------------------------------------------

const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;

// Discord's per-attachment cap, which scales with the server's boost tier.
// Tier 1 buys no extra room over an unboosted server.
const UPLOAD_LIMITS = {
  [GuildPremiumTier.None]: 10 * MIB,
  [GuildPremiumTier.Tier1]: 10 * MIB,
  [GuildPremiumTier.Tier2]: 50 * MIB,
  [GuildPremiumTier.Tier3]: 100 * MIB,
};

/** Largest attachment this guild can accept. Assumes the unboosted limit
 * when premiumTier is missing or unrecognised — voice.js's stand-in guild
 * may not carry it, and guessing high would mean a doomed upload. Exported
 * for musicTools.js, which posts through the same Discord upload cap. */
export function uploadLimit(guild) {
  return UPLOAD_LIMITS[guild?.premiumTier] ?? UPLOAD_LIMITS[GuildPremiumTier.None];
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

/** File extension for a MIME type. Discord picks the preview treatment off
 * the filename, so a wrong extension shows as a download link instead of an
 * inline image. */
function extension(mediaType, fallback) {
  const type = String(mediaType || '').split(';')[0].trim().toLowerCase();
  if (EXTENSIONS[type]) return EXTENSIONS[type];
  const subtype = type.split('/')[1];
  return subtype ? subtype.replace(/[^a-z0-9]/g, '') || fallback : fallback;
}

/** What to tell the model when the result can't be uploaded. Worth being
 * explicit that nothing was posted — otherwise it cheerfully announces a
 * file the channel never received. Exported for musicTools.js. */
export function tooLarge(bytes, limit, advice) {
  return `Error: the result is ${Math.round(bytes / MIB)} MiB but this server can only accept `
    + `${Math.round(limit / MIB)} MiB attachments, so nothing was posted. Tell the user it came out `
    + `too big and offer to ${advice}.`;
}

/** Told to the model after a successful post. Without the "already posted"
 * framing it tends to reply with the prompt again, or promise to send a
 * file that is already sitting above its own message. Exported for
 * musicTools.js. */
export function postedNote(count, noun) {
  const subject = count === 1 ? `The ${noun} is` : `${count} ${noun}s are`;
  const object = count === 1 ? 'it' : 'them';
  return `${subject} ALREADY POSTED in the channel and the user can see ${object} now. `
    + 'Reply with one short line describing what you made — do not repeat the prompt back, '
    + 'and do not say you are about to send anything.';
}

// -- video spend breaker ------------------------------------------------------

/** guildId -> ascending ms timestamps of video jobs started in the last hour.
 * Exported only so tests can clear it between cases; nothing else reads it. */
export const _videoCalls = new Map();

/** Claim an hourly video slot for this guild, or throw. Called before the
 * job is submitted rather than after it succeeds — a failing job still cost
 * money and still burned minutes, and a model that retries on failure would
 * otherwise be uncapped. cap 0 means unlimited. Exported for direct testing
 * of the pure breaker logic, without needing a full video generation. */
export function takeVideoSlot(guildId, cap, now = Date.now()) {
  const cutoff = now - HOUR_MS;
  const recent = (_videoCalls.get(guildId) || []).filter((at) => at > cutoff);
  if (cap > 0 && recent.length >= cap) {
    const minutes = Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 60_000));
    _videoCalls.set(guildId, recent);
    throw new ToolError(
      `this server has already generated ${cap} video(s) in the last hour, which is its cap. `
      + `The next slot frees up in about ${minutes} minute(s) — tell the user to try again then.`,
    );
  }
  recent.push(now);
  _videoCalls.set(guildId, recent);
}

// -- handlers -----------------------------------------------------------------

async function generateImage(client, message, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new ToolError('generate_image needs a prompt.');

  const { images } = await media.generateImage(prompt, {
    // null/empty means "no per-guild override" — let media.js fall back to
    // the model configured in the environment.
    model: db.getSetting(message.guild.id, 'media_image_model') || undefined,
    aspectRatio: args.aspect_ratio,
    n: Math.max(1, Math.min(Number(args.n) || 1, media.IMAGE_MAX_N)),
  });

  const limit = uploadLimit(message.guild);
  const files = [];
  let dropped = 0;
  for (const [i, image] of images.entries()) {
    if (image.data.length > limit) {
      dropped += 1;
      continue;
    }
    files.push({
      attachment: image.data,
      name: `generated_${i + 1}.${extension(image.mediaType, 'png')}`,
    });
  }
  if (!files.length) {
    return tooLarge(images[0].data.length, limit, 'try a simpler prompt or a smaller aspect ratio');
  }

  await message.channel.send({ files });
  const note = postedNote(files.length, 'image');
  return dropped ? `${note} (${dropped} more were too large to upload and were skipped.)` : note;
}

const STAGE_LABELS = {
  script: 'Writing the script',
  images: 'Illustrating scenes',
  narration: 'Recording narration',
  assemble: 'Rendering the final video',
};

function videoStatusLine(info) {
  const label = STAGE_LABELS[info.stage] || info.stage;
  const pct = Math.round((info.progress || 0) * 100);
  const cost = info.costUsd ? ` — $${info.costUsd.toFixed(4)} so far` : '';
  return `Generating video: ${label} (${pct}%)${cost}`;
}

async function generateVideo(client, message, args) {
  const topic = String(args.topic || '').trim();
  if (!topic) throw new ToolError('generate_video needs a topic.');

  const guildId = message.guild.id;
  takeVideoSlot(guildId, Number(db.getSetting(guildId, 'media_video_hourly_cap')) || 0);

  // Several sequential steps means minutes of silence, which reads as a hung
  // bot — say something up front and keep it live-updated with
  // stage/progress/cost as they're reported, then clear it either way, so
  // the channel isn't left with a stale status line sitting above a
  // finished clip or a failure message.
  let notice = null;
  try {
    notice = await message.channel.send('Starting video: writing the script — this typically '
      + "takes a few minutes, I'll keep this updated.");
  } catch (err) {
    console.warn('[mediaTools] could not post the video notice:', err.message);
  }
  const updateNotice = async (info) => {
    if (!notice) return;
    try {
      await notice.edit(videoStatusLine(info));
    } catch (err) {
      console.warn('[mediaTools] could not update the video notice:', err.message);
    }
  };

  try {
    let clip;
    try {
      clip = await videomaker.createVideo(topic, {
        guildId,
        notes: args.notes,
        imageModel: db.getSetting(guildId, 'media_image_model') || undefined,
        onStatus: updateNotice,
      });
    } catch (err) {
      if (err instanceof videomaker.VideoMakerError) throw new ToolError(err.message);
      throw err;
    }

    const limit = uploadLimit(message.guild);
    if (clip.data.length > limit) {
      return tooLarge(clip.data.length, limit, 'ask for a shorter video — fewer scenes or less narration');
    }
    const title = String(clip.title || 'generated_video')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'generated_video';
    await message.channel.send({
      files: [{ attachment: clip.data, name: `${title}.${extension(clip.contentType, 'mp4')}` }],
    });
    const cost = clip.costUsd
      ? ` It cost $${clip.costUsd.toFixed(4)} to make (script + illustrations via OpenRouter — `
        + 'you may mention this if asked).'
      : '';
    return `${postedNote(1, 'video')}${cost}`;
  } finally {
    if (notice) {
      await notice.delete().catch(() => { /* already gone, or no permission */ });
    }
  }
}

// -- registry ---------------------------------------------------------------

const ASPECT_RATIO = str("Aspect ratio such as '1:1', '16:9', or '9:16' (optional; the model picks one otherwise)");

export const TOOLS = {
  generate_image: [schema('generate_image',
    'Generate an image and post it in the channel. Use this any time someone asks you to draw, '
    + 'make, design, create, render, or show a picture — art, a logo, a meme, a wallpaper, a '
    + 'character, a scene, anything visual. Write the prompt yourself rather than forwarding what '
    + 'the user typed: name the subject, the art style or medium, the composition, and the '
    + 'lighting or mood. A vague prompt produces a generic image, and the user only ever sees the '
    + 'result, not the prompt.',
    {
      prompt: str('The full image prompt: subject, style/medium, composition, lighting and mood, '
        + "written specifically and vividly. Not the user's wording verbatim."),
      aspect_ratio: ASPECT_RATIO,
      n: int(`How many variations to generate (1-${media.IMAGE_MAX_N}, default 1)`),
    }, ['prompt']), generateImage],
  generate_video: [schema('generate_video',
    'Generate a narrated video — a script written and read aloud over a sequence of illustrated '
    + 'scenes, assembled into one video — and post it in the channel. This takes a few minutes '
    + '(several sequential steps: script, illustrations, narration, assembly) and costs real money, '
    + 'so use it ONLY when someone actually asks for a video. Never generate one as a bonus '
    + 'alongside an image, and never to illustrate a point nobody asked to see as a video — if an '
    + 'image would answer the request, use generate_image instead. Give it a clear, specific topic; '
    + 'it writes its own script from that.',
    {
      topic: str('The video topic/subject, written specifically — this drives the whole script.'),
      notes: str('Optional extra guidance for the script: tone, style, facts to include, angle to '
        + "take. Leave blank unless the user actually said something beyond the topic itself."),
    }, ['topic']), generateVideo],
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(([s]) => s);

/** May this message's author generate media here? Off entirely when
 * media_enabled is false; open to the server when media_access is
 * 'everyone'; otherwise owner-only. ownerId is an injectable override for
 * testing (mirrors isOwner) — real call sites never pass it. */
export async function allowed(message, ownerId) {
  if (!db.getSetting(message.guild.id, 'media_enabled')) return false;
  if (db.getSetting(message.guild.id, 'media_access') === 'everyone') return true;
  return isOwner(message.author.id, ownerId);
}

/** Run one media tool call and return its result string (never throws).
 * Re-checks allowed() rather than trusting the caller to have filtered the
 * schemas it offered — same defence in depth as agentTools.execute, and the
 * thing standing between a prompt-injected tool call and a real bill. */
export async function execute(client, message, name, args, ownerId) {
  if (!(await allowed(message, ownerId))) {
    return 'Error: image and video generation is disabled in this server, or limited to the bot owner.';
  }
  const entry = TOOLS[name];
  if (!entry) return `Error: unknown tool '${name}'.`;
  try {
    return await entry[1](client, message, args || {});
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    if (err instanceof media.MediaError) return `Error: ${err.message}`;
    if (err.code === 50013 || err.status === 403) {
      return "Error: I don't have permission to attach files in this channel.";
    }
    if (err.code === 40005) return 'Error: Discord rejected the upload as too large.';
    if (err.name === 'DiscordAPIError') return `Error: Discord API error: ${err.message}`;
    return `Error: media generation failed (${err.message}).`;
  }
}
