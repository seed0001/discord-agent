// Dashboard access levels, resolved from the server's own Discord roles.
//
// One instance of the bot runs one server, so there is no cross-server
// scoping here: whoever signs in is looked up as a member of that server, and
// what they can do on the dashboard follows from what they already are in
// Discord. No second list of people to maintain.
//
// Everything below is a pure function over plain data — no discord.js — so
// the mapping can be tested directly.

/** Ordered. Higher wins; compare with levelAtLeast(). */
export const LEVELS = Object.freeze({
  none: 0,
  moderator: 1,
  admin: 2,
  creator: 3,
});

export const LEVEL_NAMES = Object.freeze(['none', 'moderator', 'admin', 'creator']);

export function levelAtLeast(level, required) {
  return (LEVELS[level] ?? 0) >= (LEVELS[required] ?? 0);
}

export function isLevel(value) {
  return Object.hasOwn(LEVELS, String(value));
}

/**
 * Work out what someone gets, from who they are in the Discord server.
 *
 * Precedence, highest first:
 *  1. The person running this instance (OWNER_ID) is always creator. They
 *     cannot be locked out of their own dashboard by a role misconfiguration.
 *  2. Discord's Administrator permission means admin. Someone with it can
 *     already grant themselves any role in the server, so withholding it here
 *     would be theatre.
 *  3. An explicitly mapped admin role, then an explicitly mapped mod role.
 *  4. If NO roles have been mapped yet, fall back to Discord permissions, so
 *     a fresh install is usable before anyone configures anything: Manage
 *     Server means admin, and the moderation permissions mean moderator.
 *
 * @param {object} m
 * @param {string} m.userId
 * @param {string[]} [m.roleIds]          the member's Discord role ids
 * @param {boolean} [m.isAdministrator]   has Discord's Administrator permission
 * @param {boolean} [m.canManageGuild]    has Manage Server
 * @param {boolean} [m.canModerate]       has kick/ban/timeout
 * @param {string} [m.ownerId]            OWNER_ID — who runs this instance
 * @param {string[]} [m.adminRoles]       dashboard_admin_roles
 * @param {string[]} [m.modRoles]         dashboard_mod_roles
 * @returns {'creator'|'admin'|'moderator'|'none'}
 */
export function resolveLevel({
  userId,
  roleIds = [],
  isAdministrator = false,
  canManageGuild = false,
  canModerate = false,
  ownerId = '',
  adminRoles = [],
  modRoles = [],
}) {
  const id = String(userId ?? '');
  if (id && ownerId && id === String(ownerId)) return 'creator';

  if (isAdministrator) return 'admin';

  const mine = new Set((roleIds || []).map(String));
  if ((adminRoles || []).some((r) => mine.has(String(r)))) return 'admin';
  if ((modRoles || []).some((r) => mine.has(String(r)))) return 'moderator';

  // Nothing mapped yet — lean on Discord's own permissions so the dashboard
  // works on day one. Once a server maps roles, those become the source of
  // truth and permission-based access stops widening past Administrator.
  const nothingMapped = !(adminRoles || []).length && !(modRoles || []).length;
  if (nothingMapped) {
    if (canManageGuild) return 'admin';
    if (canModerate) return 'moderator';
  }
  return 'none';
}

/** Flatten a discord.js GuildMember into resolveLevel()'s input. Kept here so
 * the permission-flag names live next to the rule that uses them. */
export function memberFacts(member, PermissionsBitField) {
  const perms = member?.permissions;
  const Flags = PermissionsBitField?.Flags || {};
  const has = (flag) => Boolean(flag && perms?.has?.(flag));
  return {
    userId: String(member?.id ?? ''),
    roleIds: [...(member?.roles?.cache?.keys?.() || [])].map(String),
    isAdministrator: has(Flags.Administrator),
    canManageGuild: has(Flags.ManageGuild),
    canModerate: has(Flags.ModerateMembers) || has(Flags.KickMembers) || has(Flags.BanMembers),
  };
}
