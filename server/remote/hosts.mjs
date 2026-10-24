// The laptop’s host manager (#120): one link (link.mjs) per remote host, made on first use with the token install.mjs
// keeps for it, and what the runtime and the UI need to know about each host. The runtime owns the store; this module
// persists nothing, and keeps only what lives as long as the process: the links, why each host is needed, and when
// each was last heard from.
//
// - link(hostId): the host’s link, the connection server/remote/process.mjs (remoteSpawn) takes. One per host; a
//   host with no token on this laptop isn’t installed, which throws an SshFailure with code `not-installed`, saying
//   what to do next. A link’s destination is fixed, so a renamed host’s old link is closed as soon as nothing needs
//   it (at the next link(), release or refresh), and the next use makes one to the new destination. While something
//   still needs the old one (a turn running there), link() throws an Error with code `host-renamed-busy` rather than
//   start anything new on the old machine; the turn goes on over the old link. destinationOf(hostId) is the
//   destination the current link dials. Its settings are read at each new session, so a session after a change sends
//   the new ones in hello.
// - Needed: a host stays connected (reconnecting with backoff after a drop) while it has a reason, need(hostId, why),
//   such as a running turn or a waiting prompt, released with release(hostId, why), counted per reason, or while
//   anything other than this module listens for the link’s messages (a turn’s child, as link.mjs’s own default). Once
//   nothing needs it, its session closes after IDLE_GRACE_MS, so the daemon can exit at its idleTimeout (the
//   design’s “Files and cleanup”); the link stays, and the next send or need opens another session.
// - status(hostId) and 'status' (hostId, status): connected, reconnecting (connecting, or waiting to retry after a
//   drop), failed (a failure only the person can fix, such as a sign-in or a host key), not-installed (no token, or the
//   host’s program wasn’t found), or disconnected (idle). lastHeard is when the host’s daemon last sent anything;
//   a change to it alone is emitted at most every HEARD_EVERY_MS, since every line of a turn moves it.
// - wake(): the laptop woke. D2, decided by the person: Postbox reconnects on its own, even with nothing running, so
//   every configured host with a token (hostIds), and any with a link or a reason, is tried at once, its link made if
//   need be; not one stopped by a failure only the person can fix (FAILURE_KINDS’ retry: false, such as a sign-in or
//   a host key). One nothing needs gets a fresh welcome before it idles again.
// - signInCheck(hostId): runs the host’s signInCheck there, through the daemon (`check`, answered by `checked`), as an
//   argument list with no shell. null when the host has none (the default). Sign-in needed resumes on its own only
//   when it passes (D2); without one, the turn waits for the person.
// - refresh(hostId): the settings the daemon enforces changed, so a connected host gets a fresh hello with them.
// - removeFromHost(hostId): the design’s “Remove Postbox from host”, through the daemon (`remove`, answered by
//   `removed`): it stops every turn still running there and deletes ~/.postbox-remote. Only after `removed` may the
//   caller forget the token (forget); until then it’s the only way to reach the host and try again.

import { EventEmitter } from 'node:events';
import { lstatSync, readFileSync } from 'node:fs';
import { message, SIGN_IN_CHECK_MS } from '../../shared/remote-protocol.mjs';
import { REMOVE_WAIT_MS, STOP_GRACE_MS } from './host/daemon.mjs';
import { describeInstall, forgetToken, installHost, TOKEN_RE, tokenFile } from './install.mjs';
import { createHostLink } from './link.mjs';
import { SshFailure, failure as sshFailure } from './ssh.mjs';

/** How long a connected host that nothing needs keeps its session, so back-to-back turns share one. */
export const IDLE_GRACE_MS = 2 * 60 * 1000;
/** How often a change to lastHeard alone is emitted as 'status', at most. */
export const HEARD_EVERY_MS = 10_000;
/** How long Postbox waits for a sign-in check’s answer once it’s sent: the host’s own limit, plus the round trip. */
export const CHECK_WAIT_MS = SIGN_IN_CHECK_MS + 30_000;
/**
 * How long Postbox waits for `removed` once it sent `remove`: the daemon’s own wait for the turns it stops (Stop’s
 * grace period, then REMOVE_WAIT_MS), plus the round trip and the deleting.
 */
export const REMOVE_CONFIRM_MS = STOP_GRACE_MS + REMOVE_WAIT_MS + 30_000;

/**
 * @typedef {ReturnType<typeof createHostLink>} HostLink
 * @typedef {import('../../shared/remote-settings.mjs').Host} Host
 * @typedef {'connected' | 'reconnecting' | 'disconnected' | 'failed' | 'not-installed'} HostState
 * @typedef {{ state: HostState, failure: SshFailure | null, welcome: any, lastHeard: number | null }} HostStatus
 * @typedef {{ ok: boolean, code: number | null, at: number }} SignInCheck
 * @typedef {{ link: HostLink, name: string, token: string, idleTimer: any, sent: string[] | null, session: string[] | null }} Entry
 *   sent: the signInCheck the last session opened sent in hello; session: the one the current session sent.
 * @typedef {ReturnType<typeof createHostManager>} HostManager  what the runtime is given (tests pass a fake)
 */

/**
 * The host manager.
 * @param {{ getHost: (id: string) => Host | null, hostIds?: () => string[], dataDir: string, version: string,
 *           spawn?: import('./ssh.mjs').SpawnLike, now?: () => number,
 *           setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 *           delay?: (attempt: number) => number }} o
 *   getHost: the runtime’s host, or null for one that doesn’t exist. hostIds: every configured host’s id, for wake().
 *   dataDir: Postbox’s data folder, where install.mjs keeps the tokens. version: Postbox’s package version. spawn runs
 *   ssh, for the links and installs; the timers and delay (the reconnect backoff) are for tests.
 */
export function createHostManager({
  getHost,
  hostIds = () => [],
  dataDir,
  version,
  spawn,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer = (t) => clearTimeout(t),
  delay,
}) {
  const events = new EventEmitter();
  /** @type {Map<string, Entry>} */
  const links = new Map();
  /** @type {Map<string, Map<unknown, number>>} per host, each reason it’s needed and how many times */
  const reasons = new Map();
  /** @type {Map<string, string | null>} tokens read from dataDir */
  const tokens = new Map();
  /** @type {Map<string, number>} */
  const heard = new Map();
  /** @type {Map<string, { status: HostStatus, at: number }>} the last 'status' emitted, per host */
  const emitted = new Map();
  /** @type {Map<string, any>} a 'status' held back for lastHeard alone */
  const heardTimers = new Map();
  /** @type {Map<string, Promise<SignInCheck | null>>} the sign-in check under way, per host */
  const checks = new Map();
  /** @type {Map<string, Promise<void>>} the removal under way, per host */
  const removals = new Map();
  let closed = false;

  /** @param {string} id @returns {Host} */
  const hostOf = (id) => {
    const h = getHost(id);
    if (!h) throw Object.assign(new Error('That host doesn’t exist. It may have been removed.'), { code: 'no-host' });
    return h;
  };

  /** The host’s token on this laptop, or null; read as install.mjs’s readToken reads it. @param {string} id */
  const tokenOf = (id) => {
    if (tokens.has(id)) return tokens.get(id) ?? null;
    /** @type {string | null} */
    let token = null;
    try {
      const file = tokenFile(dataDir, id);
      if (lstatSync(file).isFile()) {
        const t = readFileSync(file, 'utf8').trim();
        token = TOKEN_RE.test(t) ? t : null;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    tokens.set(id, token);
    return token;
  };

  /** Whether the host is needed: a reason, or a listener for its messages other than this module’s. @param {string} id */
  const isNeeded = (id) => {
    if (reasons.get(id)?.size) return true;
    const e = links.get(id);
    return Boolean(e && e.link.listenerCount('message') > 1);
  };

  /**
   * Closes an idle host’s session after the grace period, or keeps a needed one connected. A renamed host’s old link
   * goes at once, once nothing needs it.
   * @param {string} id
   */
  const reconsider = (id) => {
    const e = links.get(id);
    if (!e) return;
    if (dropRenamed(id)) return;
    if (isNeeded(id)) {
      if (e.idleTimer) clearTimer(e.idleTimer);
      e.idleTimer = null;
      e.link.need();
      return;
    }
    if (!e.link.connected || e.idleTimer) return;
    e.idleTimer = setTimer(() => {
      e.idleTimer = null;
      if (links.get(id) === e && !isNeeded(id)) e.link.idle();
    }, IDLE_GRACE_MS);
  };

  /** @param {string} id @returns {HostStatus} */
  const statusOf = (id) => {
    const lastHeard = heard.get(id) ?? null;
    if (!getHost(id)) return { state: 'disconnected', failure: null, welcome: null, lastHeard };
    const e = links.get(id);
    if (!e) return { state: tokenOf(id) ? 'disconnected' : 'not-installed', failure: null, welcome: null, lastHeard };
    const l = e.link;
    const failure = l.failure ?? null;
    /** @type {HostState} */
    let state = 'disconnected';
    if (l.connected) state = 'connected';
    else if (failure?.kind === 'not-installed') state = 'not-installed';
    else if (l.state === 'stopped') state = 'failed';
    else if (l.state === 'connecting' || l.state === 'waiting') state = 'reconnecting';
    return { state, failure, welcome: l.welcome ?? null, lastHeard };
  };

  /** Emits 'status' if it changed; a change to lastHeard alone at most every HEARD_EVERY_MS. @param {string} id */
  const update = (id) => {
    if (closed) return;
    const s = statusOf(id);
    const prev = emitted.get(id);
    const same = prev && prev.status.state === s.state && prev.status.failure === s.failure && prev.status.welcome === s.welcome;
    if (same && prev.status.lastHeard === s.lastHeard) return;
    if (same) {
      if (heardTimers.has(id)) return;
      const wait = prev.at + HEARD_EVERY_MS - now();
      if (wait > 0) {
        heardTimers.set(
          id,
          setTimer(() => {
            heardTimers.delete(id);
            update(id);
          }, wait),
        );
        return;
      }
    }
    if (heardTimers.has(id)) clearTimer(heardTimers.get(id));
    heardTimers.delete(id);
    emitted.set(id, { status: s, at: now() });
    events.emit('status', id, s);
  };

  /** @param {string} id @param {Host} host @param {string} token @returns {Entry} */
  const makeLink = (id, host, token) => {
    /** @type {Entry} */
    const e = { link: /** @type {any} */ (null), name: host.name, token, idleTimer: null, sent: null, session: null };
    e.link = createHostLink({
      host: {
        name: host.name,
        // Read as each session opens, so its hello carries the host’s settings then.
        get settings() {
          const settings = (getHost(id) ?? host).settings;
          e.sent = settings.signInCheck ?? null;
          return settings;
        },
      },
      version,
      token,
      needed: () => !closed && links.get(id) === e && isNeeded(id),
      ...(spawn ? { spawn } : {}),
      setTimer,
      clearTimer,
      ...(delay ? { delay } : {}),
    });
    const l = e.link;
    const heardNow = () => {
      heard.set(id, now());
      update(id);
    };
    l.on('message', heardNow);
    l.on('connected', () => {
      e.session = e.sent;
      heardNow();
      reconsider(id);
    });
    // 'open' is followed at once by 'connected', which says it with the new welcome, and each 'failure' by the
    // 'state' it leads to, so neither is a status of its own.
    l.on('state', (/** @type {string} */ s) => s !== 'open' && update(id));
    l.on('error', () => update(id));
    // A turn’s child starts or stops listening: it may need the host, or have been the last that did.
    l.on('newListener', (ev) => ev === 'message' && queueMicrotask(() => reconsider(id)));
    l.on('removeListener', (ev) => ev === 'message' && queueMicrotask(() => reconsider(id)));
    links.set(id, e);
    return e;
  };

  /** Closes a host’s link and forgets it; the next link() makes another. @param {string} id */
  const dropLink = (id) => {
    const e = links.get(id);
    if (!e) return;
    links.delete(id);
    if (e.idleTimer) clearTimer(e.idleTimer);
    e.link.close();
  };

  /**
   * Whether the host was renamed since its link was made, so the link dials the old destination.
   * @param {string} id
   */
  const isRenamed = (id) => {
    const e = links.get(id);
    const h = getHost(id);
    return Boolean(e && h && e.name !== h.name);
  };

  /** Closes a renamed host’s old link if nothing needs it. Returns whether it did. @param {string} id */
  const dropRenamed = (id) => {
    if (!isRenamed(id) || isNeeded(id)) return false;
    dropLink(id);
    update(id);
    return true;
  };

  /** @param {string} id @returns {HostLink} */
  const linkOf = (id) => {
    if (closed) throw new Error('Postbox has closed its host connections.');
    const host = hostOf(id);
    dropRenamed(id);
    const e = links.get(id);
    if (e && e.name !== host.name) {
      // Something still needs the old destination (a turn running there): nothing new starts on that machine.
      throw Object.assign(new Error(`This host was renamed ${host.name}, but Postbox is still using ${e.name} for it. Try again once its turns there end.`), {
        code: 'host-renamed-busy',
      });
    }
    if (e) return e.link;
    const token = tokenOf(id);
    if (!token) {
      const f = sshFailure('not-installed', host.name, { why: 'This Postbox has no token for it, so it hasn’t installed it there.' });
      throw Object.assign(f, { code: 'not-installed' });
    }
    const made = makeLink(id, host, token).link;
    update(id);
    return made;
  };

  /** Until the link has no session, if it has one. @param {HostLink} l */
  const disconnected = (l) =>
    new Promise((resolve) => {
      if (!l.connected) return resolve(undefined);
      const on = () => {
        if (l.connected) return;
        l.off('state', on);
        resolve(undefined);
      };
      l.on('state', on);
    });

  /** @param {string} id @param {unknown} why */
  const need = (id, why) => {
    const r = reasons.get(id) ?? new Map();
    r.set(why, (r.get(why) ?? 0) + 1);
    reasons.set(id, r);
    try {
      linkOf(id);
    } catch (e) {
      // A host not installed, or gone, is needed all the same; it connects once it can. One renamed while its old
      // link is needed keeps that link connected for what runs there; link() refuses anything new.
      if (e.code !== 'not-installed' && e.code !== 'no-host' && e.code !== 'host-renamed-busy') throw e;
    }
    reconsider(id);
  };

  /** @param {string} id @param {unknown} why */
  const release = (id, why) => {
    const r = reasons.get(id);
    const n = r?.get(why);
    if (!r || !n) return;
    if (n > 1) r.set(why, n - 1);
    else r.delete(why);
    if (!r.size) reasons.delete(id);
    reconsider(id);
  };

  /** @param {string} id @returns {Promise<any>} */
  const ensureWelcome = async (id) => {
    const l = linkOf(id);
    if (l.connected) return l.welcome;
    if (l.state === 'stopped') throw l.failure;
    const why = Symbol('welcome');
    need(id, why);
    try {
      return await new Promise((resolve, reject) => {
        const off = () => {
          l.off('connected', onConnected);
          l.off('failure', onFailure);
          l.off('error', onFailure);
        };
        const onConnected = (w) => {
          off();
          resolve(w);
        };
        const onFailure = (f) => {
          off();
          reject(f);
        };
        l.on('connected', onConnected);
        l.on('failure', onFailure);
        l.on('error', onFailure);
        if (l.state === 'waiting') l.wake();
        else l.need();
      });
    } finally {
      release(id, why);
    }
  };

  /** @param {string} id @param {string[]} argv @returns {Promise<SignInCheck | null>} */
  const runCheck = async (id, argv) => {
    const why = Symbol('sign-in check');
    need(id, why);
    try {
      await ensureWelcome(id);
      const e = /** @type {Entry} */ (links.get(id));
      // The daemon runs the check this session’s hello sent; for another, a new session sends the host’s settings now.
      if (JSON.stringify(e.session) !== JSON.stringify(argv)) {
        e.link.idle();
        await disconnected(e.link);
        await ensureWelcome(id);
      }
      const l = /** @type {Entry} */ (links.get(id)).link;
      const name = hostOf(id).name;
      return await new Promise((resolve, reject) => {
        let timer = null;
        /** @param {(v: any) => void} fn @param {any} v */
        const done = (fn, v) => {
          if (timer) clearTimer(timer);
          l.off('message', onMessage);
          l.off('state', onState);
          fn(v);
        };
        const onMessage = (m) => {
          if (m.type === 'checked') done(resolve, { ok: m.ok, code: m.code, at: m.at });
          else if (m.type === 'error' && m.re === 'check') {
            // The session’s hello had no check after all (the settings changed as it opened): nothing ran.
            if (m.code === 'no-check') done(resolve, null);
            else done(reject, Object.assign(new Error(m.message), { code: m.code }));
          }
        };
        const lost = () => l.failure ?? sshFailure('failed', name, { why: 'The connection closed before the host answered the sign-in check.' });
        const onState = () => !l.connected && done(reject, lost());
        l.on('message', onMessage);
        l.on('state', onState);
        timer = setTimer(
          () =>
            done(reject, sshFailure('failed', name, { why: `The host didn’t answer the sign-in check within ${Math.round(CHECK_WAIT_MS / 1000)} seconds.` })),
          CHECK_WAIT_MS,
        );
        if (!l.send(message('postbox-to-daemon', 'check', {}))) done(reject, lost());
      });
    } finally {
      release(id, why);
    }
  };

  /** @param {string} id @returns {Promise<void>} */
  const runRemove = async (id) => {
    const why = Symbol('remove');
    need(id, why);
    try {
      const name = hostOf(id).name;
      const again = (/** @type {SshFailure} */ f) => new SshFailure(f.kind, f.message, `${f.next} Then remove it again.`, f.detail);
      try {
        await ensureWelcome(id);
      } catch (e) {
        // No token here (link()’s not-installed) is the caller’s to decide; a host that can’t be reached is a retry.
        throw e?.name === 'SshFailure' && e.code !== 'not-installed' ? again(e) : e;
      }
      const l = /** @type {Entry} */ (links.get(id)).link;
      await new Promise((resolve, reject) => {
        let timer = null;
        /** @param {(v: any) => void} fn @param {any} [v] */
        const done = (fn, v) => {
          if (timer) clearTimer(timer);
          l.off('message', onMessage);
          l.off('state', onState);
          fn(v);
        };
        const onMessage = (m) => {
          if (m.type === 'removed') done(resolve);
          // The daemon refused, deleting nothing: a home it won’t delete, or a removal already under way.
          else if (m.type === 'error' && m.re === 'remove')
            done(reject, new SshFailure('failed', `${name} didn’t remove Postbox: ${m.message}`, `Fix that on ${name}, then remove it again.`));
        };
        // The daemon says `removed` before it closes, so a close first is a lost connection, whatever it did there.
        const lost = () =>
          new SshFailure('failed', `The connection to ${name} closed before it confirmed that Postbox was removed.`, `Remove it again once ${name} is back.`);
        const onState = () => !l.connected && done(reject, lost());
        l.on('message', onMessage);
        l.on('state', onState);
        timer = setTimer(
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
    } finally {
      release(id, why);
    }
  };

  return Object.assign(events, {
    /**
     * The host’s link, made on first use. Throws an SshFailure with code `not-installed` when this laptop has no
     * token for it, and an Error with code `no-host` for a host that doesn’t exist.
     * @param {string} hostId @returns {HostLink}
     */
    link: linkOf,
    /**
     * The host’s latest welcome, connecting first if it isn’t connected. Rejects with the link’s SshFailure when the
     * attempt fails, or at once when a failure only the person can fix has stopped it.
     * @param {string} hostId @returns {Promise<any>}
     */
    ensureWelcome,
    /** @param {string} hostId @returns {HostStatus} */
    status: statusOf,
    /**
     * The destination the host’s current link dials, or null with no link: after a rename, the old name until that
     * link is dropped.
     * @param {string} hostId @returns {string | null}
     */
    destinationOf: (hostId) => links.get(hostId)?.name ?? null,
    /**
     * What an install does, for the confirm the UI shows first (install.mjs’s describeInstall).
     * @param {string} hostId
     */
    describeInstall: (hostId) => describeInstall(hostOf(hostId), { version, dataDir }),
    /**
     * Installs this Postbox on the host (install.mjs’s installHost), once the person has confirmed. Its link then
     * tries again; one made with another token is replaced.
     * @param {string} hostId @returns {ReturnType<typeof installHost>}
     */
    async install(hostId) {
      const host = hostOf(hostId);
      const r = await installHost({ host, version, dataDir, ...(spawn ? { spawn } : {}), setTimer, clearTimer });
      tokens.set(hostId, r.token);
      const e = links.get(hostId);
      if (e && e.token !== r.token) dropLink(hostId);
      else e?.link.retry();
      // A turn or a prompt that waited for the install connects now.
      if (isNeeded(hostId)) linkOf(hostId).need();
      update(hostId);
      return r;
    },
    /**
     * Closes the host’s link and forgets its token and reasons, as removing the host does. Resolves with whether
     * there was a token.
     * @param {string} hostId
     */
    async forget(hostId) {
      dropLink(hostId);
      reasons.delete(hostId);
      heard.delete(hostId);
      tokens.set(hostId, null);
      if (heardTimers.has(hostId)) clearTimer(heardTimers.get(hostId));
      heardTimers.delete(hostId);
      const had = await forgetToken({ dataDir, hostId });
      tokens.delete(hostId);
      update(hostId);
      emitted.delete(hostId);
      return had;
    },
    /**
     * The host’s settings that the daemon enforces changed (HOST_ENFORCED): a connected host gets a new session now,
     * whose hello sends them, and its turns carry on over it as after a drop. One that isn’t connected sends them at
     * its next session anyway. Resolves with whether it reconnected. Call it after a rename, too: a renamed host’s old
     * link closes now if nothing needs it.
     * @param {string} hostId @returns {Promise<boolean>}
     */
    async refresh(hostId) {
      // Renamed: the old link goes now if nothing needs it, or is left alone; neither gets a session to the old name.
      if (closed || dropRenamed(hostId) || isRenamed(hostId)) return false;
      const e = links.get(hostId);
      if (!e?.link.connected) return false;
      e.link.idle();
      await disconnected(e.link);
      if (closed || links.get(hostId) !== e) return false;
      await ensureWelcome(hostId);
      return true;
    },
    /**
     * The laptop woke (D2): every configured host with a token, and every host with a link or a reason, tries at once,
     * unless a failure only the person can fix stopped it.
     */
    wake() {
      if (closed) return;
      for (const id of new Set([...hostIds(), ...links.keys(), ...reasons.keys()])) {
        let l;
        try {
          // A host not used since Postbox started: only one installed here, as link() would find it.
          if (!links.has(id) && !tokenOf(id)) continue;
          l = linkOf(id);
        } catch (e) {
          // Renamed while needed: its old link reconnects for what runs there.
          if (e?.code !== 'host-renamed-busy') continue;
          l = /** @type {Entry} */ (links.get(id)).link;
        }
        if (l.state === 'stopped') continue;
        l.wake();
        // Nothing needs it: a fresh welcome all the same, and it idles again after the grace period.
        if (!l.connected) ensureWelcome(id).catch(() => {});
      }
    },
    /**
     * Keeps the host connected for a reason, such as a running turn or a waiting prompt; counted, so each need wants
     * its own release.
     * @param {string} hostId @param {unknown} why
     */
    need,
    /** Releases one need for that reason; with none left, the host’s session may idle. @param {string} hostId @param {unknown} why */
    release,
    /**
     * Runs the host’s signInCheck on the host. null when it has none; else whether it exited 0, its code (null when it
     * couldn’t start or was stopped) and when it ended there. Rejects when the host can’t be reached or doesn’t answer,
     * which a caller deciding whether to resume reads as not passed. One check per host at a time; callers share it.
     * @param {string} hostId @returns {Promise<SignInCheck | null>}
     */
    signInCheck(hostId) {
      let host;
      try {
        host = hostOf(hostId);
      } catch (e) {
        return Promise.reject(e);
      }
      const argv = host.settings?.signInCheck;
      if (!argv?.length) return Promise.resolve(null);
      const under = checks.get(hostId);
      if (under) return under;
      const p = runCheck(hostId, argv).finally(() => checks.delete(hostId));
      checks.set(hostId, p);
      return p;
    },
    /**
     * Removes Postbox from the host: connects if need be, sends the daemon `remove` (it stops every turn still running
     * there, deletes ~/.postbox-remote, its code, token, logs and turn records, and exits), and resolves once it says
     * `removed`. Rejects with an SshFailure (what happened, and the next step) when the host can’t be reached, the
     * daemon refuses, the connection closes first, or no `removed` comes within REMOVE_CONFIRM_MS; the token stays, so
     * the caller can try again. One this laptop has no token for rejects as link() does (code `not-installed`). One
     * removal per host at a time; callers share it.
     * @param {string} hostId @returns {Promise<void>}
     */
    removeFromHost(hostId) {
      try {
        hostOf(hostId);
      } catch (e) {
        return Promise.reject(e);
      }
      const under = removals.get(hostId);
      if (under) return under;
      const p = runRemove(hostId).finally(() => removals.delete(hostId));
      removals.set(hostId, p);
      return p;
    },
    /** Closes every link; turns go on on their hosts. */
    close() {
      if (closed) return;
      closed = true;
      for (const id of [...links.keys()]) dropLink(id);
      for (const t of heardTimers.values()) clearTimer(t);
      heardTimers.clear();
    },
  });
}
