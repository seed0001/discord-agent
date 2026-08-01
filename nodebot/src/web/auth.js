// Password login with signed session-cookie tokens. Ported from web/auth.py.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DASHBOARD_PASSWORD, SECRET_KEY } from '../config.js';
import { isLevel } from './roles.js';

// If SECRET_KEY isn't set, generate one per process (sessions reset on
// restart) rather than falling back to a predictable value.
const SECRET = SECRET_KEY || randomBytes(32).toString('hex');
export const TOKEN_TTL = 7 * 86400; // seconds

function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

/** Constant-time compare that tolerates length mismatches. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Session token: `expiry.level.userId.signature`.
 *
 * The level is inside the signed payload, not alongside it — otherwise
 * anyone holding a valid moderator cookie could rewrite one field and
 * promote themselves. userId rides along so the dashboard can show who is
 * signed in, and so a level can be re-derived from live Discord roles rather
 * than trusted from the cookie forever.
 */
export function createToken(level = 'creator', userId = '') {
  const expiry = String(Math.floor(Date.now() / 1000) + TOKEN_TTL);
  const payload = `${expiry}.${level}.${encodeURIComponent(userId)}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns {{level: string, userId: string, expiresAt: number}|null} */
export function readToken(token) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [expiry, level, userId, signature] = parts;
  if (!safeEqual(signature, sign(`${expiry}.${level}.${userId}`))) return null;
  const expiresAt = parseInt(expiry, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) return null;
  if (!isLevel(level) || level === 'none') return null;
  return { level, userId: decodeURIComponent(userId), expiresAt };
}

export function verifyToken(token) {
  return readToken(token) !== null;
}

export function checkPassword(password) {
  // No password configured means no login is possible — never "anything works".
  if (!DASHBOARD_PASSWORD) return false;
  return safeEqual(password ?? '', DASHBOARD_PASSWORD);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function isAuthenticated(req) {
  return verifyToken(parseCookies(req.headers.cookie).session);
}

/** The signed-in session, or null. */
export function sessionOf(req) {
  return readToken(parseCookies(req.headers.cookie).session);
}

/** Signed, short-lived value for the OAuth `state` round trip, so a callback
 * can be proven to belong to a login this dashboard actually started. */
export function createState() {
  const nonce = `${Math.floor(Date.now() / 1000) + 600}.${randomBytes(12).toString('hex')}`;
  return `${nonce}.${sign(nonce)}`;
}

export function verifyState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const [expiry, nonce, signature] = parts;
  if (!safeEqual(signature, sign(`${expiry}.${nonce}`))) return false;
  return parseInt(expiry, 10) > Date.now() / 1000;
}
