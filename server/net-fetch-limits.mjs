// How many fetches net.fetch runs at once and how often (#1482): each app may have NET_FETCH.perApp open and start
// NET_FETCH.perMinute a minute, and all apps together NET_FETCH.total open and NET_FETCH.allPerMinute a minute, so a
// polling or runaway app, or an agent with many apps, can’t open sockets without bound or fill the activity. Past a
// limit a fetch is refused with a 429 that says which, and the app can try again; nothing waits on the person. Kept
// in memory: a restart starts every count again.

import { NET_FETCH } from '../shared/limits.mjs';
import { httpError } from './helpers.mjs';

const MINUTE_MS = 60_000;

export class FetchLimits {
  /** @param {{ now?: () => number, limits?: typeof NET_FETCH }} [opts] */
  constructor({ now = Date.now, limits = NET_FETCH } = {}) {
    this.now = now;
    this.limits = limits;
    this.total = 0;
    /** @type {Map<string, number>} app id → its fetches open */
    this.open = new Map();
    /** @type {Map<string, number[]>} app id → when each of its fetches in the last minute started */
    this.started = new Map();
    /** @type {number[]} when each fetch of any app’s in the last minute started */
    this.allStarted = [];
  }

  /**
   * Admits one fetch of an app’s, or refuses it with a 429. Call the function it returns when the fetch ends.
   * @param {string} appId @returns {() => void}
   */
  admit(appId) {
    const at = this.now();
    const recent = (this.started.get(appId) ?? []).filter((t) => at - t < MINUTE_MS);
    if (recent.length >= this.limits.perMinute)
      throw httpError(429, `net.fetch takes at most ${this.limits.perMinute} fetches a minute from one app. Wait, then fetch again.`);
    const all = this.allStarted.filter((t) => at - t < MINUTE_MS);
    if (all.length >= this.limits.allPerMinute)
      throw httpError(429, `net.fetch takes at most ${this.limits.allPerMinute} fetches a minute from all apps. Wait, then fetch again.`);
    const open = this.open.get(appId) ?? 0;
    if (open >= this.limits.perApp) throw httpError(429, `net.fetch runs at most ${this.limits.perApp} fetches at once for one app. Wait for one to finish.`);
    if (this.total >= this.limits.total) throw httpError(429, `net.fetch runs at most ${this.limits.total} fetches at once. Try again shortly.`);
    recent.push(at);
    this.started.set(appId, recent);
    all.push(at);
    this.allStarted = all;
    this.open.set(appId, open + 1);
    this.total++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.total--;
      const left = (this.open.get(appId) ?? 1) - 1;
      if (left > 0) this.open.set(appId, left);
      else this.open.delete(appId);
    };
  }
}
