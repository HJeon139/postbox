// What the host manager knows about each host (hosts.mjs, whose header is the design): the host itself, its token on
// this laptop, and its status, emitted as 'status' when it changes. Also the manager’s state, which every part of the
// manager takes first, as `m`.

import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_RE, tokenFile } from './install.mjs';
import { INSTANCE_FILE } from './install-token.mjs';

/** How often a change to lastHeard alone is emitted as 'status', at most. */
export const HEARD_EVERY_MS = 10_000;

/**
 * @typedef {ReturnType<typeof import('./link.mjs').createHostLink>} HostLink
 * @typedef {import('../../shared/remote-settings.mjs').Host} Host
 * @typedef {import('./ssh.mjs').SshFailure} SshFailure
 * @typedef {'connected' | 'reconnecting' | 'disconnected' | 'failed' | 'not-installed'} HostState
 * @typedef {{ state: HostState, failure: SshFailure | null, welcome: any, lastHeard: number | null }} HostStatus
 * @typedef {{ ok: boolean, code: number | null, at: number }} SignInCheck
 * @typedef {{ link: HostLink, name: string, token: string, idleTimer: any, sent: string[] | null, session: string[] | null }} Entry
 *   sent: the signInCheck the last session opened sent in hello; session: the one the current session sent.
 */

/**
 * The manager’s state: createHostManager’s options, and what lives as long as the process.
 * @typedef {{ getHost: (id: string) => Host | null, hostIds: () => string[], dataDir: string, version: string,
 *   spawn?: import('./ssh.mjs').SpawnLike, now: () => number, setTimer: (fn: () => void, ms: number) => any,
 *   clearTimer: (t: any) => void, delay?: (attempt: number) => number, events: import('node:events').EventEmitter,
 *   links: Map<string, Entry>, reasons: Map<string, Map<unknown, number>>, tokens: Map<string, string | null>,
 *   heard: Map<string, number>, emitted: Map<string, { status: HostStatus, at: number }>, heardTimers: Map<string, any>,
 *   checks: Map<string, Promise<SignInCheck | null>>, removals: Map<string, Promise<void>>, closed: boolean,
 *   instance?: string | null }} Manager
 *   reasons: per host, each reason it’s needed and how many times. tokens: tokens read from dataDir. emitted: the last
 *   'status' emitted, per host. heardTimers: a 'status' held back for lastHeard alone. checks and removals: the sign-in
 *   check and the removal under way, per host.
 */

/** @param {Manager} m @param {string} id @returns {Host} */
export function hostOf(m, id) {
  const h = m.getHost(id);
  if (!h) throw Object.assign(new Error('That host doesn’t exist. It may have been removed.'), { code: 'no-host' });
  return h;
}

/**
 * The host’s token on this laptop, or null; read as install.mjs’s readToken reads it. A token is kept once read; none
 * isn’t, so one that appears in the data folder later is found (a forget under way says null itself).
 * @param {Manager} m @param {string} id
 */
export function tokenOf(m, id) {
  if (m.tokens.has(id)) return m.tokens.get(id) ?? null;
  /** @type {string | null} */
  let token = null;
  try {
    const file = tokenFile(m.dataDir, id);
    if (lstatSync(file).isFile()) {
      const t = readFileSync(file, 'utf8').trim();
      token = TOKEN_RE.test(t) ? t : null;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (token) m.tokens.set(id, token);
  return token;
}

/**
 * This Postbox’s name for its hosts’ daemons, kept in its data folder (0600) so that it’s the same after a restart. A
 * daemon still holding a connection of this Postbox’s, one whose ssh died without the host noticing yet (through a
 * ProxyCommand, say), lets this Postbox’s next hello replace it instead of saying busy (daemon-hello.mjs). Made on
 * first use; null without a data folder.
 * @param {Manager} m @returns {string | null}
 */
export function instanceOf(m) {
  if (m.instance !== undefined) return m.instance;
  m.instance = null;
  if (!m.dataDir) return null;
  const file = join(m.dataDir, INSTANCE_FILE);
  let id = readInstance(file);
  if (!id) {
    // None yet, or one that isn’t a name (a link, say): a new one, written beside it and renamed over it, so a link is
    // replaced itself, never followed.
    id = randomBytes(16).toString('hex');
    mkdirSync(m.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, `${id}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  m.instance = id;
  return id;
}

/** The name in a regular file, made 0600 if it wasn’t, or null. @param {string} file */
function readInstance(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return null;
    const t = readFileSync(file, 'utf8').trim();
    if (!TOKEN_RE.test(t)) return null;
    if ((st.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
    return t;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** @param {Manager} m @param {string} id @returns {HostStatus} */
export function statusOf(m, id) {
  const lastHeard = m.heard.get(id) ?? null;
  if (!m.getHost(id)) return { state: 'disconnected', failure: null, welcome: null, lastHeard };
  const e = m.links.get(id);
  if (!e) return { state: tokenOf(m, id) ? 'disconnected' : 'not-installed', failure: null, welcome: null, lastHeard };
  const l = e.link;
  const failure = l.failure ?? null;
  /** @type {HostState} */
  let state = 'disconnected';
  if (l.connected) state = 'connected';
  else if (failure?.kind === 'not-installed') state = 'not-installed';
  else if (l.state === 'stopped') state = 'failed';
  else if (l.state === 'connecting' || l.state === 'waiting') state = 'reconnecting';
  return { state, failure, welcome: l.welcome ?? null, lastHeard };
}

/** Emits 'status' if it changed; a change to lastHeard alone at most every HEARD_EVERY_MS. @param {Manager} m @param {string} id */
export function update(m, id) {
  if (m.closed) return;
  const s = statusOf(m, id);
  const prev = m.emitted.get(id);
  const same = prev && prev.status.state === s.state && prev.status.failure === s.failure && prev.status.welcome === s.welcome;
  if (same && prev.status.lastHeard === s.lastHeard) return;
  if (same) {
    if (m.heardTimers.has(id)) return;
    const wait = prev.at + HEARD_EVERY_MS - m.now();
    if (wait > 0) {
      m.heardTimers.set(
        id,
        m.setTimer(() => {
          m.heardTimers.delete(id);
          update(m, id);
        }, wait),
      );
      return;
    }
  }
  if (m.heardTimers.has(id)) m.clearTimer(m.heardTimers.get(id));
  m.heardTimers.delete(id);
  m.emitted.set(id, { status: s, at: m.now() });
  m.events.emit('status', id, s);
}
