// The host manager’s links (hosts.mjs, whose header is the design): one per host, made on first use, kept connected
// while the host is needed and idled once it isn’t, and replaced after a rename once nothing needs the old one. Each
// function takes the manager’s state first (hosts-status.mjs’s Manager).

import { hostOf, tokenOf, update } from './hosts-status.mjs';
import { createHostLink } from './link.mjs';
import { failure as sshFailure } from './ssh.mjs';

/** How long a connected host that nothing needs keeps its session, so back-to-back turns share one. */
export const IDLE_GRACE_MS = 2 * 60 * 1000;

/**
 * @typedef {import('./hosts-status.mjs').Manager} Manager
 * @typedef {import('./hosts-status.mjs').Entry} Entry
 * @typedef {import('./hosts-status.mjs').Host} Host
 * @typedef {import('./hosts-status.mjs').HostLink} HostLink
 */

/** Whether the host is needed: a reason, or a listener for its messages other than this module’s. @param {Manager} m @param {string} id */
export function isNeeded(m, id) {
  if (m.reasons.get(id)?.size) return true;
  const e = m.links.get(id);
  return Boolean(e && e.link.listenerCount('message') > 1);
}

/**
 * Closes an idle host’s session after the grace period, or keeps a needed one connected. A renamed host’s old link
 * goes at once, once nothing needs it.
 * @param {Manager} m @param {string} id
 */
export function reconsider(m, id) {
  const e = m.links.get(id);
  if (!e) return;
  if (dropRenamed(m, id)) return;
  if (isNeeded(m, id)) {
    if (e.idleTimer) m.clearTimer(e.idleTimer);
    e.idleTimer = null;
    e.link.need();
    return;
  }
  if (!e.link.connected || e.idleTimer) return;
  e.idleTimer = m.setTimer(() => {
    e.idleTimer = null;
    if (m.links.get(id) === e && !isNeeded(m, id)) e.link.idle();
  }, IDLE_GRACE_MS);
}

/** @param {Manager} m @param {string} id @param {Host} host @param {string} token @returns {Entry} */
function makeLink(m, id, host, token) {
  /** @type {Entry} */
  const e = { link: /** @type {any} */ (null), name: host.name, token, idleTimer: null, sent: null, session: null };
  e.link = createHostLink({
    host: {
      name: host.name,
      // Read as each session opens, so its hello carries the host’s settings then.
      get settings() {
        const settings = (m.getHost(id) ?? host).settings;
        e.sent = settings.signInCheck ?? null;
        return settings;
      },
    },
    version: m.version,
    token,
    needed: () => !m.closed && m.links.get(id) === e && isNeeded(m, id),
    ...(m.spawn ? { spawn: m.spawn } : {}),
    setTimer: m.setTimer,
    clearTimer: m.clearTimer,
    ...(m.delay ? { delay: m.delay } : {}),
  });
  follow(m, id, e);
  m.links.set(id, e);
  return e;
}

/** Keeps the host’s status and need up to date with its link. @param {Manager} m @param {string} id @param {Entry} e */
function follow(m, id, e) {
  const l = e.link;
  const heardNow = () => {
    m.heard.set(id, m.now());
    update(m, id);
  };
  l.on('message', heardNow);
  l.on('connected', () => {
    e.session = e.sent;
    heardNow();
    reconsider(m, id);
  });
  // 'open' is followed at once by 'connected', which says it with the new welcome, and each 'failure' by the
  // 'state' it leads to, so neither is a status of its own.
  l.on('state', (/** @type {string} */ s) => s !== 'open' && update(m, id));
  l.on('error', () => update(m, id));
  // A turn’s child starts or stops listening: it may need the host, or have been the last that did.
  l.on('newListener', (ev) => ev === 'message' && queueMicrotask(() => reconsider(m, id)));
  l.on('removeListener', (ev) => ev === 'message' && queueMicrotask(() => reconsider(m, id)));
}

/** Closes a host’s link and forgets it; the next link() makes another. @param {Manager} m @param {string} id */
export function dropLink(m, id) {
  const e = m.links.get(id);
  if (!e) return;
  m.links.delete(id);
  if (e.idleTimer) m.clearTimer(e.idleTimer);
  e.link.close();
}

/**
 * Whether the host was renamed since its link was made, so the link dials the old destination.
 * @param {Manager} m @param {string} id
 */
export function isRenamed(m, id) {
  const e = m.links.get(id);
  const h = m.getHost(id);
  return Boolean(e && h && e.name !== h.name);
}

/** Closes a renamed host’s old link if nothing needs it. Returns whether it did. @param {Manager} m @param {string} id */
export function dropRenamed(m, id) {
  if (!isRenamed(m, id) || isNeeded(m, id)) return false;
  dropLink(m, id);
  update(m, id);
  return true;
}

/** @param {Manager} m @param {string} id @returns {HostLink} */
export function linkOf(m, id) {
  if (m.closed) throw Object.assign(new Error('Postbox has closed its host connections.'), { code: 'closed' });
  const host = hostOf(m, id);
  dropRenamed(m, id);
  const e = m.links.get(id);
  if (e && e.name !== host.name) {
    // Something still needs the old destination (a turn running there): nothing new starts on that machine.
    throw Object.assign(new Error(`This host was renamed ${host.name}, but Postbox is still using ${e.name} for it. Try again once its turns there end.`), {
      code: 'host-renamed-busy',
    });
  }
  if (e) return e.link;
  const token = tokenOf(m, id);
  if (!token) {
    const f = sshFailure('not-installed', host.name, { why: 'This Postbox has no token for it, so it hasn’t installed it there.' });
    throw Object.assign(f, { code: 'not-installed' });
  }
  const made = makeLink(m, id, host, token).link;
  update(m, id);
  return made;
}

/** Until the link has no session, if it has one. @param {HostLink} l */
export const disconnected = (l) =>
  new Promise((resolve) => {
    if (!l.connected) return resolve(undefined);
    const on = () => {
      if (l.connected) return;
      l.off('state', on);
      resolve(undefined);
    };
    l.on('state', on);
  });

/** Counts one more need for that reason, and nothing else. @param {Manager} m @param {string} id @param {unknown} why */
function count(m, id, why) {
  const r = m.reasons.get(id) ?? new Map();
  r.set(why, (r.get(why) ?? 0) + 1);
  m.reasons.set(id, r);
}

/** @param {Manager} m @param {string} id @param {unknown} why */
export function need(m, id, why) {
  count(m, id, why);
  try {
    linkOf(m, id);
  } catch (e) {
    // A host not installed, or gone, is needed all the same; it connects once it can. One renamed while its old
    // link is needed keeps that link connected for what runs there; link() refuses anything new.
    if (e.code !== 'not-installed' && e.code !== 'no-host' && e.code !== 'host-renamed-busy') throw e;
  }
  reconsider(m, id);
}

/** @param {Manager} m @param {string} id @param {unknown} why */
export function release(m, id, why) {
  const r = m.reasons.get(id);
  const n = r?.get(why);
  if (!r || !n) return;
  if (n > 1) r.set(why, n - 1);
  else r.delete(why);
  if (!r.size) m.reasons.delete(id);
  reconsider(m, id);
}

/** @param {Manager} m @param {string} id @returns {Promise<any>} */
export async function ensureWelcome(m, id) {
  const l = linkOf(m, id);
  if (l.connected) return l.welcome;
  if (l.state === 'stopped') throw l.failure;
  const why = Symbol('welcome');
  need(m, id, why);
  try {
    const welcome = nextWelcome(l);
    if (l.state === 'waiting') l.wake();
    else l.need();
    return await welcome;
  } finally {
    release(m, id, why);
  }
}

/**
 * The person asked to connect (Install, Retry, Reconnect): the host connects now, whatever stopped it and though
 * nothing needs it, for one welcome at least, so its card shows what the daemon found there; then it idles after the
 * grace period, as any host nothing needs. takeover: that session replaces the other Postbox connected to it (busy).
 * Rejects as link() throws, or with the attempt’s SshFailure; a sign-in or a host key stops it again, until the
 * person asks again.
 * @param {Manager} m @param {string} id @param {{ takeover?: boolean }} [o] @returns {Promise<any>}
 */
export async function connectNow(m, id, { takeover = false } = {}) {
  const l = linkOf(m, id);
  if (l.connected) return l.welcome;
  const why = Symbol('asked');
  // Needed for this attempt, so the link’s retry() goes ahead; counted, not need()ed, so the attempt that opens is
  // retry()’s, with its takeover.
  count(m, id, why);
  try {
    const welcome = nextWelcome(l);
    l.retry({ takeover });
    return await welcome;
  } finally {
    release(m, id, why);
  }
}

/** The link’s next welcome, or the failure of its next attempt. @param {HostLink} l @returns {Promise<any>} */
const nextWelcome = (l) =>
  new Promise((resolve, reject) => {
    const off = () => {
      l.off('connected', onConnected);
      l.off('failure', onFailure);
      l.off('error', onFailure);
    };
    const onConnected = (/** @type {any} */ w) => {
      off();
      resolve(w);
    };
    const onFailure = (/** @type {any} */ f) => {
      off();
      reject(f);
    };
    l.on('connected', onConnected);
    l.on('failure', onFailure);
    l.on('error', onFailure);
  });
