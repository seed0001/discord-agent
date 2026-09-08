// Dashboard server — driven over real HTTP against a real listening server
// with a fake discord.js client, so routing, auth, cookies and serialization
// are all exercised the way a browser exercises them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionsBitField } from 'discord.js';
import { createDashboard, matchRoute } from '../src/web/server.js';
import { createToken, verifyToken, checkPassword } from '../src/web/auth.js';
import * as db from '../src/db.js';

// -- fake discord.js surface -------------------------------------------------

const collection = (entries) => {
  const map = new Map(entries.map((e) => [String(e.id), e]));
  map.filter = (fn) => collection([...map.values()].filter(fn));
  map.some = (fn) => [...map.values()].some(fn);
  map.map = (fn) => [...map.values()].map(fn);
  return map;
};

// A member with the given Discord permission flags, for exercising the
// dashboard's per-guild access check (levelForUserInGuild in server.js),
// which re-derives access from live guild membership rather than trusting
// whatever level a session cookie claims.
function fakeMember(id, flags = []) {
  return {
    id,
    user: { id, username: `user-${id}`, bot: false },
    displayName: `user-${id}`,
    displayAvatarURL: () => 'http://avatar',
    joinedTimestamp: 1700000000000,
    communicationDisabledUntilTimestamp: null,
    guild: { id: '111' },
    roles: { cache: collection([]) },
    permissions: { has: (flag) => flags.includes(flag) },
  };
}

function fakeClient({ members = [] } = {}) {
  const memberCache = collection(members);
  const guild = {
    id: '111',
    name: 'Test Server',
    ownerId: '42',
    memberCount: 3,
    premiumTier: 0,
    createdTimestamp: 1700000000000,
    iconURL: () => null,
    members: {
      cache: memberCache,
      fetch: async (id) => {
        const m = memberCache.get(String(id));
        if (!m) throw new Error('Unknown Member');
        return m;
      },
    },
    channels: { cache: collection([]) },
    roles: { cache: collection([]) },
  };
  return {
    isReady: () => true,
    user: { id: '999', username: 'Max', displayAvatarURL: () => 'http://avatar' },
    ws: { ping: 42 },
    guilds: { cache: collection([guild]) },
  };
}

/** Start the dashboard on an ephemeral port and return a fetch helper.
 * `clientOptions` (e.g. `{ members: [fakeMember(...)] }`) seeds the fake
 * guild's member list, for tests exercising the per-guild access check. */
async function withServer(fn, clientOptions) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-web-'));
  db.initDb(path.join(dir, 'test.db'));
  const server = createDashboard(fakeClient(clientOptions));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const call = (method, urlPath, { body, cookie } = {}) => fetch(
    `http://127.0.0.1:${port}${urlPath}`,
    {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    },
  );
  // Raw sender, for bodies that deliberately aren't valid JSON.
  call.raw = (method, urlPath, rawBody, cookie) => fetch(
    `http://127.0.0.1:${port}${urlPath}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: rawBody,
    },
  );
  try {
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

const authCookie = () => `session=${createToken()}`;

// -- auth primitives ---------------------------------------------------------

test('a freshly created token verifies', () => {
  assert.equal(verifyToken(createToken()), true);
});

test('a tampered or malformed token does not verify', () => {
  const token = createToken();
  assert.equal(verifyToken(`${token}x`), false);
  assert.equal(verifyToken('9999999999.deadbeef'), false);
  assert.equal(verifyToken('nodothere'), false);
  assert.equal(verifyToken(''), false);
});

test('an expired token does not verify', () => {
  // Hand-built with a past expiry; the signature is irrelevant once expired.
  assert.equal(verifyToken('1000000000.whatever'), false);
});

test('login is impossible when no dashboard password is configured', () => {
  // DASHBOARD_PASSWORD is unset in the test environment — this must never
  // degrade to "any password works".
  assert.equal(checkPassword(''), false);
  assert.equal(checkPassword('anything'), false);
});

// -- routing -----------------------------------------------------------------

test('route matching captures params and rejects mismatches', () => {
  assert.deepEqual(matchRoute('/api/guilds/:guildId', '/api/guilds/111'), { guildId: '111' });
  assert.deepEqual(
    matchRoute('/api/guilds/:guildId/members/:userId/action', '/api/guilds/1/members/2/action'),
    { guildId: '1', userId: '2' },
  );
  assert.equal(matchRoute('/api/guilds/:guildId', '/api/guilds/111/settings'), null);
  assert.equal(matchRoute('/api/guilds/:guildId', '/api/other/111'), null);
});

// -- authentication over the wire --------------------------------------------

test('protected endpoints reject an unauthenticated request', () => withServer(async (call) => {
  for (const [method, url] of [
    ['GET', '/api/me'],
    ['GET', '/api/guilds'],
    ['GET', '/api/guilds/111/settings'],
    ['GET', '/api/logs'],
    ['POST', '/api/bot/restart'],
    ['DELETE', '/api/guilds/111/memory'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(method, url);
    assert.equal(res.status, 401, `${method} ${url} should require auth`);
  }
}));

test('a wrong password is rejected and sets no cookie', () => withServer(async (call) => {
  const res = await call('POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
}));

test('logout clears the session cookie', () => withServer(async (call) => {
  const res = await call('POST', '/api/logout');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /session=;/);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
}));

test('the session cookie is HttpOnly and SameSite=Lax', () => withServer(async (call) => {
  // Not settable from JS, not sent on cross-site requests.
  const res = await call('POST', '/api/logout');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
}));

// -- unauthenticated surface -------------------------------------------------

test('health is reachable without a session', () => withServer(async (call) => {
  const res = await call('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, bot_ready: true });
}));

test('the index page is served with the build id substituted', () => withServer(async (call) => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /__BUILD__/, 'the cache-busting placeholder must be replaced');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
}));

test('static assets are served', () => withServer(async (call) => {
  const res = await call('GET', '/static/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
}));

test('a path traversal attempt on static files is refused', () => withServer(async (call) => {
  const res = await call('GET', '/static/..%2F..%2F..%2Fconfig.js');
  assert.ok([403, 404].includes(res.status), 'must not serve files outside static/');
}));

// -- authenticated behaviour -------------------------------------------------

test('an authenticated request reaches the handler', () => withServer(async (call) => {
  const res = await call('GET', '/api/me', { cookie: authCookie() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.id, '999');
  assert.equal(typeof body.build, 'string');
}));

test('guild ids are serialized as strings, never numbers', () => withServer(async (call) => {
  const res = await call('GET', '/api/guilds', { cookie: authCookie() });
  const body = await res.json();
  assert.equal(typeof body[0].id, 'string', 'snowflakes exceed JS safe integers');
}));

test('/api/guilds only lists servers the signed-in user actually has access '
  + 'in — not every server the bot is installed in', () => withServer(async (call) => {
  // '222' has a moderator-level session (a login elsewhere granted it that),
  // but isn't a member of guild 111 in this test's fake guild at all, so it
  // must not appear — otherwise the list alone leaks this server's name,
  // icon, and member count to a moderator from a completely unrelated one.
  const res = await call('GET', '/api/guilds', { cookie: cookieFor('moderator') });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
}));

test('/api/guilds does list a server the user has real access in', () => withServer(async (call) => {
  const res = await call('GET', '/api/guilds', { cookie: cookieFor('moderator') });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, '111');
}, { members: [fakeMember('222', [PermissionsBitField.Flags.ModerateMembers])] }));

test('an unknown guild is a clean 404', () => withServer(async (call) => {
  const res = await call('GET', '/api/guilds/999999', { cookie: authCookie() });
  assert.equal(res.status, 404);
  assert.match((await res.json()).detail, /not found/i);
}));

test('settings round-trip through the API', () => withServer(async (call) => {
  const put = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { ai_model: 'some/model', quiet_mode: true },
  });
  assert.equal(put.status, 200);
  const get = await call('GET', '/api/guilds/111/settings', { cookie: authCookie() });
  const settings = await get.json();
  assert.equal(settings.ai_model, 'some/model');
  assert.equal(settings.quiet_mode, true);
}));

test('settings expose the effective bot name, derived from Discord', () => withServer(async (call) => {
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(settings.bot_name, null);
  assert.equal(settings.bot_name_effective, 'Max');
  assert.equal(settings.bot_name_source, 'discord');
}));

test('an override is reported as the effective name', () => withServer(async (call) => {
  await call('PUT', '/api/guilds/111/settings', { cookie: authCookie(), body: { bot_name: 'Amy' } });
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(settings.bot_name, 'Amy');
  assert.equal(settings.bot_name_effective, 'Amy');
  assert.equal(settings.bot_name_source, 'override');
}));

test('clearing the bot name field reverts to the Discord name', () => withServer(async (call) => {
  // Storing '' would pin the bot to an empty name with no way back from the UI.
  await call('PUT', '/api/guilds/111/settings', { cookie: authCookie(), body: { bot_name: 'Amy' } });
  await call('PUT', '/api/guilds/111/settings', { cookie: authCookie(), body: { bot_name: '  ' } });
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(settings.bot_name, null);
  assert.equal(settings.bot_name_effective, 'Max');
}));

test('per-server TTS overrides round-trip and expose effective values', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: {
      fish_voice_id: 'voice-abc',
      fish_tts_model: 's2.1-pro',
      edge_tts_voice: 'en-US-AriaNeural',
    },
  });
  assert.equal(res.status, 200);
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(settings.fish_voice_id, 'voice-abc');
  assert.equal(settings.fish_tts_model, 's2.1-pro');
  assert.equal(settings.edge_tts_voice, 'en-US-AriaNeural');
  assert.equal(settings.fish_voice_id_source, 'override');
  assert.equal(settings.fish_tts_model_effective, 's2.1-pro');
  assert.equal(settings.edge_tts_voice_effective, 'en-US-AriaNeural');
  assert.equal(typeof settings.fish_api_configured, 'boolean');
}));

test('clearing TTS overrides stores null and falls back to env', () => withServer(async (call) => {
  await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { fish_voice_id: 'temp' },
  });
  await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { fish_voice_id: '  ' },
  });
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(settings.fish_voice_id, null);
  assert.equal(settings.fish_voice_id_source, 'env');
}));

test('the read-only name fields can be sent back without a 400', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { bot_name_effective: 'Amy', bot_name_source: 'discord', quiet_mode: true },
  });
  assert.equal(res.status, 200);
}));

test('an unknown setting key is rejected rather than stored', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { not_a_real_setting: 'x' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /Unknown setting/);
}));

test('a malformed JSON body is a 400, not a crash', () => withServer(async (call) => {
  const res = await call.raw('PUT', '/api/guilds/111/settings', '{not json', authCookie());
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /Invalid JSON/);
}));

test('an empty body is accepted as "nothing to change"', () => withServer(async (call) => {
  const res = await call.raw('PUT', '/api/guilds/111/settings', '', authCookie());
  assert.equal(res.status, 200);
}));

test('an oversized body is refused rather than buffered', () => withServer(async (call) => {
  const res = await call.raw(
    'PUT', '/api/guilds/111/settings', 'x'.repeat(1_100_000), authCookie(),
  );
  assert.equal(res.status, 413);
}));

test('an unknown route is a 404', () => withServer(async (call) => {
  const res = await call('GET', '/api/nope', { cookie: authCookie() });
  assert.equal(res.status, 404);
}));

test('memory reads report content and version', () => withServer(async (call) => {
  db.setMemory('111', 'durable', 'a durable fact');
  const res = await call('GET', '/api/guilds/111/memory', { cookie: authCookie() });
  const body = await res.json();
  assert.equal(body.durable, 'a durable fact');
  assert.equal(body.durable_version, 1);
  assert.equal(body.working, '');
}));

test('the logs endpoint reports entries and the latest id', () => withServer(async (call) => {
  const res = await call('GET', '/api/logs', { cookie: authCookie() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.entries));
  assert.equal(typeof body.latest, 'number');
}));

// -- every settings key the dashboard sends must exist in DEFAULTS ------------

// The PUT rejects an unknown key with a 400, and a 400 fails the WHOLE payload,
// not the offending field — so one key in app.js that isn't in db.DEFAULTS
// silently breaks an entire dashboard tab. That has happened twice already
// (ai_capability_prompt, then ai_channels), and each time it was caught by
// hand and fixed with a one-off test for that one key.
//
// This checks the actual relationship instead: scrape every `key: $("#s-...")`
// out of app.js's save handlers and assert DEFAULTS knows about it. A new
// control added to the dashboard without a matching default now fails here
// rather than in production.
test('every s- prefixed settings key in app.js exists in db.DEFAULTS', () => {
  const appJs = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/web/static/app.js'),
    'utf8',
  );
  const keys = [...appJs.matchAll(/(\w+):\s*\$\("#s-(\w+)"\)/g)].map((m) => m[1]);
  assert.ok(keys.length > 20, `expected to find the settings payload, found ${keys.length} keys`);

  // Read-only fields the GET adds back; server.js skips them by name.
  const readOnly = new Set(['bot_name_effective', 'bot_name_source']);
  const unknown = [...new Set(keys)].filter((k) => !readOnly.has(k) && !(k in db.DEFAULTS));
  assert.deepEqual(unknown, [], `dashboard sends keys missing from db.DEFAULTS: ${unknown.join(', ')}`);
});

// -- the persona save the dashboard actually performs -------------------------

// app.js's "Save persona" button PUTs both halves together. ai_capability_prompt
// was missing from db.DEFAULTS, so the whole request 400'd and neither half
// saved — which is how a customised character persona could appear to have
// been wiped.
test('saving both persona halves together succeeds', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: {
      ai_system_prompt: 'You are a laconic robot.',
      ai_capability_prompt: 'You can do the things.',
    },
  });
  assert.equal(res.status, 200);
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(settings.ai_system_prompt, 'You are a laconic robot.');
  assert.equal(settings.ai_capability_prompt, 'You can do the things.');
}));

// Same failure on the Settings tab: ai_channels was missing, so nothing on
// that tab saved either — automod, banned words, wake words, log channel.
test('saving the settings tab payload succeeds, ai_channels included', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: {
      ai_channels: ['123', '456'],
      automod_enabled: true,
      banned_words: ['spam'],
      voice_wake_words: ['hey max'],
    },
  });
  assert.equal(res.status, 200);
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.deepEqual(settings.ai_channels, ['123', '456']);
  assert.equal(settings.automod_enabled, true);
}));

// -- phrase lists arrive from the dashboard as bracket text -------------------

test('bracket text is parsed into a phrase list on save', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { voice_wake_words: '[hey max] [max, you around?]' },
  });
  assert.equal(res.status, 200);
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  // The comma stays inside the phrase instead of splitting it in two.
  assert.deepEqual(settings.voice_wake_words, ['hey max', 'max you around']);
}));

test('an array still works, so the API contract is unchanged', () => withServer(async (call) => {
  await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { voice_cancel_words: ['Never Mind', 'forget it'] },
  });
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.deepEqual(settings.voice_cancel_words, ['never mind', 'forget it']);
}));

test('all four phrase lists save from the dashboard', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: {
      voice_wake_words: '[hey max]',
      voice_cancel_words: '[never mind]',
      voice_stop_speaking_words: '[max stop speaking]',
      voice_stop_listening_words: '[max stop listening]',
    },
  });
  assert.equal(res.status, 200);
  const s = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.deepEqual(s.voice_stop_speaking_words, ['max stop speaking']);
  assert.deepEqual(s.voice_stop_listening_words, ['max stop listening']);
}));

test('a blank phrase-list field clears a saved override instead of storing an empty list', () => withServer(async (call) => {
  await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { voice_wake_words: '[hey max]' },
  });
  let settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.deepEqual(settings.voice_wake_words, ['hey max']);

  await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { voice_wake_words: '   ' },
  });
  settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  // Back to the shipped {ai}-templated default, not an empty (silenced) list.
  assert.equal(settings.voice_wake_words.length > 0, true);
  assert.ok(settings.voice_wake_words.some((p) => p.includes('{ai}')));
}));

test('an explicit empty array for a phrase list is still honored as deliberately empty', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { voice_wake_words: [] },
  });
  assert.equal(res.status, 200);
  const settings = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.deepEqual(settings.voice_wake_words, []);
}));

test('a non-phrase setting is not mangled by the phrase parser', () => withServer(async (call) => {
  await call('PUT', '/api/guilds/111/settings', {
    cookie: authCookie(),
    body: { welcome_message: 'Welcome {user}, glad you made it!' },
  });
  const s = await (await call('GET', '/api/guilds/111/settings', { cookie: authCookie() })).json();
  assert.equal(s.welcome_message, 'Welcome {user}, glad you made it!');
}));

// -- access levels are enforced by the server, not just hidden in the UI -----

const cookieFor = (level) => `session=${createToken(level, '222')}`;

test('a moderator cannot change settings', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: cookieFor('moderator'),
    body: { ai_model: 'something/else' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).detail, /needs admin access/);
}));

test('a moderator can still read settings and act on members', () => withServer(async (call) => {
  assert.equal((await call('GET', '/api/guilds/111/settings', { cookie: cookieFor('moderator') })).status, 200);
  assert.equal((await call('GET', '/api/guilds/111/members', { cookie: cookieFor('moderator') })).status, 200);
}, { members: [fakeMember('222', [PermissionsBitField.Flags.ModerateMembers])] }));

test('an admin can change settings', () => withServer(async (call) => {
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: cookieFor('admin'),
    body: { ai_model: 'something/else' },
  });
  assert.equal(res.status, 200);
}, { members: [fakeMember('222', [PermissionsBitField.Flags.Administrator])] }));

test('a session level is not enough on its own — it must also hold up in THAT guild', () => withServer(async (call) => {
  // '222' claims admin in the cookie (the level a login elsewhere granted
  // them), but is not a member of guild 111 at all in this test's fake
  // guild, so the live per-guild check must still refuse them.
  const res = await call('PUT', '/api/guilds/111/settings', {
    cookie: cookieFor('admin'),
    body: { ai_model: 'something/else' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).detail, /don't have dashboard access in this server/);
}));

test('an admin cannot read the global bot log or change presence', () => withServer(async (call) => {
  // The log buffer spans everything the process does; presence is the bot's
  // own identity. Both are the instance owner's.
  assert.equal((await call('GET', '/api/logs', { cookie: cookieFor('admin') })).status, 403);
  assert.equal((await call('POST', '/api/presence', {
    cookie: cookieFor('admin'), body: { status: 'idle' },
  })).status, 403);
}));

test('the creator can do all of it', () => withServer(async (call) => {
  assert.equal((await call('GET', '/api/logs', { cookie: cookieFor('creator') })).status, 200);
  assert.equal((await call('PUT', '/api/guilds/111/settings', {
    cookie: cookieFor('creator'), body: { ai_model: 'x' },
  })).status, 200);
}));

test('no cookie is still a 401, not a 403', () => withServer(async (call) => {
  assert.equal((await call('GET', '/api/guilds/111/settings')).status, 401);
}));

test('the Discord login config endpoint is reachable without signing in', () => withServer(async (call) => {
  const res = await call('GET', '/api/auth/config');
  assert.equal(res.status, 200);
  assert.equal(typeof (await res.json()).discord, 'boolean');
}));

test('role mappings save like any other setting', () => withServer(async (call) => {
  await call('PUT', '/api/guilds/111/settings', {
    cookie: cookieFor('admin'),
    body: { dashboard_admin_roles: ['500'], dashboard_mod_roles: ['600'] },
  });
  const s = await (await call('GET', '/api/guilds/111/settings', { cookie: cookieFor('admin') })).json();
  assert.deepEqual(s.dashboard_admin_roles, ['500']);
  assert.deepEqual(s.dashboard_mod_roles, ['600']);
  // Administrator (unlike ManageGuild) keeps resolving to admin even after
  // this test's own PUT above maps dashboard_admin_roles away from the
  // "nothing mapped" permission fallback — see roles.js's resolveLevel.
}, { members: [fakeMember('222', [PermissionsBitField.Flags.Administrator])] }));

/* ── Legal pages ──────────────────────────────────────────────────────────
   These URLs go into Discord's application settings and cannot be changed
   afterwards without breaking the link, so they get tested like an API. */

test('the legal pages are served, unauthenticated, at their short URLs', () => withServer(async (call) => {
  for (const [urlPath, marker] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
    const res = await call('GET', urlPath);
    assert.equal(res.status, 200, `${urlPath} must not require signing in`);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, new RegExp(`<title>${marker}`));
    // Assets have to be absolute: the same file is reachable at /privacy and
    // at /site/privacy.html, and a relative href resolves differently at each.
    assert.ok(!/(href|src)="(?!\/|https?:|data:|mailto:|#)/.test(html),
      `${urlPath} has a relative link that will 404 at this depth`);
  }
}));

test('the alternate spellings resolve to the same pages', () => withServer(async (call) => {
  // Whichever form gets pasted somewhere permanent, it works.
  assert.match(await (await call('GET', '/privacy-policy')).text(), /<title>Privacy Policy/);
  assert.match(await (await call('GET', '/tos')).text(), /<title>Terms of Service/);
}));

test('the legal routes cannot be walked out of the site directory', () => withServer(async (call) => {
  // The route table is a fixed map rather than a path join, so there is no
  // user-supplied segment to traverse with — this pins that down.
  assert.equal((await call('GET', '/privacy/../../package.json')).status, 404);
}));
