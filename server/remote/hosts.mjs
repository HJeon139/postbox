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

//
// This module makes the manager and holds its methods; its parts are beside it, each taking the manager’s state first:
// hosts-status.mjs (the host, its token and its status), hosts-links.mjs (the links and why each host is needed) and
// hosts-requests.mjs (the sign-in check and Remove, through the daemon).

import { EventEmitter } from 'node:events';
import { disconnected, dropLink, dropRenamed, ensureWelcome, isNeeded, isRenamed, linkOf, need, release } from './hosts-links.mjs';
import { removeFromHost, signInCheck } from './hosts-requests.mjs';
import { hostOf, statusOf, tokenOf, update } from './hosts-status.mjs';
import { describeInstall, forgetToken, installHost } from './install.mjs';

export { IDLE_GRACE_MS } from './hosts-links.mjs';
export { CHECK_WAIT_MS, REMOVE_CONFIRM_MS } from './hosts-requests.mjs';
export { HEARD_EVERY_MS } from './hosts-status.mjs';

/**
 * @typedef {import('./hosts-status.mjs').HostLink} HostLink
 * @typedef {import('./hosts-status.mjs').Host} Host
 * @typedef {import('./hosts-status.mjs').HostState} HostState
 * @typedef {import('./hosts-status.mjs').HostStatus} HostStatus
 * @typedef {import('./hosts-status.mjs').SignInCheck} SignInCheck
 * @typedef {import('./hosts-status.mjs').Entry} Entry
 * @typedef {import('./hosts-status.mjs').Manager} Manager
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
  /** @type {Manager} */
  const m = {
    getHost,
    hostIds,
    dataDir,
    version,
    spawn,
    now,
    setTimer,
    clearTimer,
    delay,
    events: new EventEmitter(),
    links: new Map(),
    reasons: new Map(),
    tokens: new Map(),
    heard: new Map(),
    emitted: new Map(),
    heardTimers: new Map(),
    checks: new Map(),
    removals: new Map(),
    closed: false,
  };
  return Object.assign(m.events, linkMethods(m), hostMethods(m));
}

/** The methods about a host’s link. @param {Manager} m */
function linkMethods(m) {
  return {
    /**
     * The host’s link, made on first use. Throws an SshFailure with code `not-installed` when this laptop has no
     * token for it, and an Error with code `no-host` for a host that doesn’t exist.
     * @param {string} hostId @returns {HostLink}
     */
    link: (hostId) => linkOf(m, hostId),
    /**
     * The host’s latest welcome, connecting first if it isn’t connected. Rejects with the link’s SshFailure when the
     * attempt fails, or at once when a failure only the person can fix has stopped it.
     * @param {string} hostId @returns {Promise<any>}
     */
    ensureWelcome: (hostId) => ensureWelcome(m, hostId),
    /** @param {string} hostId @returns {HostStatus} */
    status: (hostId) => statusOf(m, hostId),
    /**
     * The destination the host’s current link dials, or null with no link: after a rename, the old name until that
     * link is dropped.
     * @param {string} hostId @returns {string | null}
     */
    destinationOf: (hostId) => m.links.get(hostId)?.name ?? null,
    /**
     * The laptop woke (D2): every configured host with a token, and every host with a link or a reason, tries at once,
     * unless a failure only the person can fix stopped it.
     */
    wake: () => wake(m),
    /**
     * Keeps the host connected for a reason, such as a running turn or a waiting prompt; counted, so each need wants
     * its own release.
     * @param {string} hostId @param {unknown} why
     */
    need: (hostId, why) => need(m, hostId, why),
    /** Releases one need for that reason; with none left, the host’s session may idle. @param {string} hostId @param {unknown} why */
    release: (hostId, why) => release(m, hostId, why),
    /** Closes every link; turns go on on their hosts. */
    close: () => close(m),
  };
}

/** The methods about installing, configuring and removing a host. @param {Manager} m */
function hostMethods(m) {
  return {
    /**
     * What an install does, for the confirm the UI shows first (install.mjs’s describeInstall).
     * @param {string} hostId
     */
    describeInstall: (hostId) => describeInstall(hostOf(m, hostId), { version: m.version, dataDir: m.dataDir }),
    /**
     * Installs this Postbox on the host (install.mjs’s installHost), once the person has confirmed. Its link then
     * tries again; one made with another token is replaced.
     * @param {string} hostId @returns {ReturnType<typeof installHost>}
     */
    install: (hostId) => install(m, hostId),
    /**
     * Closes the host’s link and forgets its token and reasons, as removing the host does. Resolves with whether
     * there was a token.
     * @param {string} hostId
     */
    forget: (hostId) => forget(m, hostId),
    /**
     * The host’s settings that the daemon enforces changed (HOST_ENFORCED): a connected host gets a new session now,
     * whose hello sends them, and its turns carry on over it as after a drop. One that isn’t connected sends them at
     * its next session anyway. Resolves with whether it reconnected. Call it after a rename, too: a renamed host’s old
     * link closes now if nothing needs it.
     * @param {string} hostId @returns {Promise<boolean>}
     */
    refresh: (hostId) => refresh(m, hostId),
    /**
     * Runs the host’s signInCheck on the host. null when it has none; else whether it exited 0, its code (null when it
     * couldn’t start or was stopped) and when it ended there. Rejects when the host can’t be reached or doesn’t answer,
     * which a caller deciding whether to resume reads as not passed. One check per host at a time; callers share it.
     * @param {string} hostId @returns {Promise<SignInCheck | null>}
     */
    signInCheck: (hostId) => signInCheck(m, hostId),
    /**
     * Removes Postbox from the host: connects if need be, sends the daemon `remove` (it stops every turn still running
     * there, deletes ~/.postbox-remote, its code, token, logs and turn records, and exits), and resolves once it says
     * `removed`. Rejects with an SshFailure (what happened, and the next step) when the host can’t be reached, the
     * daemon refuses, the connection closes first, or no `removed` comes within REMOVE_CONFIRM_MS; the token stays, so
     * the caller can try again. One this laptop has no token for rejects as link() does (code `not-installed`). One
     * removal per host at a time; callers share it.
     * @param {string} hostId @returns {Promise<void>}
     */
    removeFromHost: (hostId) => removeFromHost(m, hostId),
  };
}

/** @param {Manager} m @param {string} hostId */
async function install(m, hostId) {
  const host = hostOf(m, hostId);
  const r = await installHost({
    host,
    version: m.version,
    dataDir: m.dataDir,
    ...(m.spawn ? { spawn: m.spawn } : {}),
    setTimer: m.setTimer,
    clearTimer: m.clearTimer,
  });
  m.tokens.set(hostId, r.token);
  const e = m.links.get(hostId);
  if (e && e.token !== r.token) dropLink(m, hostId);
  else e?.link.retry();
  // A turn or a prompt that waited for the install connects now.
  if (isNeeded(m, hostId)) linkOf(m, hostId).need();
  update(m, hostId);
  return r;
}

/** @param {Manager} m @param {string} hostId */
async function forget(m, hostId) {
  dropLink(m, hostId);
  m.reasons.delete(hostId);
  m.heard.delete(hostId);
  m.tokens.set(hostId, null);
  if (m.heardTimers.has(hostId)) m.clearTimer(m.heardTimers.get(hostId));
  m.heardTimers.delete(hostId);
  const had = await forgetToken({ dataDir: m.dataDir, hostId });
  m.tokens.delete(hostId);
  update(m, hostId);
  m.emitted.delete(hostId);
  return had;
}

/** @param {Manager} m @param {string} hostId @returns {Promise<boolean>} */
async function refresh(m, hostId) {
  // Renamed: the old link goes now if nothing needs it, or is left alone; neither gets a session to the old name.
  if (m.closed || dropRenamed(m, hostId) || isRenamed(m, hostId)) return false;
  const e = m.links.get(hostId);
  if (!e?.link.connected) return false;
  e.link.idle();
  await disconnected(e.link);
  if (m.closed || m.links.get(hostId) !== e) return false;
  await ensureWelcome(m, hostId);
  return true;
}

/** @param {Manager} m */
function wake(m) {
  if (m.closed) return;
  for (const id of new Set([...m.hostIds(), ...m.links.keys(), ...m.reasons.keys()])) {
    let l;
    try {
      // A host not used since Postbox started: only one installed here, as link() would find it.
      if (!m.links.has(id) && !tokenOf(m, id)) continue;
      l = linkOf(m, id);
    } catch (e) {
      // Renamed while needed: its old link reconnects for what runs there.
      if (e?.code !== 'host-renamed-busy') continue;
      l = /** @type {Entry} */ (m.links.get(id)).link;
    }
    if (l.state === 'stopped') continue;
    l.wake();
    // Nothing needs it: a fresh welcome all the same, and it idles again after the grace period.
    if (!l.connected) ensureWelcome(m, id).catch(() => {});
  }
}

/** @param {Manager} m */
function close(m) {
  if (m.closed) return;
  m.closed = true;
  for (const id of [...m.links.keys()]) dropLink(m, id);
  for (const t of m.heardTimers.values()) m.clearTimer(t);
  m.heardTimers.clear();
}
