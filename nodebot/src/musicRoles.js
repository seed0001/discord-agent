// Who may use music generation and the song library on a given server.
//
// A separate axis from the dashboard access levels in web/roles.js: a server
// might want its "DJ" role able to make music without making them a dashboard
// admin. But admins and above always get the top music tier — someone who can
// already reconfigure the bot is not meaningfully restrained by a music gate.
//
// Pure functions over plain data (no discord.js) so the rule is testable on
// its own; musicTools.js does the discord.js flattening.
import { levelAtLeast } from './web/roles.js';

/**
 * @typedef {'none'|'generate'|'curate'} MusicAccess
 *  - `curate`   generate tracks, keep a personal library, AND add to the
 *               shared server library
 *  - `generate` generate tracks and keep a personal library
 *  - `none`     no music tools at all
 */

/**
 * Resolve someone's music access.
 *
 * Precedence, highest first:
 *  1. Dashboard admin or creator → `curate`. They can already point the bot
 *     at any model and edit these very role lists.
 *  2. A role in `curatorRoles` → `curate`.
 *  3. A role in `roles` → `generate`.
 *  4. Otherwise `none` — and note that when BOTH lists are empty this is the
 *     result for every non-admin, i.e. music stays admin/owner-only. That is
 *     the deliberate default: each generation spends real money, so opening
 *     it up is a choice a server makes on purpose.
 *
 * @param {object} m
 * @param {'creator'|'admin'|'moderator'|'none'} [m.dashboardLevel]
 * @param {string[]} [m.roleIds]      the member's Discord role ids
 * @param {string[]} [m.roles]        music_roles setting
 * @param {string[]} [m.curatorRoles] music_curator_roles setting
 * @returns {MusicAccess}
 */
export function musicAccess({
  dashboardLevel = 'none',
  roleIds = [],
  roles = [],
  curatorRoles = [],
}) {
  if (levelAtLeast(dashboardLevel, 'admin')) return 'curate';
  const mine = new Set((roleIds || []).map(String));
  if ((curatorRoles || []).some((r) => mine.has(String(r)))) return 'curate';
  if ((roles || []).some((r) => mine.has(String(r)))) return 'generate';
  return 'none';
}

export function canGenerateMusic(access) {
  return access === 'generate' || access === 'curate';
}

export function canCurateMusic(access) {
  return access === 'curate';
}
