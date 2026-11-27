// Asking a host whether each harness there is signed in (#1608): `signins`, answered by `signed`
// (shared/remote-protocol.mjs), after each welcome, so the host’s card and a turn’s start can say a harness isn’t
// signed in before a turn fails there. The answer lands in the host’s status as signIns. A turn’s start asks again
// (askNow), so it warns from the session it runs over, not one before it, and a sign-in the person fixed since is
// heard (#1608). Each function takes the host manager’s state first (hosts-status.mjs).

import { message, refusesType } from '../../shared/remote-protocol.mjs';
import { SIGN_IN_STATUS_MS } from './host/daemon-signins.mjs';
import { need, release } from './hosts-links.mjs';
import { update } from './hosts-status.mjs';

/** How long Postbox waits for `signed` once `signins` is sent: the host’s own limit per command, plus the round trip. */
export const SIGNED_WAIT_MS = SIGN_IN_STATUS_MS + 30_000;

/**
 * @typedef {import('./hosts-status.mjs').Manager} Manager
 * @typedef {import('./hosts-status.mjs').HostLink} HostLink
 * @typedef {import('./hosts-status.mjs').SignIns} SignIns
 * @typedef {SignIns['harnesses']} Harnesses
 */

/**
 * Asks each host with a new welcome. A welcome is the session’s own object, so a new session asks again and a
 * status change within one session doesn’t. Out of the 'status' event, so its other listeners hear this one first.
 * @param {Manager} m
 */
export function watchSignIns(m) {
  m.events.on('status', (/** @type {string} */ id, /** @type {import('./hosts-status.mjs').HostStatus} */ s) => {
    if (s.state !== 'connected' || !s.welcome || m.signIns.get(id)?.welcome === s.welcome) return;
    m.signIns.set(id, { welcome: s.welcome, value: m.signIns.get(id)?.value ?? null });
    queueMicrotask(() => void askNow(m, id));
  });
}

/**
 * Asks the host now, over its session as it is, and resolves to that session’s answer: one already under way is
 * shared. null when the host isn’t connected, or the session ends first, so a caller warns of nothing.
 * @param {Manager} m @param {string} id @returns {Promise<SignIns | null>}
 */
export function askNow(m, id) {
  const l = m.links.get(id)?.link;
  if (m.closed || !l?.connected || !l.welcome) return Promise.resolve(null);
  const entry = m.signIns.get(id);
  if (entry && entry.welcome === l.welcome && entry.pending) return entry.pending;
  if (entry?.welcome !== l.welcome) m.signIns.set(id, { welcome: l.welcome, value: entry?.value ?? null });
  const now = /** @type {any} */ (m.signIns.get(id));
  now.pending = ask(m, id, l.welcome).finally(() => {
    if (m.signIns.get(id) === now) now.pending = null;
  });
  return now.pending;
}

/**
 * Sends `signins` over the session that welcomed, keeping the host connected while it waits, and keeps the answer,
 * which it resolves to. The last answer stands until a new one comes; a connection lost first leaves it, resolves to
 * null, and the next welcome asks again.
 * @param {Manager} m @param {string} id @param {any} welcome @returns {Promise<SignIns | null>}
 */
async function ask(m, id, welcome) {
  const l = m.links.get(id)?.link;
  // A session gone before the ask is asked at its next welcome: needing the host here would reconnect it for nothing.
  if (m.closed || !l?.connected || l.welcome !== welcome) return null;
  const found = (welcome.harnesses ?? []).filter((/** @type {any} */ h) => h.path).map((/** @type {any} */ h) => h.name);
  const why = Symbol('sign-ins');
  need(m, id, why);
  try {
    const harnesses = await signed(m, l, found);
    const entry = m.signIns.get(id);
    if (!harnesses || m.closed || !entry || entry.welcome !== welcome) return null;
    entry.value = { at: m.now(), harnesses };
    update(m, id);
    return entry.value;
  } finally {
    release(m, id, why);
  }
}

/**
 * Sends `signins` and waits for its answer: the harnesses `signed` names, or each one found as unknown when the
 * daemon refuses it (one from before `signins` refuses it as a message it doesn’t carry) or doesn’t answer in time.
 * null when the connection closes first, or the send fails.
 * @param {Manager} m @param {HostLink} l @param {string[]} found @returns {Promise<Harnesses | null>}
 */
function signed(m, l, found) {
  const unknown = () => found.map((name) => ({ name, state: /** @type {const} */ ('unknown') }));
  return new Promise((resolve) => {
    let timer = null;
    /** @param {Harnesses | null} v */
    const done = (v) => {
      if (timer) m.clearTimer(timer);
      l.off('message', onMessage);
      l.off('state', onState);
      resolve(v);
    };
    const onMessage = (/** @type {any} */ msg) => {
      if (msg.type === 'signed') done(msg.harnesses);
      else if (refusesType(msg, 'signins') || (msg.type === 'error' && msg.re === 'signins')) done(unknown());
    };
    const onState = () => !l.connected && done(null);
    l.on('message', onMessage);
    l.on('state', onState);
    timer = m.setTimer(() => done(unknown()), SIGNED_WAIT_MS);
    if (!l.send(message('postbox-to-daemon', 'signins', {}))) done(null);
  });
}
