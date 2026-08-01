// Cooldown manager: global / channel / user / topic scopes, persisted.
// Ported from pressure/cooldowns.py.

export class CooldownManager {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  /** The scopes currently holding Max silent (empty array = clear to speak). */
  active(now, channelId, userId, topic) {
    const cooldowns = this.store.getCooldowns();
    const held = [];
    for (const scope of ['global', `channel:${channelId}`, `user:${userId}`, `topic:${topic}`]) {
      if (scope.endsWith(':')) continue; // empty id — scope not applicable
      if ((cooldowns[scope] || 0) > now) held.push(scope);
    }
    return held;
  }

  startAll(now, channelId, userId, topic) {
    const c = this.config;
    this.store.setCooldown('global', now + c.cooldownGlobal);
    if (channelId) this.store.setCooldown(`channel:${channelId}`, now + c.cooldownChannel);
    if (userId) this.store.setCooldown(`user:${userId}`, now + c.cooldownUser);
    if (topic) this.store.setCooldown(`topic:${topic}`, now + c.cooldownTopic);
  }
}
