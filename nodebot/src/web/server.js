// Dashboard HTTP server — the Node port of web/app.py, web/auth.py and
// web/api.py. The static frontend (static/app.js, index.html, style.css) is
// carried over unchanged from the Python bot, so every route below keeps the
// exact request/response shape it expects.
//
// Built on node:http rather than a framework: the API is ~30 small routes and
// pulling in Express would add a dependency tree for a router and a body
// parser, both of which are a few lines here.
//
// web/internal.py is deliberately NOT ported. It existed so the Node listener
// sidecar could reach the Python bot over HTTP; voice runs in this process
// now, so that bridge has nothing left to bridge.
//
// All Discord snowflake IDs are serialized as strings — they exceed
// JavaScript's safe integer range.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ChannelType, ActivityType, PermissionsBitField } from 'discord.js';
import { BUILD_ID, PORT, OWNER_ID, FISH_API_KEY } from '../config.js';
import {
  checkPassword, createToken, sessionOf, parseCookies,
  createState, verifyState, TOKEN_TTL,
} from './auth.js';
import { LEVELS, levelAtLeast, resolveLevel, memberFacts } from './roles.js';
import { HttpError } from './httpError.js';
import { platformRoutes, resolvePlatformSession } from '../platform/routes.js';
import {
  oauthConfigured, authorizeUrl, exchangeCode, fetchDiscordUser,
} from './oauth.js';
import { chat, OpenRouterError } from '../openrouter.js';
import * as credits from '../credits/index.js';
import { PHRASE_LIST_KEYS, parsePhraseList } from '../phrases.js';
import { botName } from '../botName.js';
import { logAction } from '../utils.js';
import * as logbuffer from '../logbuffer.js';
import * as voice from '../voice.js';
import * as memory from '../memory.js';
import * as db from '../db.js';
import { ttsSettingsMeta } from '../ttsConfig.js';

const OPTIONAL_STRING_SETTINGS = new Set([
  'bot_name', 'fish_voice_id', 'fish_tts_model', 'edge_tts_voice',
]);
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
// The showcase site at the repo root, served read-only under /site. It is a
// marketing page with no backend — resolved relative to this file rather than
// cwd, so it works whether the process is started from the repo root or here.
const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../site');
const DASHBOARD_ACTOR = 'Dashboard';

/* Short URLs for the two pages Discord requires in the application's settings.
   Both spellings are served so a link written either way keeps working — these
   end up pasted into places nobody will revisit. */
const LEGAL_PAGES = {
  '/privacy': 'privacy.html',
  '/privacy-policy': 'privacy.html',
  '/terms': 'terms.html',
  '/tos': 'terms.html',
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

// -- serialization -----------------------------------------------------------

const serializeMember = (m) => ({
  id: String(m.id),
  name: m.user.username,
  display_name: m.displayName,
  avatar: m.displayAvatarURL(),
  bot: m.user.bot,
  joined_at: m.joinedTimestamp ? Math.floor(m.joinedTimestamp / 1000) : null,
  roles: m.roles.cache.filter((r) => r.id !== m.guild.id).map((r) => String(r.id)),
  timed_out: Boolean(m.communicationDisabledUntilTimestamp
    && m.communicationDisabledUntilTimestamp > Date.now()),
});

const CHANNEL_TYPE_NAMES = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'news',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildStageVoice]: 'stage',
};

const serializeChannel = (c) => ({
  id: String(c.id),
  name: c.name,
  type: CHANNEL_TYPE_NAMES[c.type] || String(c.type),
  position: c.position,
  category: c.parent ? c.parent.name : null,
});

const serializeRole = (r) => ({
  id: String(r.id),
  name: r.name,
  color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
  position: r.position,
  members: r.members.size,
  managed: r.managed,
});

// -- request plumbing --------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

// A dashboard request has no business being large; refuse rather than buffer.
const MAX_BODY_BYTES = 1_000_000;
// Once refused, the rest is drained so the client still gets its 413 — but a
// client that keeps sending regardless gets the socket dropped rather than an
// unbounded free ride.
const MAX_DRAIN_BYTES = 8 * MAX_BODY_BYTES;

async function readBody(req) {
  let chunks = [];
  let size = 0;
  let oversize = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (!oversize && size > MAX_BODY_BYTES) {
      // Throwing straight out of `for await` destroys the request stream, and
      // with it the socket the 413 is still being written to — fetch() sees a
      // hung or aborted request with no status at all. So stop accumulating,
      // drop what was buffered, and keep reading without retaining anything:
      // memory stays flat however much more arrives, and the response gets a
      // live socket to go out on.
      oversize = true;
      chunks = [];
    }
    if (oversize) {
      if (size > MAX_DRAIN_BYTES) break;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversize) throw new HttpError(413, 'Request body too large');
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function getGuild(client, guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) throw new HttpError(404, 'Guild not found');
  return guild;
}

function getMember(guild, userId) {
  const member = guild.members.cache.get(String(userId));
  if (!member) throw new HttpError(404, 'Member not found');
  return member;
}

/**
 * What dashboard access a Discord user gets IN ONE SPECIFIC GUILD, read from
 * that server itself.
 *
 * The roles come from the bot's own gateway connection, never from anything
 * the browser sent — the OAuth flow establishes *who* someone is, and this
 * decides what that's worth in this particular server. This bot instance
 * runs many servers at once (unlike roles.js's own single-server framing),
 * so this is deliberately NOT cached on the session — every request to a
 * guild-scoped route re-derives the level from that guild's live roles, so
 * being a moderator in one server never bleeds into another.
 */
async function levelForUserInGuild(guild, userId) {
  if (OWNER_ID && String(userId) === String(OWNER_ID)) return 'creator';
  let member = guild.members.cache.get(String(userId));
  if (!member) {
    try {
      member = await guild.members.fetch(String(userId));
    } catch {
      return 'none'; // not a member of this guild
    }
  }
  return resolveLevel({
    ...memberFacts(member, PermissionsBitField),
    ownerId: OWNER_ID,
    adminRoles: db.getSetting(guild.id, 'dashboard_admin_roles') || [],
    modRoles: db.getSetting(guild.id, 'dashboard_mod_roles') || [],
  });
}

/**
 * The BEST access a Discord user has anywhere this instance runs, checked
 * once at login time to decide whether they get a dashboard session at all.
 * Deliberately not trusted for anything past that: see levelForUserInGuild,
 * which every guild-scoped request re-checks instead.
 */
async function levelForUser(client, userId) {
  if (OWNER_ID && String(userId) === String(OWNER_ID)) return 'creator';
  let best = 'none';
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop
    const level = await levelForUserInGuild(guild, userId);
    if (LEVELS[level] > LEVELS[best]) best = level;
  }
  return best;
}

// -- routes ------------------------------------------------------------------

// Each entry: [method, pattern, handler, { open }]. `:name` captures a segment.
// Everything is auth-protected unless explicitly marked open, so a new route
// cannot accidentally be added unauthenticated.
function buildRoutes(client) {
  return [
    // The customer-facing platform — accounts, orders, credits. Declares its
    // own auth (`account: 'any' | 'staff'`), which the dispatcher below
    // enforces separately from the Discord dashboard's access levels.
    ...platformRoutes(),

    // The password is the instance owner's way in, and stays creator-level.
    // It is also the break-glass path: if Discord OAuth is misconfigured, or
    // the role mapping locks everyone out, this still works.
    ['POST', '/api/login', async ({ body, res }) => {
      if (!checkPassword(body.password)) throw new HttpError(401, 'Wrong password');
      sendJson(res, 200, { ok: true, level: 'creator' }, {
        'Set-Cookie': `session=${createToken('creator', OWNER_ID)}; Max-Age=${TOKEN_TTL}; Path=/; `
          + 'HttpOnly; SameSite=Lax; Secure',
      });
    }, { open: true }],

    ['POST', '/api/logout', async ({ res }) => {
      sendJson(res, 200, { ok: true }, {
        'Set-Cookie': 'session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
      });
    }, { open: true }],

    // -- Sign in with Discord --------------------------------------------
    // Kick off the flow. The signed `state` proves the callback belongs to a
    // login this dashboard started, rather than one someone else initiated.
    ['GET', '/api/auth/discord', async ({ req, res }) => {
      if (!oauthConfigured()) throw new HttpError(503, 'Discord login is not configured');
      const state = createState();
      res.writeHead(302, {
        Location: authorizeUrl(req, state),
        'Set-Cookie': `oauth_state=${state}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax; Secure`,
      });
      res.end();
    }, { open: true }],

    // Come back from Discord: verify state, learn who they are, then read
    // their level from THIS server's roles via the bot's own connection —
    // never from anything the browser supplied.
    ['GET', '/api/auth/callback', async ({ query, req, res }) => {
      const fail = (reason) => {
        console.warn(`[web] Discord login rejected: ${reason}`);
        res.writeHead(302, { Location: `/?login_error=${encodeURIComponent(reason)}` });
        res.end();
      };
      if (!oauthConfigured()) return fail('Discord login is not configured');
      if (!query.code) return fail(query.error_description || 'Discord returned no code');
      if (!verifyState(query.state)
          || parseCookies(req.headers.cookie).oauth_state !== query.state) {
        return fail('Login session expired — try again');
      }
      let user;
      try {
        user = await fetchDiscordUser(await exchangeCode(query.code, req));
      } catch (err) {
        return fail(err.message);
      }

      const level = await levelForUser(client, user.id);
      if (level === 'none') {
        return fail(`${user.username} has no dashboard access in this server`);
      }
      console.log(`[web] ${user.username} (${user.id}) signed in as ${level}`);
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          `session=${createToken(level, user.id)}; Max-Age=${TOKEN_TTL}; Path=/; HttpOnly; SameSite=Lax; Secure`,
          'oauth_state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure',
        ],
      });
      res.end();
    }, { open: true }],

    // What the browser needs before login: whether to offer the Discord button.
    ['GET', '/api/auth/config', async () => ({
      discord: oauthConfigured(),
    }), { open: true }],

    ['GET', '/api/me', async ({ session }) => {
      if (!client.isReady()) return { ready: false, level: session?.level || 'none' };
      return {
        ready: true,
        level: session?.level || 'none',
        user_id: session?.userId || '',
        id: String(client.user.id),
        name: client.user.username,
        avatar: client.user.displayAvatarURL(),
        guild_count: client.guilds.cache.size,
        latency_ms: Math.round(client.ws.ping),
        build: BUILD_ID,
        presence: {
          status: db.getSetting('0', 'presence_status'),
          activity_type: db.getSetting('0', 'presence_activity_type'),
          text: db.getSetting('0', 'presence_text'),
        },
      };
    }, { level: 'moderator' }],

    ['POST', '/api/presence', async ({ body }) => {
      db.setSetting('0', 'presence_status', body.status || 'online');
      db.setSetting('0', 'presence_activity_type', body.activity_type || 'playing');
      db.setSetting('0', 'presence_text', body.text || '');
      applyPresence(client);
      return { ok: true };
    }, { level: 'creator' }],

    ['GET', '/api/guilds', async ({ session }) => {
      // Creator sees every server this instance runs (that's the instance
      // owner's job); anyone else only sees servers they actually have
      // dashboard access in — otherwise this list alone would leak the name,
      // icon, and member count of every server the bot is installed in to
      // any moderator signed in from anywhere.
      let guilds = [...client.guilds.cache.values()];
      if (session.level !== 'creator') {
        const checked = await Promise.all(
          guilds.map(async (g) => [g, await levelForUserInGuild(g, session.userId)]),
        );
        guilds = checked.filter(([, level]) => levelAtLeast(level, 'moderator')).map(([g]) => g);
      }
      return guilds.map((g) => ({
        id: String(g.id),
        name: g.name,
        icon: g.iconURL(),
        member_count: g.memberCount,
      }));
    }, { level: 'moderator' }],

    ['GET', '/api/guilds/:guildId', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      const bots = g.members.cache.filter((m) => m.user.bot).size;
      return {
        id: String(g.id),
        name: g.name,
        icon: g.iconURL(),
        owner: g.ownerId ? String(g.ownerId) : null,
        member_count: g.memberCount,
        humans: (g.memberCount || 0) - bots,
        bots,
        channels: g.channels.cache.size,
        roles: g.roles.cache.size,
        boost_level: g.premiumTier,
        created_at: Math.floor(g.createdTimestamp / 1000),
        quiet_mode: Boolean(db.getSetting(g.id, 'quiet_mode')),
      };
    }, { level: 'moderator' }],

    ['POST', '/api/guilds/:guildId/quiet', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      const on = Boolean(body.on);
      db.setSetting(g.id, 'quiet_mode', on);
      // Muting takes effect immediately: leave voice rather than waiting for
      // the next sweep to notice the setting changed.
      if (on) {
        try {
          voice.leaveRequestedGuild(g);
        } catch { /* not in voice — the setting still mutes everything */ }
      }
      await logAction(g, 'quiet_mode', DASHBOARD_ACTOR, null,
        on ? 'muted (podcast mode)' : 'unmuted');
      return { ok: true, quiet_mode: on };
    }, { level: 'moderator' }],

    ['GET', '/api/guilds/:guildId/soundboard', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      // Populated over the gateway, but not always before the first dashboard
      // load — fetch when the cache is cold. A guild with no soundboard, or a
      // gateway that never sent one, is an empty list rather than an error:
      // the settings page must still render.
      let sounds = [...(g.soundboardSounds?.cache?.values?.() || [])];
      if (!sounds.length && g.soundboardSounds?.fetch) {
        try {
          const fetched = await g.soundboardSounds.fetch();
          sounds = [...(fetched?.values?.() || [])];
        } catch (err) {
          console.warn(`[web] soundboard fetch failed for ${g.id}: ${err.message}`);
          return [];
        }
      }
      return sounds.map((s) => ({
        id: String(s.soundId ?? s.id),
        name: s.name,
        emoji: s.emojiName || null,
        available: s.available !== false,
      }));
    }, { level: 'admin' }],

    ['GET', '/api/guilds/:guildId/settings', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      return {
        ...db.getAllSettings(g.id),
        // Read-only companions to the stored `bot_name`, so the dashboard can
        // show what the bot is ACTUALLY called right now (and where that came
        // from) while leaving the field itself blank for "follow Discord".
        bot_name_effective: botName(client, g.id),
        bot_name_source: db.getSetting(g.id, 'bot_name') ? 'override' : 'discord',
        fish_api_configured: Boolean(FISH_API_KEY),
        ...ttsSettingsMeta(g.id),
      };
    }, { level: 'moderator' }],

    ['PUT', '/api/guilds/:guildId/settings', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      for (const [key, value] of Object.entries(body)) {
        // The two read-only fields the GET above adds back. Ignore them rather
        // than 400, so a client that round-trips the whole settings object
        // still saves cleanly.
        if (key === 'bot_name_effective' || key === 'bot_name_source') continue;
        if (key === 'fish_api_configured'
          || key.startsWith('fish_voice_id_')
          || key.startsWith('fish_tts_model_')
          || key.startsWith('edge_tts_voice_')) continue;
        if (!(key in db.DEFAULTS)) throw new HttpError(400, `Unknown setting: ${key}`);
        if (OPTIONAL_STRING_SETTINGS.has(key)) {
          const text = typeof value === 'string' ? value.trim() : '';
          db.setSetting(g.id, key, text || null);
          continue;
        }
        // Phrase lists arrive from the dashboard as raw bracket text
        // ("[hey max] [hey andrew]") and from the API as an array. Both are
        // parsed to a clean, normalized array before storage, so what is
        // saved is exactly what the matcher will compare against.
        db.setSetting(g.id, key, PHRASE_LIST_KEYS.has(key) ? parsePhraseList(value) : value);
      }
      return { ok: true };
    }, { level: 'admin' }],

    ['POST', '/api/guilds/:guildId/ai/enhance', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      const prompt = ENHANCE_PROMPTS[body.kind];
      if (!prompt) throw new HttpError(400, 'Unknown kind');
      if (!String(body.text || '').trim()) throw new HttpError(400, 'Nothing to enhance');
      try {
        const result = await chat([
          { role: 'system', content: prompt },
          { role: 'user', content: body.text },
        ], {
          model: db.getSetting(g.id, 'ai_model'),
          maxTokens: 600,
          temperature: 0.8,
          guildId: g.id,
        });
        return { text: result.trim() };
      } catch (err) {
        if (err instanceof credits.InsufficientCreditsError) {
          throw new HttpError(402, 'Out of credits — top the balance up to use this.');
        }
        if (err instanceof OpenRouterError) throw new HttpError(502, err.message);
        throw err;
      }
    }, { level: 'admin' }],

    ['GET', '/api/guilds/:guildId/members', async ({ params, query }) => {
      const g = getGuild(client, params.guildId);
      const search = String(query.search || '').toLowerCase();
      const offset = parseInt(query.offset, 10) || 0;
      const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 50, 100));
      let members = [...g.members.cache.values()]
        .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
      if (search) {
        members = members.filter((m) => m.user.username.toLowerCase().includes(search)
          || m.displayName.toLowerCase().includes(search)
          || String(m.id) === search);
      }
      return {
        total: members.length,
        members: members.slice(offset, offset + limit).map(serializeMember),
      };
    }, { level: 'moderator' }],

    ['POST', '/api/guilds/:guildId/members/:userId/action', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      const { userId } = params;
      const reason = body.reason || null;

      if (body.action === 'unban') {
        await g.bans.remove(userId, reason ?? undefined);
        await logAction(g, 'unban', DASHBOARD_ACTOR, userId, reason);
        return { ok: true };
      }
      if (body.action === 'ban') {
        // Allow banning users who are no longer members.
        await g.bans.create(userId, { reason: reason ?? undefined });
        await logAction(g, 'ban', DASHBOARD_ACTOR, userId, reason);
        return { ok: true };
      }

      const member = getMember(g, userId);
      if (body.action === 'kick') {
        await member.kick(reason ?? undefined);
        await logAction(g, 'kick', DASHBOARD_ACTOR, member, reason);
      } else if (body.action === 'timeout') {
        const minutes = Math.max(1, Math.min(parseInt(body.minutes, 10) || 10, 40320));
        await member.timeout(minutes * 60_000, reason ?? undefined);
        await logAction(g, 'timeout', DASHBOARD_ACTOR, member,
          `${reason || 'No reason'} (${minutes}m)`);
      } else if (body.action === 'untimeout') {
        await member.timeout(null);
        await logAction(g, 'untimeout', DASHBOARD_ACTOR, member, null);
      } else if (body.action === 'warn') {
        db.addWarning(g.id, member.id, '0', reason);
        await logAction(g, 'warn', DASHBOARD_ACTOR, member, reason);
      } else {
        throw new HttpError(400, 'Unknown action');
      }
      return { ok: true };
    }, { level: 'moderator' }],

    ['POST', '/api/guilds/:guildId/members/:userId/roles', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      const member = getMember(g, params.userId);
      if (body.add?.length) await member.roles.add(body.add.map(String));
      if (body.remove?.length) await member.roles.remove(body.remove.map(String));
      await logAction(g, 'role_update', DASHBOARD_ACTOR, member,
        `+${body.add?.length || 0} -${body.remove?.length || 0}`);
      return { ok: true };
    }, { level: 'moderator' }],

    ['GET', '/api/guilds/:guildId/channels', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      return [...g.channels.cache.values()]
        .sort((a, b) => ((a.parent?.position ?? -1) - (b.parent?.position ?? -1))
          || (a.position - b.position))
        .map(serializeChannel);
    }, { level: 'moderator' }],

    ['POST', '/api/guilds/:guildId/channels', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      const types = {
        voice: ChannelType.GuildVoice,
        category: ChannelType.GuildCategory,
        forum: ChannelType.GuildForum,
        text: ChannelType.GuildText,
      };
      const channel = await g.channels.create({
        name: body.name,
        type: types[body.type] ?? ChannelType.GuildText,
      });
      await logAction(g, 'channel_create', DASHBOARD_ACTOR, channel.name, body.type);
      return serializeChannel(channel);
    }, { level: 'admin' }],

    ['DELETE', '/api/guilds/:guildId/channels/:channelId', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      const channel = g.channels.cache.get(String(params.channelId));
      if (!channel) throw new HttpError(404, 'Channel not found');
      const { name } = channel;
      await channel.delete();
      await logAction(g, 'channel_delete', DASHBOARD_ACTOR, name, null);
      return { ok: true };
    }, { level: 'admin' }],

    ['POST', '/api/guilds/:guildId/channels/:channelId/messages', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      const channel = g.channels.cache.get(String(params.channelId));
      if (!channel || !channel.isTextBased()) throw new HttpError(404, 'Text channel not found');
      if (!String(body.content || '').trim()) throw new HttpError(400, 'Message is empty');
      const message = await channel.send(String(body.content).slice(0, 2000));
      return { ok: true, message_id: String(message.id) };
    }, { level: 'admin' }],

    ['GET', '/api/guilds/:guildId/roles', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      return [...g.roles.cache.values()]
        .filter((r) => r.id !== g.id) // @everyone
        .sort((a, b) => b.position - a.position)
        .map(serializeRole);
    }, { level: 'moderator' }],

    ['POST', '/api/guilds/:guildId/roles', async ({ params, body }) => {
      const g = getGuild(client, params.guildId);
      let color = 0;
      if (body.color) {
        color = parseInt(String(body.color).replace(/^#/, ''), 16);
        if (!Number.isFinite(color)) throw new HttpError(400, 'Invalid hex color');
      }
      const role = await g.roles.create({ name: body.name, color });
      await logAction(g, 'role_create', DASHBOARD_ACTOR, role.name, null);
      return serializeRole(role);
    }, { level: 'admin' }],

    ['DELETE', '/api/guilds/:guildId/roles/:roleId', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      const role = g.roles.cache.get(String(params.roleId));
      if (!role) throw new HttpError(404, 'Role not found');
      const { name } = role;
      await role.delete();
      await logAction(g, 'role_delete', DASHBOARD_ACTOR, name, null);
      return { ok: true };
    }, { level: 'admin' }],

    ['GET', '/api/guilds/:guildId/warnings', async ({ params, query }) => {
      const g = getGuild(client, params.guildId);
      const rows = db.getWarnings(g.id, query.user_id || null);
      return rows.map((row) => {
        const member = g.members.cache.get(String(row.user_id));
        const mod = g.members.cache.get(String(row.moderator_id));
        return {
          ...row,
          user_id: String(row.user_id),
          moderator_id: String(row.moderator_id),
          user_name: member ? member.user.tag : String(row.user_id),
          moderator_name: mod ? mod.user.tag
            : (String(row.moderator_id) === '0' ? DASHBOARD_ACTOR : String(row.moderator_id)),
        };
      });
    }, { level: 'moderator' }],

    ['DELETE', '/api/guilds/:guildId/warnings/:warningId', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      if (!db.deleteWarning(g.id, parseInt(params.warningId, 10))) {
        throw new HttpError(404, 'Warning not found');
      }
      return { ok: true };
    }, { level: 'moderator' }],

    ['GET', '/api/guilds/:guildId/logs', async ({ params, query }) => {
      const g = getGuild(client, params.guildId);
      return db.getLogs(g.id, Math.max(1, Math.min(parseInt(query.limit, 10) || 100, 500)));
    }, { level: 'moderator' }],

    ['GET', '/api/guilds/:guildId/memory', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      const durable = db.getMemory(g.id, 'durable');
      const working = db.getMemory(g.id, 'working');
      return {
        durable: durable.content,
        durable_version: durable.version,
        working: working.content,
        working_version: working.version,
      };
    }, { level: 'admin' }],

    ['DELETE', '/api/guilds/:guildId/memory', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      db.clearMemory(g.id);
      // Also drop the in-process hypervectors — clearing only the table would
      // leave the accumulators alive in memory and persist them again on the
      // next save, quietly undoing the wipe.
      memory.forgetHd(g.id);
      await logAction(g, 'memory_wipe', DASHBOARD_ACTOR, null, 'memory wiped from dashboard');
      return { ok: true };
    }, { level: 'admin' }],

    ['POST', '/api/guilds/:guildId/voice/start', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      db.setSetting(g.id, 'voice_enabled', true);
      // Clear any "stay out" flag set by a leave_voice / "go to sleep" — the
      // admin is explicitly turning voice back on.
      db.setSetting(g.id, 'voice_sleep', false);
      const occupied = [...g.channels.cache.values()].filter(
        (c) => c.type === ChannelType.GuildVoice && c.members.some((m) => !m.user.bot),
      );
      if (!occupied.length) {
        return {
          ok: true,
          joined: null,
          detail: 'Voice monitoring on — will join when someone enters a voice channel',
        };
      }
      const target = occupied.reduce((a, b) => (
        a.members.filter((m) => !m.user.bot).size >= b.members.filter((m) => !m.user.bot).size ? a : b
      ));
      await voice.joinRequestedChannel(target);
      return { ok: true, joined: target.name };
    }, { level: 'admin' }],

    ['POST', '/api/guilds/:guildId/voice/stop', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      db.setSetting(g.id, 'voice_enabled', false);
      // Make it stick: without this the 30s rebalance sweep would rejoin the
      // busiest occupied channel a moment later.
      voice.sleepGuild(g);
      return { ok: true };
    }, { level: 'admin' }],

    ['GET', '/api/guilds/:guildId/transcripts', async ({ params }) => {
      const g = getGuild(client, params.guildId);
      // Voice runs in-process now, so this reads the permanent chat log
      // directly instead of asking a sidecar for its in-memory buffer.
      const rows = db.getChatLog(g.id, { limit: 200 })
        .filter((r) => r.source === 'voice')
        .reverse();
      const channels = {};
      for (const row of rows) {
        const name = row.channel || 'voice';
        if (!channels[name]) channels[name] = [];
        channels[name].push({
          ts: row.ts,
          name: row.speaker,
          text: row.text,
          bot: row.user_id === null,
        });
      }
      const connection = client.guilds.cache.get(String(g.id));
      return {
        channels: Object.entries(channels).map(([name, entries]) => ({ name, entries })),
        listening: connection?.members?.me?.voice?.channel?.name || null,
        enabled: Boolean(db.getSetting(g.id, 'voice_enabled')),
      };
    }, { level: 'moderator' }],

    ['GET', '/api/logs', async ({ query }) => {
      const after = parseInt(query.after, 10) || 0;
      const limit = Math.min(parseInt(query.limit, 10) || 500, 1000);
      const entries = logbuffer.since(after, limit);
      return { entries, latest: entries.length ? entries[entries.length - 1].id : after };
    }, { level: 'creator' }],

    ['POST', '/api/bot/restart', async () => {
      // Exit the process; Railway's restart policy brings it back up.
      for (const g of client.guilds.cache.values()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await logAction(g, 'bot_restart', DASHBOARD_ACTOR, null, 'restart from dashboard');
        } catch { /* logging a restart must never block the restart */ }
      }
      setTimeout(() => process.exit(1), 1000).unref();
      return { ok: true };
    }, { level: 'creator' }],
  ];
}

const ENHANCE_PROMPTS = {
  character: 'You improve Discord bot persona descriptions. The text below describes a bot\'s '
    + 'personality and voice — how it talks, its vibe, its character. Rewrite it to be '
    + 'more vivid, specific, and well-written while preserving the original personality, '
    + 'tone, and intent. Keep it roughly the same length. '
    + 'Reply with ONLY the rewritten persona text — no preamble, no quotes, no commentary.',
  capability: 'You improve Discord bot self-awareness descriptions. The text below describes what '
    + 'the bot is aware it can do (its features and tools), so it can talk about itself '
    + 'accurately to server members. Rewrite it to be clearer and more precise while '
    + 'preserving every fact and capability mentioned — do not invent new features or drop '
    + 'existing ones. Keep it roughly the same length. '
    + 'Reply with ONLY the rewritten text — no preamble, no quotes, no commentary.',
};

const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
};

export function applyPresence(client) {
  if (!client.isReady()) return;
  const text = db.getSetting('0', 'presence_text') || '';
  const status = db.getSetting('0', 'presence_status') || 'online';
  const type = ACTIVITY_TYPES[db.getSetting('0', 'presence_activity_type')] ?? ActivityType.Playing;
  try {
    client.user.setPresence({
      status,
      activities: text ? [{ name: text, type }] : [],
    });
  } catch (err) {
    console.warn('[web] could not apply presence:', err.message);
  }
}

/** Match a request path against a route pattern, returning captured params. */
function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

async function serveStatic(res, name, opts = {}) {
  const dir = opts.dir || STATIC_DIR;
  const resolved = path.resolve(dir, name);
  // Never let a crafted path walk out of the directory being served. The
  // separator matters: a bare startsWith would also accept a sibling
  // directory whose name merely begins with this one's.
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    sendJson(res, 403, { detail: 'Forbidden' });
    return;
  }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': opts.cacheControl || 'public, max-age=31536000',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { detail: 'Not found' });
  }
}

export function createDashboard(client) {
  const routes = buildRoutes(client);

  return createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { detail: 'Bad request' });
      return;
    }
    const { pathname } = url;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = (await readFile(path.join(STATIC_DIR, 'index.html'), 'utf8'))
          .replaceAll('__BUILD__', BUILD_ID);
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true, bot_ready: client.isReady() });
        return;
      }
      if (req.method === 'GET' && pathname.startsWith('/static/')) {
        await serveStatic(res, pathname.slice('/static/'.length));
        return;
      }

      // Showcase site. Public and read-only — it is a marketing page, so it
      // sits in front of the auth check the same way the dashboard's own
      // assets do. No-cache while it is still an MVP being iterated on.
      if (req.method === 'GET' && pathname === '/site') {
        // Redirect rather than serve: without the trailing slash every
        // relative link in the page would resolve against the site root.
        res.writeHead(302, { Location: '/site/' });
        res.end();
        return;
      }
      if (req.method === 'GET' && pathname.startsWith('/site/')) {
        const rest = pathname.slice('/site/'.length) || 'index.html';
        await serveStatic(res, rest, { dir: SITE_DIR, cacheControl: 'no-cache' });
        return;
      }

      // The legal pages get short, stable URLs of their own rather than living
      // under /site/. These go into Discord's application settings and into
      // other people's bookmarks, and a URL with "/site/" and ".html" in it is
      // one that cannot be reorganised later without breaking them. Cached for
      // an hour: they change rarely, and Discord fetches them for review.
      if (req.method === 'GET' && LEGAL_PAGES[pathname]) {
        await serveStatic(res, LEGAL_PAGES[pathname], {
          dir: SITE_DIR, cacheControl: 'public, max-age=3600',
        });
        return;
      }

      for (const [method, pattern, handler, options] of routes) {
        if (req.method !== method) continue;
        const params = matchRoute(pattern, pathname);
        if (!params) continue;
        let session = null;
        let platform = null;
        if (options?.account) {
          // Platform routes authenticate as a CUSTOMER, not against this
          // Discord server's roles. A creator-level dashboard cookie is not
          // a platform session and deliberately does not stand in for one:
          // the person running a server and the person who owns the account
          // paying for it are frequently not the same human.
          platform = resolvePlatformSession(req);
          if (!platform) {
            sendJson(res, 401, { detail: 'Not signed in' });
            return;
          }
          if (options.account === 'staff' && !platform.isStaff) {
            sendJson(res, 403, { detail: 'That is staff-only.' });
            return;
          }
        } else if (!options?.open) {
          session = sessionOf(req);
          if (!session) {
            sendJson(res, 401, { detail: 'Not authenticated' });
            return;
          }
          // Fails closed: a route that forgets to declare a level is treated
          // as creator-only rather than as open to any signed-in moderator.
          // Same reasoning as routes being auth-protected unless marked open.
          const required = options?.level || 'creator';
          if (!levelAtLeast(session.level, required)) {
            sendJson(res, 403, {
              detail: `This needs ${required} access — you are signed in as ${session.level}.`,
            });
            return;
          }
          // session.level is the BEST access this user has anywhere the bot
          // runs (computed once at login) — enough to gate bot-wide routes,
          // but not enough on its own for a route naming a specific guild:
          // a moderator in one server must not reach into another server's
          // members, settings, or mod actions just by outranking the route's
          // minimum level globally. Re-derive their level from THAT guild's
          // own live roles instead. Creator (the instance owner, or the
          // password break-glass login) is exempt — that access is
          // deliberately instance-wide, not guild-scoped.
          if (params.guildId && session.level !== 'creator') {
            const targetGuild = client.guilds.cache.get(String(params.guildId));
            if (!targetGuild) {
              sendJson(res, 404, { detail: 'Guild not found' });
              return;
            }
            const scoped = await levelForUserInGuild(targetGuild, session.userId);
            if (!levelAtLeast(scoped, required)) {
              sendJson(res, 403, {
                detail: scoped === 'none'
                  ? "You don't have dashboard access in this server."
                  : `This needs ${required} access in this server — you are ${scoped}.`,
              });
              return;
            }
          }
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
        const query = Object.fromEntries(url.searchParams);
        const result = await handler({
          params, body, query, req, res, session, platform, sendJson,
        });
        if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { detail: 'Not found' });
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { detail: err.detail });
        return;
      }
      // discord.js surfaces permission problems as code 50013.
      if (err?.code === 50013) {
        sendJson(res, 403, {
          detail: 'The bot lacks permission for that. Check its role position and permissions.',
        });
        return;
      }
      if (err?.httpStatus || err?.status >= 400) {
        sendJson(res, 502, { detail: `Discord error: ${err.message}` });
        return;
      }
      console.error('[web] unhandled error:', err);
      sendJson(res, 500, { detail: 'Internal error' });
    }
  });
}

export function startDashboard(client) {
  const server = createDashboard(client);
  server.listen(PORT, () => console.log(`[web] dashboard listening on :${PORT}`));
  return server;
}

export { HttpError, matchRoute, serializeChannel, serializeRole };
