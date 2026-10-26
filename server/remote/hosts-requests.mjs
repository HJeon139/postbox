// What the host manager asks a host’s daemon to do (hosts.mjs, whose header is the design): run the host’s sign-in
// check (`check`, answered by `checked`) and remove Postbox from the host (`remove`, answered by `removed`). One of
// each per host at a time, which callers share. Each function takes the manager’s state first.

import { message, SIGN_IN_CHECK_MS } from '../../shared/remote-protocol.mjs';
import { REMOVE_WAIT_MS, STOP_GRACE_MS } from './host/daemon.mjs';
import { disconnected, ensureWelcome, need, release } from './hosts-links.mjs';
import { hostOf } from './hosts-status.mjs';
import { SshFailure, failure as sshFailure } from './ssh.mjs';

/** How long Postbox waits for a sign-in check’s answer once it’s sent: the host’s own limit, plus the round trip. */
export const CHECK_WAIT_MS = SIGN_IN_CHECK_MS + 30_000;
/**
 * How long Postbox waits for `removed` once it sent `remove`: the daemon’s own wait for the turns it stops (Stop’s
 * grace period, then REMOVE_WAIT_MS), plus the round trip and the deleting.
 */
export const REMOVE_CONFIRM_MS = STOP_GRACE_MS + REMOVE_WAIT_MS + 30_000;

/**
 * @typedef {import('./hosts-status.mjs').Manager} Manager
 * @typedef {import('./hosts-status.mjs').Entry} Entry
 * @typedef {import('./hosts-status.mjs').HostLink} HostLink
 * @typedef {import('./hosts-status.mjs').SignInCheck} SignInCheck
 */

/** hosts.mjs’s signInCheck. @param {Manager} m @param {string} hostId @returns {Promise<SignInCheck | null>} */
export function signInCheck(m, hostId) {
  let host;
  try {
    host = hostOf(m, hostId);
  } catch (e) {
    return Promise.reject(e);
  }
  const argv = host.settings?.signInCheck;
  if (!argv?.length) return Promise.resolve(null);
  const under = m.checks.get(hostId);
  if (under) return under;
  const p = runCheck(m, hostId, argv).finally(() => m.checks.delete(hostId));
  m.checks.set(hostId, p);
  return p;
}

/** hosts.mjs’s removeFromHost. @param {Manager} m @param {string} hostId @returns {Promise<void>} */
export function removeFromHost(m, hostId) {
  try {
    hostOf(m, hostId);
  } catch (e) {
    return Promise.reject(e);
  }
  const under = m.removals.get(hostId);
  if (under) return under;
  const p = runRemove(m, hostId).finally(() => m.removals.delete(hostId));
  m.removals.set(hostId, p);
  return p;
}

/** @param {Manager} m @param {string} id @param {string[]} argv @returns {Promise<SignInCheck | null>} */
async function runCheck(m, id, argv) {
  const why = Symbol('sign-in check');
  need(m, id, why);
  try {
    await ensureWelcome(m, id);
    const e = /** @type {Entry} */ (m.links.get(id));
    // The daemon runs the check this session’s hello sent; for another, a new session sends the host’s settings now.
    if (JSON.stringify(e.session) !== JSON.stringify(argv)) {
      e.link.idle();
      await disconnected(e.link);
      await ensureWelcome(m, id);
    }
    const l = /** @type {Entry} */ (m.links.get(id)).link;
    return await checked(m, l, hostOf(m, id).name);
  } finally {
    release(m, id, why);
  }
}

/** Sends `check` and waits for its answer. @param {Manager} m @param {HostLink} l @param {string} name @returns {Promise<SignInCheck | null>} */
function checked(m, l, name) {
  return new Promise((resolve, reject) => {
    let timer = null;
    /** @param {(v: any) => void} fn @param {any} v */
    const done = (fn, v) => {
      if (timer) m.clearTimer(timer);
      l.off('message', onMessage);
      l.off('state', onState);
      fn(v);
    };
    const onMessage = (msg) => {
      if (msg.type === 'checked') done(resolve, { ok: msg.ok, code: msg.code, at: msg.at });
      else if (msg.type === 'error' && msg.re === 'check') {
        // The session’s hello had no check after all (the settings changed as it opened): nothing ran.
        if (msg.code === 'no-check') done(resolve, null);
        else done(reject, Object.assign(new Error(msg.message), { code: msg.code }));
      }
    };
    const lost = () => l.failure ?? sshFailure('failed', name, { why: 'The connection closed before the host answered the sign-in check.' });
    const onState = () => !l.connected && done(reject, lost());
    l.on('message', onMessage);
    l.on('state', onState);
    timer = m.setTimer(
      () => done(reject, sshFailure('failed', name, { why: `The host didn’t answer the sign-in check within ${Math.round(CHECK_WAIT_MS / 1000)} seconds.` })),
      CHECK_WAIT_MS,
    );
    if (!l.send(message('postbox-to-daemon', 'check', {}))) done(reject, lost());
  });
}

/** @param {Manager} m @param {string} id @returns {Promise<void>} */
async function runRemove(m, id) {
  const why = Symbol('remove');
  need(m, id, why);
  try {
    const name = hostOf(m, id).name;
    const again = (/** @type {SshFailure} */ f) => new SshFailure(f.kind, f.message, `${f.next} Then remove it again.`, f.detail);
    try {
      await ensureWelcome(m, id);
    } catch (e) {
      // No token here (link()’s not-installed) is the caller’s to decide; a host that can’t be reached is a retry.
      throw e?.name === 'SshFailure' && e.code !== 'not-installed' ? again(e) : e;
    }
    const l = /** @type {Entry} */ (m.links.get(id)).link;
    await removed(m, l, name);
  } finally {
    release(m, id, why);
  }
}

/** Sends `remove` and waits for `removed`. @param {Manager} m @param {HostLink} l @param {string} name @returns {Promise<void>} */
function removed(m, l, name) {
  return new Promise((resolve, reject) => {
    let timer = null;
    /** @param {(v: any) => void} fn @param {any} [v] */
    const done = (fn, v) => {
      if (timer) m.clearTimer(timer);
      l.off('message', onMessage);
      l.off('state', onState);
      fn(v);
    };
    const onMessage = (msg) => {
      if (msg.type === 'removed') done(resolve);
      // The daemon refused, deleting nothing: a home it won’t delete, or a removal already under way.
      else if (msg.type === 'error' && msg.re === 'remove')
        done(reject, new SshFailure('failed', `${name} didn’t remove Postbox: ${msg.message}`, `Fix that on ${name}, then remove it again.`));
    };
    // The daemon says `removed` before it closes, so a close first is a lost connection, whatever it did there.
    const lost = () =>
      new SshFailure('failed', `The connection to ${name} closed before it confirmed that Postbox was removed.`, `Remove it again once ${name} is back.`);
    const onState = () => !l.connected && done(reject, lost());
    l.on('message', onMessage);
    l.on('state', onState);
    timer = m.setTimer(
      () =>
        done(
          reject,
          new SshFailure(
            'failed',
            `${name} didn’t confirm within ${Math.round(REMOVE_CONFIRM_MS / 1000)} seconds that Postbox was removed.`,
            'Try again in a moment.',
          ),
        ),
      REMOVE_CONFIRM_MS,
    );
    if (!l.send(message('postbox-to-daemon', 'remove', {}))) done(reject, lost());
  });
}
