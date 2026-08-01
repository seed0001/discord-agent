// "Sign in with Discord" for the dashboard.
//
// Only the `identify` scope is requested — just enough to learn who is
// signing in. Their roles are then read from the guild through the bot's own
// connection, which is both more trustworthy than anything the browser could
// hand us and avoids asking the user for a broader scope.
import { CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL } from '../config.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const USER_URL = 'https://discord.com/api/v10/users/@me';

export class OAuthError extends Error {}

/** Is Discord login usable at all? Without a client secret it is not, and the
 * dashboard falls back to password-only. */
export function oauthConfigured() {
  return Boolean(CLIENT_ID && DISCORD_CLIENT_SECRET);
}

/**
 * The callback URL Discord will send the browser back to. Prefers PUBLIC_URL
 * (set it when the dashboard sits behind a proxy that rewrites Host), and
 * otherwise reconstructs it from the request — so a Railway deploy works with
 * no extra configuration beyond registering the URL with Discord.
 */
export function redirectUri(req) {
  if (PUBLIC_URL) return `${PUBLIC_URL.replace(/\/$/, '')}/api/auth/callback`;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost';
  const proto = req?.headers?.['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/api/auth/callback`;
}

export function authorizeUrl(req, state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Swap the one-time code for an access token. */
export async function exchangeCode(code, req) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(req),
    }),
  });
  if (!resp.ok) {
    throw new OAuthError(`token exchange failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data?.access_token) throw new OAuthError('token exchange returned no access token');
  return data.access_token;
}

/** Who signed in. */
export async function fetchDiscordUser(accessToken) {
  const resp = await fetch(USER_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    throw new OAuthError(`identity lookup failed (${resp.status})`);
  }
  const user = await resp.json();
  if (!user?.id) throw new OAuthError('identity lookup returned no user id');
  return { id: String(user.id), username: user.username || 'unknown', avatar: user.avatar || null };
}
